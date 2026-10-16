import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const command = (id: string, arg?: vscode.Uri) => vscode.commands.executeCommand('shadowEdit.' + id, arg);
async function replace(doc: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}
async function chooseExisting(choice: string | undefined, action: () => Thenable<unknown>) {
  const original = vscode.window.showInformationMessage;
  let prompted = false;
  vscode.window.showInformationMessage = ((message: string, ...args: unknown[]) => {
    if (message.startsWith('A saved Shadow session already exists')) {
      prompted = true;
      assert.ok(!args.includes('Resume Saved Shadow')); assert.ok(args.includes('Start Fresh'));
      return Promise.resolve(choice);
    }
    return (original as (...args: unknown[]) => unknown)(message, ...args);
  }) as typeof original;
  try { await action(); assert.ok(prompted, 'Starting from an ordinary file with saved state must offer an explicit choice'); }
  finally { vscode.window.showInformationMessage = original; }
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('bhoov.shadow-edit')!; await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  if (process.env.SHADOW_TEST_PHASE === 'recovery') {
    const file = path.join(root, 'recovery.py');
    await fs.writeFile(file, 'first\nmiddle\nLAST\n');
    await command('resume', vscode.Uri.file(file));
    const doc = vscode.window.activeTextEditor!.document;
    assert.equal(doc.uri.scheme, 'shadow-edit'); assert.equal(doc.getText(), 'FIRST\nmiddle\nlast\n');
    await command('mergeStop', doc.uri);
    assert.equal(await fs.readFile(file, 'utf8'), 'FIRST\nmiddle\nLAST\n');
    console.log('PASS: Full VS Code restart recovers private text and original merge baseline.');
    return;
  }
  const file = path.join(root, 'a.py'); const other = path.join(root, 'b.py');
  await fs.writeFile(file, 'x = 1\n'); await fs.writeFile(other, 'b = 1\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base');
  const original = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(original);
  await command('start');
  const shadow = vscode.window.activeTextEditor!.document;
  assert.equal(shadow.uri.scheme, 'shadow-edit'); assert.equal(shadow.languageId, 'python');
  await replace(shadow, 'x = 3\n');
  await vscode.commands.executeCommand('undo'); assert.equal(shadow.getText(), 'x = 1\n');
  await vscode.commands.executeCommand('redo'); assert.equal(shadow.getText(), 'x = 3\n');
  assert.ok(await shadow.save());
  assert.equal(await fs.readFile(file, 'utf8'), 'x = 1\n'); assert.equal(git('status', '--porcelain'), '');
  await command('start'); assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), shadow.uri.toString());
  await fs.writeFile(file, 'x = 1\ny = 2\n'); git('add', '.'); git('commit', '-qm', 'agent'); const head = git('rev-parse', 'HEAD');
  assert.equal(shadow.getText(), 'x = 3\n');
  const mergeEditors: string[] = [];
  const opened = vscode.workspace.onDidOpenTextDocument(doc => mergeEditors.push(doc.uri.toString()));
  try { await command('mergeContinue', shadow.uri); } finally { opened.dispose(); }
  assert.deepEqual(mergeEditors, [], 'A clean merge must not open a review or resolution editor');
  assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), shadow.uri.toString());
  assert.equal(await fs.readFile(file, 'utf8'), 'x = 3\ny = 2\n'); assert.equal(shadow.getText(), 'x = 3\ny = 2\n'); assert.equal(git('rev-parse', 'HEAD'), head); assert.match(git('status', '--porcelain'), /M a.py/);
  const b = await vscode.workspace.openTextDocument(other); await replace(b, 'b = 2\n'); await b.save(); assert.equal(await fs.readFile(other, 'utf8'), 'b = 2\n');
  await replace(shadow, 'x = 5\ny = 2\n'); await shadow.save(); await fs.writeFile(file, 'x = 6\ny = 2\n');
  await command('mergeContinue', shadow.uri);
  const resolution = vscode.window.activeTextEditor!.document; assert.ok(resolution.uri.path.startsWith('/Resolution/')); assert.match(resolution.getText(), /<<<<<<< MINE/);
  await command('cancelMerge', resolution.uri); assert.equal(await fs.readFile(file, 'utf8'), 'x = 6\ny = 2\n'); assert.equal(shadow.getText(), 'x = 5\ny = 2\n');
  await command('resumeResolution', shadow.uri);
  const resolved = vscode.window.activeTextEditor!.document; await replace(resolved, 'x = 7\ny = 2\n'); await resolved.save();
  // A newer external write makes the resolution stale; apply must not overwrite it.
  await fs.writeFile(file, 'x = 8\ny = 2\n'); await command('applyResolution', resolved.uri);
  assert.equal(await fs.readFile(file, 'utf8'), 'x = 8\ny = 2\n'); assert.equal(resolved.getText(), 'x = 7\ny = 2\n');
  await command('cancelMerge', resolved.uri); await command('suspend', shadow.uri); await command('resume', original.uri);
  assert.equal(vscode.window.activeTextEditor!.document.getText(), 'x = 5\ny = 2\n');
  // A fresh session exercises successful conflict resolution and Merge & Stop.
  const conflictFile = path.join(root, 'conflict.md'); await fs.writeFile(conflictFile, 'base\n'); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(conflictFile)); await command('start');
  const conflictShadow = vscode.window.activeTextEditor!.document; await replace(conflictShadow, 'mine\n'); await conflictShadow.save(); await fs.writeFile(conflictFile, 'theirs\n'); await command('mergeStop', conflictShadow.uri);
  const draft = vscode.window.activeTextEditor!.document; await replace(draft, 'resolved\n'); await draft.save(); await command('applyResolution', draft.uri); assert.equal(await fs.readFile(conflictFile, 'utf8'), 'resolved\n'); assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'file');
  // Unsaved initial contents and language selection survive the transition.
  for (const [name, language] of [['dirty.ts', 'typescript'], ['dirty.md', 'markdown']]) {
    const f = path.join(root, name); await fs.writeFile(f, 'base\n'); const doc = await vscode.workspace.openTextDocument(f); await vscode.window.showTextDocument(doc); await replace(doc, 'unsaved\n');
    await command('start', doc.uri); const privateDoc = vscode.window.activeTextEditor!.document;
    assert.equal(privateDoc.languageId, language); assert.equal(privateDoc.getText(), 'unsaved\n'); await privateDoc.save(); assert.equal(await fs.readFile(f, 'utf8'), 'base\n');
  }
  // Starting from an ordinary editor must not silently resurrect an old draft.
  const restartFile = path.join(root, 'restart.py'); await fs.writeFile(restartFile, 'base\n');
  const ordinary = await vscode.workspace.openTextDocument(restartFile); await vscode.window.showTextDocument(ordinary); await command('start');
  const oldShadow = vscode.window.activeTextEditor!.document; await replace(oldShadow, 'old private draft\n'); await oldShadow.save();
  await vscode.window.showTextDocument(ordinary); await replace(ordinary, 'new disk baseline\n'); await ordinary.save();
  await replace(ordinary, 'current unsaved draft\n');
  await chooseExisting(undefined, () => command('start', ordinary.uri));
  assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), ordinary.uri.toString());
  assert.equal(oldShadow.getText(), 'old private draft\n');
  await command('resume', ordinary.uri);
  assert.equal(vscode.window.activeTextEditor!.document.getText(), 'old private draft\n');
  await vscode.window.showTextDocument(ordinary);
  await chooseExisting('Start Fresh', () => command('start', ordinary.uri));
  const fresh = vscode.window.activeTextEditor!.document;
  assert.notEqual(fresh.uri.toString(), oldShadow.uri.toString());
  assert.equal(fresh.getText(), 'current unsaved draft\n');
  assert.equal(await fs.readFile(restartFile, 'utf8'), 'new disk baseline\n');
  const storageRoot = path.join(process.env.SHADOW_TEST_USER_DATA!, 'User', 'workspaceStorage');
  const archives = (await fs.readdir(storageRoot, { recursive: true })).filter(name => name.endsWith('-restarted.json'));
  const archived = await Promise.all(archives.map(async name => JSON.parse(await fs.readFile(path.join(storageRoot, name), 'utf8'))));
  assert.ok(archived.some(s => s.originalUri === ordinary.uri.toString() && s.mine === 'old private draft\n' && s.base === 'base\n'), 'Fresh start must archive the complete previous draft and baseline');
  const currentPath = (await fs.readdir(storageRoot, { recursive: true })).find(name => name.endsWith(path.join('sessions', fresh.uri.authority + '.json')))!;
  const currentState = JSON.parse(await fs.readFile(path.join(storageRoot, currentPath), 'utf8'));
  assert.equal(currentState.base, 'new disk baseline\n'); assert.equal(currentState.mine, 'current unsaved draft\n');
  await assert.rejects(async () => { await vscode.workspace.fs.writeFile(oldShadow.uri, Buffer.from('late old save\n')); });
  assert.equal(fresh.getText(), 'current unsaved draft\n');
  // Start always starts fresh from an ordinary file, with confirmation for old state.
  await vscode.window.showTextDocument(ordinary); await replace(ordinary, 'latest visible draft\n'); await ordinary.save();
  await chooseExisting('Start Fresh', () => command('start', ordinary.uri));
  const newest = vscode.window.activeTextEditor!.document;
  assert.notEqual(newest.uri.toString(), fresh.uri.toString()); assert.equal(newest.getText(), 'latest visible draft\n');
  await command('mergeStop', newest.uri);
  await command('start', ordinary.uri);
  const afterStop = vscode.window.activeTextEditor!.document;
  assert.notEqual(afterStop.uri.toString(), newest.uri.toString()); assert.equal(afterStop.getText(), 'latest visible draft\n');
  console.log('PASS: Existing-session cancel/resume/fresh choices, unsaved current draft, stale URI rejection, and fresh start after stop.');
  console.log('PASS: Extension Host isolation, native save, languages, duplicate start, agent commit, merge/continue, conflict, cancel, stale resolution, suspend/resume, merge/stop, dirty-start, multiple files.');
  // Merge & Stop keeps a split layout: the real file replaces the Shadow tab in its own group.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const left = path.join(root, 'left.py'); const right = path.join(root, 'right.py');
  await fs.writeFile(left, 'left\n'); await fs.writeFile(right, 'right\n');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(left), { viewColumn: vscode.ViewColumn.One });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(right), { viewColumn: vscode.ViewColumn.Two });
  await command('start');
  const splitShadow = vscode.window.activeTextEditor!.document;
  assert.equal(splitShadow.uri.scheme, 'shadow-edit'); assert.equal(vscode.window.tabGroups.all.length, 2);
  await replace(splitShadow, 'RIGHT\n'); await splitShadow.save();
  await command('mergeStop', splitShadow.uri);
  assert.equal(await fs.readFile(right, 'utf8'), 'RIGHT\n');
  const groupFiles = vscode.window.tabGroups.all.map(g => g.tabs.map(t => (t.input as vscode.TabInputText).uri.fsPath));
  assert.deepEqual(groupFiles, [[left], [right]]);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, right); assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.Two);
  console.log('PASS: Merge & Stop preserves split editor groups.');
  // Discard & Stop shows the changes to discard behind its confirmation; Cancel returns to the Shadow document.
  const discardFile = path.join(root, 'discard.py'); await fs.writeFile(discardFile, 'keep\n');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(discardFile)); await command('start');
  const discardShadow = vscode.window.activeTextEditor!.document; await replace(discardShadow, 'throw away\n'); await discardShadow.save();
  const warn = vscode.window.showWarningMessage;
  const confirmDiscard = async (choice: string | undefined) => {
    let diffShown = false;
    vscode.window.showWarningMessage = ((message: string, ...args: unknown[]) => {
      assert.match(message, /^Discard the unmerged private changes/); assert.ok(args.includes('Discard & Stop'));
      diffShown = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
      return Promise.resolve(choice);
    }) as typeof warn;
    try { await command('discard', discardShadow.uri); } finally { vscode.window.showWarningMessage = warn; }
    assert.ok(diffShown, 'The diff of changes to discard must be visible behind the confirmation');
  };
  await confirmDiscard(undefined);
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), discardShadow.uri.toString());
  assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputTextDiff), 'Cancel must close the discard preview');
  await confirmDiscard('Discard & Stop');
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, discardFile); assert.equal(await fs.readFile(discardFile, 'utf8'), 'keep\n');
  assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputTextDiff || (t.input as vscode.TabInputText).uri.scheme === 'shadow-edit'));
  console.log('PASS: Discard & Stop previews the changes to discard, cancels cleanly, and discards on confirmation.');
  const recovery = path.join(root, 'recovery.py'); await fs.writeFile(recovery, 'first\nmiddle\nlast\n');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(recovery)); await command('start');
  const privateDoc = vscode.window.activeTextEditor!.document; await replace(privateDoc, 'FIRST\nmiddle\nlast\n'); await privateDoc.save();
}
