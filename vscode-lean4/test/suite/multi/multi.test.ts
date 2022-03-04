import * as assert from 'assert';
import { suite } from 'mocha';
import * as path from 'path';
import * as vscode from 'vscode';
import { waitForActiveExtension, waitForActiveEditor, waitForInfoViewOpen, waitForHtmlString,
	assertStringInInfoview } from '../utils/helpers';
import { InfoProvider } from '../../../src/infoview';
import { LeanClientProvider} from '../../../src/utils/clientProvider';

suite('Multi-Folder Test Suite', () => {

	test('Load a multi-project workspace', async () => {

		console.log('=================== Load Lean Files in a multi-project workspace ===================');
		// make sure test is always run in predictable state, which is no file or folder open
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		void vscode.window.showInformationMessage('Running tests: ' + __dirname);

		const testsRoot = path.join(__dirname, '..', '..', '..', '..', 'test', 'test-fixtures', 'multi');
		const options : vscode.TextDocumentShowOptions = { preview: false  };
		const doc = await vscode.workspace.openTextDocument(path.join(testsRoot, 'test', 'Main.lean'));
		await vscode.window.showTextDocument(doc, options);

		const lean = await waitForActiveExtension('leanprover.lean4');
		assert(lean, 'Lean extension not loaded');
		assert(lean.exports.isLean4Project);
		assert(lean.isActive);
        console.log(`Found lean package version: ${lean.packageJSON.version}`);

		await waitForActiveEditor('Main.lean');

		const info = lean.exports.infoProvider as InfoProvider;
        assert(await waitForInfoViewOpen(info, 60),
			'Info view did not open after 20 seconds');

		// verify we have a nightly build running in this folder.
		await assertStringInInfoview(info, '4.0.0-nightly-');

		// Now open a file from the other project
		const doc2 = await vscode.workspace.openTextDocument(path.join(testsRoot, 'foo', 'Foo.lean'));
		await vscode.window.showTextDocument(doc2, options);

		// verify that a different version of lean is running here (leanprover/lean4:stable)
		await assertStringInInfoview(info, '4.0.0, commit');

		// Now verify we have 2 LeanClients running.
		const clients = lean.exports.clientProvider as LeanClientProvider;
		const actual = clients.getClients().length
		assert(actual === 2, "Expected 2 LeanClients to be running, but found " + actual);

		// make sure test is always run in predictable state, which is no file or folder open
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	}).timeout(60000);

}).timeout(60000);