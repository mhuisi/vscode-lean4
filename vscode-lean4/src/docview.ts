/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import axios from 'axios';
import cheerio = require('cheerio');
import { URL } from 'url';
import { commands, Disposable, Uri, ViewColumn, WebviewPanel, window,
     workspace, WebviewOptions, WebviewPanelOptions, TextDocument, languages,
     Range, Position } from 'vscode';
import { extname } from 'path';
import { TempFolder } from './utils/tempFolder'
import { SymbolsByAbbreviation, AbbreviationConfig } from './abbreviation/config'

export function mkCommandUri(commandName: string, ...args: any[]): string {
    return `command:${commandName}?${encodeURIComponent(JSON.stringify(args))}`;
}

function createLocalFileUrl(path: string){
    const re = /\\/g;
    return `file:${path}`.replace(re, '/');
}

export class DocViewProvider implements Disposable {
    private subscriptions: Disposable[] = [];
    private currentURL: string | undefined = undefined;
    private backStack: string[] = [];
    private forwardStack: string[] = [];
    private tempFolder : TempFolder;
    private abbreviations: SymbolsByAbbreviation;
    private extensionUri: Uri;
    private tryItDoc: TextDocument | null = null;
    private html: string = '';

    constructor(extensionUri: Uri) {
        this.extensionUri = extensionUri;
        this.subscriptions.push(
            commands.registerCommand('lean4.docView.open', () => this.open()),
            commands.registerCommand('lean4.docView.openUrl', (url: string) => this.open(url)),
            commands.registerCommand('lean4.docView.back', () => this.back()),
            commands.registerCommand('lean4.docView.forward', () => this.forward()),
            commands.registerCommand('lean4.docView.openTryIt', (code: string) => this.tryIt(code)),
            commands.registerCommand('lean4.docView.openExample', (file: string) => this.example(file)),
            commands.registerCommand('lean4.docView.showAllAbbreviations', () => this.showAbbreviations())
        );
        this.subscriptions.push(workspace.onDidCloseTextDocument(doc => {
            if (doc === this.tryItDoc){
                this.tryItDoc = null;
            }
        }));
    }

    private getTempFolder() : TempFolder {
        if (!this.tempFolder){
            this.tempFolder = new TempFolder('lean4');
            this.subscriptions.push(this.tempFolder);
        }
        return this.tempFolder;
    }

    setAbbreviations(abbrev: SymbolsByAbbreviation) : void{
        this.abbreviations = abbrev;
    }

    private async tryIt(code: string) {
        let replace = false
        if (this.tryItDoc == null) {
            this.tryItDoc = await workspace.openTextDocument({language: 'lean4', content: code});
        } else  {
            // reuse the editor that is already open so we don't end up with a million tabs.
            replace = true;
        }
        const editor = await window.showTextDocument(this.tryItDoc, ViewColumn.One);
        if (replace && editor) {
            await editor.edit(edit => {
                // append the new code to the end of the document.
                const end = new Position(editor.document.lineCount, 0)
                edit.replace(new Range(end, end), code);
            });
        }
    }

    private async example(file: string) {
        const uri = Uri.parse(file)
        if (uri.scheme === 'http' || uri.scheme === 'https') {
            const data = await this.httpGet(uri);
            void this.tryIt('-- example \n' + data);
        } else {
            const doc = await workspace.openTextDocument(Uri.parse(file));
            void languages.setTextDocumentLanguage(doc, 'lean4')
            await window.showTextDocument(doc, ViewColumn.One);
        }
    }

    private async receiveMessage(message: any) {
        if (message.name === 'tryit'){
            const code = message.contents as string;
            if (code) {
                // hooray, we have some code to try!
                // this initial comment makes the untitled editor tab have a more reasonable caption.
                void this.tryIt('-- try it \n' + code);
            }
        }
    }

    private webview?: WebviewPanel;
    private getWebview(): WebviewPanel {
        if (!this.webview) {
            const options: WebviewOptions & WebviewPanelOptions = {
                enableFindWidget: true,
                enableScripts: true,
                enableCommandUris: true,
                retainContextWhenHidden: true,
            };

            this.webview = window.createWebviewPanel('lean4_docview', 'Lean Documentation',
                { viewColumn: 3, preserveFocus: true }, options)
            this.webview.onDidDispose(() => this.webview = undefined);
            this.webview.webview.onDidReceiveMessage(m => this.receiveMessage(m));

            let first = true;
            this.webview.onDidChangeViewState(async () => {
                if (first) {
                    first = false;
                    // super hacky way to show both infoview and docview in a split
                    await commands.executeCommand('workbench.action.focusRightGroup');
                    await commands.executeCommand('workbench.action.moveEditorToBelowGroup');
                }
            });
        }
        return this.webview;
    }

    private async showAbbreviations() : Promise<void> {
        // display the HTML table definition of all abbreviations
        if (this.abbreviations) {
            const ac = new AbbreviationConfig()
            const leader = ac.abbreviationCharacter.get();
            const $ = cheerio.load('<table style="font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size:);"><tr><th style="text-align:left">Abbreviation</th><th style="text-align:left">Unicode Symbol</th></tr></table>');
            const table = $('table');
            for (const [abbr, sym] of Object.entries(this.abbreviations)) {
                if (sym && sym.indexOf('CURSOR') < 0) {
                    const row = table.append($('<tr>'));
                    row.append($('<td>').text(leader + abbr));
                    row.append($('<td>').text(sym));
                }
            }
            const help = $.html();
            const uri = createLocalFileUrl(this.getTempFolder().createFile('help.html', help));
            return this.open(uri);
        }
    }

    private async httpGet(uri: Uri) : Promise<string> {
        return new Promise<string>(resolve => {
            void axios.get(uri.toString(), { responseType: 'arraybuffer' }).then(
                response => {
                    if (response.status === 200){
                        resolve(response.data as string);
                    } else {
                        resolve(`Error fetching ${uri.toString()}, code ${response.status}`);
                    }
                })
            });
    }

    async fetch(url?: string): Promise<string> {
        if (url) {
            try{
                const uri = Uri.parse(url);
                let fileType = '';
                if (uri.scheme === 'file') {
                    fileType = extname(uri.fsPath);
                    if (fileType === '.html' || fileType === '.htm') {
                        return (await workspace.fs.readFile(uri)).toString();
                    }
                } else {
                    const {data, headers} = await axios.get<string>(url);
                    fileType = '' + headers['content-type']
                    if (fileType.startsWith('text/html')) {
                        return data;
                    }
                }

                const $ = cheerio.load('<p>');
                $('p').text(`Unsupported file type '${fileType}', please `)
                    .append($('<a>').attr('href', url).attr('alwaysExternal', 'true')
                        .text('open in browser instead.'));
                return $.html();
            }
            catch (ex){
                const $ = cheerio.load('<p>');
                $('p').text('Error fetching file. ' + ex);
                return $.html();
            }
        } else {
            const $ = cheerio.load('<body>');
            const body = $('body');

            const books : any = {
                'Theorem Proving in Lean': mkCommandUri('lean4.docView.openUrl', 'https://lean-lang.org/theorem_proving_in_lean4/introduction.html'),
                'Functional Programming in Lean': mkCommandUri('lean4.docView.openUrl', 'https://lean-lang.org/functional_programming_in_lean/'),
                'Mathematics in Lean': mkCommandUri('lean4.docView.openUrl', 'https://leanprover-community.github.io/mathematics_in_lean/'),
                'The Mechanics of Proof': mkCommandUri('lean4.docView.openUrl', 'https://hrmacbeth.github.io/math2001/'),
                'Reference Manual': mkCommandUri('lean4.docView.openUrl', 'https://lean-lang.org/lean4/doc/'),
                'Abbreviations Cheatsheet': mkCommandUri('lean4.docView.showAllAbbreviations'),
                'Example': mkCommandUri('lean4.docView.openExample', 'https://github.com/leanprover/lean4-samples/raw/main/HelloWorld/Main.lean'),

                // These are handy for testing that the bad file logic is working.
                //'Test bad file': mkCommandUri('lean4.docView.openUrl', Uri.joinPath(this.extensionUri, 'media', 'webview.js')),
                //'Test bad Uri': mkCommandUri('lean4.docView.openUrl', 'https://leanprover.github.io/lean4/doc/images/code-success.png'),
            };

            for (const book of Object.getOwnPropertyNames(books)) {
                body.append($('<p>').append($('<a>').attr('href', books[book] as string).text(book)));
            }

            this.currentURL = createLocalFileUrl(this.getTempFolder().createFile('index.html', $.html()));

            return $.html();
        }
    }

    private mkRelativeUrl(relative: string, base: string): string {
        const uri = new URL(relative, base);
        if (uri.protocol === 'file:') {
            if (new URL(base).protocol !== 'file:') {
                return '';
            }
            const path = Uri.parse(uri.toString()).fsPath;
            if (this.webview) {
                return this.webview.webview.asWebviewUri(Uri.parse(uri.toString())).toString();
            }
            return '';
        } else {
            return uri.toString();
        }
    }

    async getHtmlContents() : Promise<string> {
        return this.html ?? '';
    }

    async setHtml(html? : string): Promise<void> {
        const {webview} = this.getWebview();

        const url = this.currentURL;
        let $: cheerio.Root;
        if (html){
            // See https://cheerio.js.org/ for cheerio API.
            $ = cheerio.load(html);
        }
        else{
            try {
                $ = cheerio.load(await this.fetch(url));
            } catch (e) {
                $ = cheerio.load('<pre>');
                $('pre').text('' + e);
            }
        }

        const book = 'book.js';
        const bookScript = $(`script[src='${book}']`);
        if (bookScript.length) {
            const themes_uri = Uri.joinPath(this.extensionUri, 'media', 'themes.js');
            const config = `<script type='text/javascript'>
var clip_buttons = false; // do not show copy to clipboard buttons
var tryit_buttons = true; // instead show a TryIt button
var side_bar = false; // collapse the side bar menu by default.
            </script>`;
            const script_url = this.webview?.webview.asWebviewUri(themes_uri);
            const node = $(`<script type='text/javascript' src='${script_url}'></script>`).insertBefore(bookScript);
            $(config).insertBefore(node);
        }

        if (url) {
            for (const style of $('link[rel=stylesheet]').get()) {
                style.attribs.href = this.mkRelativeUrl(style.attribs.href as string, url);
            }

            for (const script of $('script[src]').get()) {
                script.attribs.src = this.mkRelativeUrl(script.attribs.src as string, url);
            }
        }

        for (const link of $('a[href]').get()) {
            const tryItMatch = link.attribs.href.match(/\/(?:live|lean-web-editor)\/.*#code=(.*)/);
            if (link.attribs.href.startsWith('#')) {
                // keep in page fragment links
            } else if (link.attribs.alwaysexternal) {
                // keep links with always external attribute
                // note: cheerio .attr('alwaysExternal', 'true') results in a lower case 'alwaysexternal'
                // here when the html is round tripped through the cheerio parser.
            } else if (link.attribs.tryitfile) {
                link.attribs.title = link.attribs.title || 'Open code block (in existing file)';
                link.attribs.href = mkCommandUri('lean4.docView.openExample', new URL(link.attribs.tryitfile as string, url).toString());
            } else if (tryItMatch) {
                const code = decodeURIComponent(tryItMatch[1] as string);
                link.attribs.title = link.attribs.title || 'Open code block in new editor';
                link.attribs.href = mkCommandUri('lean4.docView.openTryIt', code);
            } else if (!link.attribs.href.startsWith('command:')) {
                const hrefUrl = new URL(link.attribs.href as string, url);
                const isExternal = !url || new URL(url).origin !== hrefUrl.origin;
                if (!isExternal || hrefUrl.protocol === 'file:') {
                    link.attribs.title = link.attribs.title || link.attribs.href;
                    link.attribs.href = mkCommandUri('lean4.docView.openUrl', hrefUrl.toString());
                }
            }
        }

        // javascript search doesn't work
        $('.sphinxsidebar #searchbox').remove();

        const nav = $('<nav>');
        nav.css('width', '100vw');
        nav.css('position', 'fixed');
        nav.css('top', '0');
        nav.css('right', '0');
        nav.css('text-align', 'right');
        nav.css('z-index', '1000'); // ensures it sits on top of any mdbook menu bar.
        nav.prependTo($('body'));
        const navDiv = $('<span>');
        navDiv.css('padding', '4px');
        navDiv.css('padding-right', '20px');
        navDiv.css('background-color', 'var(--vscode-tab-activeBackground)');
        nav.append(navDiv);
        const fontSize = workspace.getConfiguration('editor').get('fontSize') + 'px';
        const mkLink = (command: string, title: string, text: string) => $('<a>')
            .attr('title', title)
            .attr('href', mkCommandUri(command))
            .css('color', 'var(--vscode-tab-activeForeground)')
            .css('font-family', 'sans-serif')
            .css('font-size', fontSize)
            .css('margin-left', '1em')
            .css('text-decoration', 'none')
            .text(text);
        navDiv.append(mkLink('lean4.docView.back', 'back', '⬅ back'));
        navDiv.append(mkLink('lean4.docView.forward', 'forward', 'forward ➡'));
        try {
            // move top nav section down to make room for back/forward buttons
            $('nav+*').css('margin-top','3em');
        } catch {
            // ignore it, the TPIL doesn't have these matching html nodes
            // but some other content does.
        }

        this.html = $.html();
        webview.html = this.html;
    }

    async openHtml(html : string): Promise<void> {
        this.currentURL = undefined;
        await this.setHtml(html);
    }

    /** Called by the user clicking a link. */
    async open(url?: string | undefined): Promise<void> {
        if (this.currentURL) {
            this.backStack.push(this.currentURL);
            this.forwardStack = [];
        }
        this.currentURL = url;
        await this.setHtml();
    }

    async back(): Promise<void> {
        if (this.backStack.length === 0) {return;}
        if (this.currentURL) this.forwardStack.push(this.currentURL);
        this.currentURL = this.backStack.pop();
        await this.setHtml();
    }

    async forward(): Promise<void> {
        if (this.forwardStack.length === 0) {return;}
        if (this.currentURL) this.backStack.push(this.currentURL);
        this.currentURL = this.forwardStack.pop();
        await this.setHtml();
    }

    dispose(): void {
        for (const s of this.subscriptions) { s.dispose(); }
    }
}
