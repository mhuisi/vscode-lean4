import { Disposable, OutputChannel, workspace, TextDocument, commands, window, EventEmitter, Uri, TextEditor } from 'vscode';
import { LeanInstaller, LeanVersion } from './leanInstaller'
import { LeanClient } from '../leanclient'
import { LeanFileProgressProcessingInfo, ServerStoppedReason } from '@leanprover/infoview-api';
import { checkParentFoldersForLeanProject, findLeanPackageRoot, isValidLeanProject } from './projectInfo';
import { isFileInFolder } from './fsHelper';
import { logger } from './logger'
import { addDefaultElanPath, getDefaultElanPath, addToolchainBinPath, isElanDisabled, shouldShowInvalidProjectWarnings } from '../config'
import { displayErrorWithOutput } from './errors';

// This class ensures we have one LeanClient per folder.
export class LeanClientProvider implements Disposable {
    private subscriptions: Disposable[] = [];
    private outputChannel: OutputChannel;
    private installer : LeanInstaller;
    private versions: Map<string, LeanVersion> = new Map();
    private clients: Map<string, LeanClient> = new Map();
    private pending: Map<string, boolean> = new Map();
    private pendingInstallChanged: Uri[] = [];
    private processingInstallChanged: boolean = false;
    private activeClient: LeanClient | undefined = undefined;

    private progressChangedEmitter = new EventEmitter<[string, LeanFileProgressProcessingInfo[]]>()
    progressChanged = this.progressChangedEmitter.event

    private clientAddedEmitter = new EventEmitter<LeanClient>()
    clientAdded = this.clientAddedEmitter.event

    private clientRemovedEmitter = new EventEmitter<LeanClient>()
    clientRemoved = this.clientRemovedEmitter.event

    private clientStoppedEmitter = new EventEmitter<[LeanClient, boolean, ServerStoppedReason]>()
    clientStopped = this.clientStoppedEmitter.event

    constructor(installer: LeanInstaller, outputChannel: OutputChannel) {
        this.outputChannel = outputChannel;
        this.installer = installer;

        // we must setup the installChanged event handler first before any didOpenEditor calls.
        installer.installChanged(async (uri: Uri) => await this.onInstallChanged(uri));

        window.visibleTextEditors.forEach(e => this.didOpenEditor(e.document));
        this.subscriptions.push(window.onDidChangeActiveTextEditor(async e => {
            if (!e) {
                return
            }
            await this.didOpenEditor(e.document);
        }))

        this.subscriptions.push(
            commands.registerCommand('lean4.restartFile', () => this.restartFile()),
            commands.registerCommand('lean4.refreshFileDependencies', () => this.restartFile()),
            commands.registerCommand('lean4.restartServer', () => this.restartActiveClient()),
            commands.registerCommand('lean4.stopServer', () => this.stopActiveClient())
        );

        workspace.onDidOpenTextDocument(document => this.didOpenEditor(document));

        workspace.onDidChangeWorkspaceFolders((event) => {
            // Remove all clients that are not referenced by any folder anymore
            if (!event.removed) {
                return
            }
            this.clients.forEach((client, key) => {
                if (workspace.getWorkspaceFolder(client.folderUri)) {
                    return
                }

                logger.log(`[ClientProvider] onDidChangeWorkspaceFolders removing client for ${key}`);
                this.clients.delete(key);
                this.versions.delete(key);
                client.dispose();
                this.clientRemovedEmitter.fire(client);
            })
        });
    }

    getActiveClient() : LeanClient | undefined {
        return this.activeClient;
    }

    private async onInstallChanged(uri: Uri){
        // Uri is a package Uri in the case a lean package file was changed.
        logger.log(`[ClientProvider] installChanged for ${uri}`);
        this.pendingInstallChanged.push(uri);
        if (this.processingInstallChanged){
            // avoid re-entrancy.
            return;
        }
        this.processingInstallChanged = true;

        while (this.pendingInstallChanged.length > 0)
        {
            try {
                const uri = this.pendingInstallChanged.pop();
                if (uri) {
                    // have to check again here in case elan install had --default-toolchain none.
                    const [folder, _] = await findLeanPackageRoot(uri);
                    const packageUri = folder ?? Uri.from({scheme: 'untitled'});
                    logger.log('[ClientProvider] testLeanVersion');
                    const version = await this.installer.testLeanVersion(packageUri);
                    if (version.version === '4') {
                        logger.log('[ClientProvider] got lean version 4');
                        const [cached, client] = await this.ensureClient(uri, version);
                        if (cached && client) {
                            await client.restart();
                            logger.log('[ClientProvider] restart complete');
                        }
                    } else if (version.error) {
                        logger.log(`[ClientProvider] Lean version not ok: ${version.error}`);
                    }
                }
            } catch (e) {
                logger.log(`[ClientProvider] Exception checking lean version: ${e}`);
            }
        }
        this.processingInstallChanged = false;
    }

    private async autoInstall() : Promise<void> {
        // no prompt, just do it!
        await this.installer.installElan();
        if (isElanDisabled()) {
            addToolchainBinPath(getDefaultElanPath());
        } else {
            addDefaultElanPath();
        }

        for (const [_, client] of this.clients) {
            await this.onInstallChanged(client.folderUri)
        }
    }

    private getVisibleEditor(uri: Uri) : TextEditor | null {
        const path = uri.toString();
        for (const editor of window.visibleTextEditors) {
            if (editor.document.uri.toString() === path){
                return editor;
            }
        }
        return null;
    }

    private restartFile() {
        if (!this.activeClient || !this.activeClient.isRunning()) {
            void window.showErrorMessage('No active client.')
            return
        }

        if (!window.activeTextEditor || window.activeTextEditor.document.languageId !== 'lean4') {
            void window.showErrorMessage('No active Lean editor tab. Make sure to focus the Lean editor tab for which you want to issue a restart.')
            return
        }

        void this.activeClient.restartFile(window.activeTextEditor.document);
    }

    private stopActiveClient() {
        if (this.activeClient && this.activeClient.isStarted()) {
            void this.activeClient?.stop();
        }
    }

    private async restartActiveClient() {
        void this.activeClient?.restart();
    }

    clientIsStarted() {
        void this.activeClient?.isStarted();
    }

    async didOpenEditor(document: TextDocument) {
        // bail as quickly as possible on non-lean files.
        if (document.languageId !== 'lean4') {
            return;
        }

        if (!this.getVisibleEditor(document.uri)) {
            // Sometimes VS code opens a document that has no editor yet.
            // For example, this happens when the vs code opens files to get git
            // information using a "git:" Uri scheme:
            //  git:/d%3A/Temp/lean_examples/Foo/Foo/Hello.lean.git?%7B%22path%22%3A%22d%3A%5C%5CTemp%5C%5Clean_examples%5C%5CFoo%5C%5CFoo%5C%5CHello.lean%22%2C%22ref%22%3A%22%22%7D
            return;
        }

        try {
            const [cached, client] = await this.ensureClient(document.uri, undefined);
            if (!client) {
                return
            }

            await client.openLean4Document(document)

            await this.checkIsValidProjectFolder(client.folderUri)

        } catch (e) {
            logger.log(`[ClientProvider] ### Error opening document: ${e}`);
        }
    }

    // Find the client for a given document.
    findClient(path: string) {
        const candidates = this.getClients().filter(client => isFileInFolder(path, client.getClientFolder()))
        // All candidate folders are a prefix of `path`, so they must necessarily be prefixes of one another
        // => the best candidate (the most top-level client folder) is just the one with the shortest path
        let bestCandidate: LeanClient | null = null
        for (const candidate of candidates) {
            if (!bestCandidate || candidate.getClientFolder().length < bestCandidate.getClientFolder().length) {
                bestCandidate = candidate
            }
        }
        return bestCandidate
    }

    getClients() : LeanClient[]{
        return Array.from(this.clients.values());
    }

    // Return a string that can be used as a key in the clients, versions, pendingInstallChanged, and pending
    // maps.  This is not just uri.toString() because on some platforms the file system is
    // case insensitive.
    getKeyFromUri(uri: Uri | null) : string{
        const uriNonNull = uri ?? Uri.from({scheme: 'untitled'});
        const path = uriNonNull.toString();
        if (uriNonNull.scheme === 'file' && process.platform === 'win32') {
            return path.toLowerCase();
        }
        return path;
    }

    getClientForFolder(folder: Uri) : LeanClient | undefined {
        return this.clients.get(this.getKeyFromUri(folder));
    }

    private async getLeanVersion(uri: Uri) : Promise<LeanVersion | undefined> {
        const [folder, _] = await findLeanPackageRoot(uri);
        const folderUri = folder ?? Uri.from({scheme: 'untitled'});
        const key = this.getKeyFromUri(folderUri);
        if (this.versions.has(key)){
            return this.versions.get(key);
        }
        let versionInfo : LeanVersion | undefined = await this.installer.testLeanVersion(folderUri);
        if (!versionInfo.error){
            this.versions.set(key, versionInfo);
        } else if (versionInfo.error === 'no elan installed' || versionInfo.error === 'lean not found') {
            if (!this.installer.getPromptUser()){
                await this.autoInstall();
                versionInfo = await this.installer.testLeanVersion(folderUri);
                if (!versionInfo.error){
                    this.versions.set(key, versionInfo);
                }
            } else {
                // Ah, then we need to prompt the user, this waits for answer,
                // but does not wait for the install to complete.
                await this.installer.showInstallOptions(uri);
            }
        } else {
            void displayErrorWithOutput('Cannot determine Lean version: ' + versionInfo.error)
        }
        return versionInfo;
    }

    // Starts a LeanClient if the given file is in a new workspace we haven't seen before.
    // Returns a boolean "true" if the LeanClient was already created.
    // Returns a null client if it turns out the new workspace is a lean3 workspace.
    async ensureClient(uri : Uri, versionInfo: LeanVersion | undefined) : Promise<[boolean,LeanClient | undefined]> {
        const [folder, _] = await findLeanPackageRoot(uri);
        const folderUri = folder ?? Uri.from({scheme: 'untitled'});
        let client = this.getClientForFolder(folderUri);
        const key = this.getKeyFromUri(folder);
        const cachedClient = (client !== undefined);
        if (!client) {
            if (this.pending.has(key)) {
                logger.log('[ClientProvider] ignoring ensureClient already pending on ' + folderUri.toString());
                return [cachedClient, client];
            }

            this.pending.set(key, true);
            if (!versionInfo) {
                // this can go all the way to installing elan (in the test scenario)
                // so it has to be done BEFORE we attempt to create any LeanClient.
                versionInfo = await this.getLeanVersion(folderUri);
            }

            logger.log('[ClientProvider] Creating LeanClient for ' + folderUri.toString());
            const elanDefaultToolchain = await this.installer.getElanDefaultToolchain(folderUri);

            // We must create a Client before doing the long running testLeanVersion
            // so that ensureClient callers have an "optimistic" client to work with.
            // This is needed in our constructor where it is calling ensureClient for
            // every open file.  A workspace could have multiple files open and we want
            // to remember all those open files are associated with this client before
            // testLeanVersion has completed.
            client = new LeanClient(folderUri, this.outputChannel, elanDefaultToolchain);
            this.subscriptions.push(client);
            this.clients.set(key, client);

            if (versionInfo && versionInfo.version && versionInfo.version !== '4') {
                // ignore workspaces that belong to a different version of Lean.
                logger.log(`[ClientProvider] Lean4 extension ignoring workspace '${folderUri}' because it is not a Lean 4 workspace.`);
                this.pending.delete(key);
                this.clients.delete(key);
                client.dispose();
                return [false, undefined];
            }

            client.serverFailed((err) => {
                // forget this client!
                logger.log(`[ClientProvider] serverFailed, removing client for ${key}`);
                const cached = this.clients.get(key);
                this.clients.delete(key);
                cached?.dispose();
                void window.showErrorMessage(err);
            });

            client.stopped(reason => {
                if (client) {
                    // fires a message in case a client is stopped unexpectedly
                    this.clientStoppedEmitter.fire([client, client === this.activeClient, reason]);
                }
            });

            // aggregate progress changed events.
            client.progressChanged(arg => {
                this.progressChangedEmitter.fire(arg);
            });

            this.pending.delete(key);
            logger.log('[ClientProvider] firing clientAddedEmitter event');
            this.clientAddedEmitter.fire(client);

            if (versionInfo) {
                if (!versionInfo.error) {
                    // we are ready to start, otherwise some sort of install might be happening
                    // as a result of UI options shown by testLeanVersion.
                    await client.start();
                } else {
                    logger.log(`[ClientProvider] skipping client.start because of versionInfo error: ${versionInfo?.error}`);
                }
            }
        }

        // tell the InfoView about this activated client.
        this.activeClient = client;

        return [cachedClient, client];
    }

    private async checkIsValidProjectFolder(folderUri: Uri) {
        if (!shouldShowInvalidProjectWarnings()) {
            return
        }

        if (folderUri.scheme !== 'file') {
            void window.showWarningMessage('Lean 4 server operating in restricted single file mode. Please open a valid Lean 4 project containing a \'lean-toolchain\' file for full functionality.')
            return
        }

        if (await isValidLeanProject(folderUri)) {
            return
        }

        const parentProjectFolder: Uri | undefined = await checkParentFoldersForLeanProject(folderUri)
        if (parentProjectFolder === undefined) {
            void window.showWarningMessage('Opened folder is not a valid Lean 4 project. Please open a valid Lean 4 project containing a \'lean-toolchain\' file for full functionality.')
            return
        }

        const message = `Opened folder is not a valid Lean 4 project folder because it does not contain a 'lean-toolchain' file.
However, a valid Lean 4 project folder was found in one of the parent directories at '${parentProjectFolder.fsPath}'.
Open this project instead?`
        const input = 'Open parent directory project'
        const choice: string | undefined = await window.showWarningMessage(message, input)
        if (choice === input) {
            // this kills the extension host
            await commands.executeCommand('vscode.openFolder', parentProjectFolder)
        }
    }

    dispose(): void {
        for (const s of this.subscriptions) { s.dispose(); }
    }
}
