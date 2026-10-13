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
  await command('start', original.uri); assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), shadow.uri.toString());
  await fs.writeFile(file, 'x = 1\ny = 2\n'); git('add', '.'); git('commit', '-qm', 'agent'); const head = git('rev-parse', 'HEAD');
  assert.equal(shadow.getText(), 'x = 3\n');
  await command('mergeContinue', shadow.uri);
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
  console.log('PASS: Extension Host isolation, native save, languages, duplicate start, agent commit, merge/continue, conflict, cancel, stale resolution, suspend/resume, merge/stop, dirty-start, multiple files.');
  const recovery = path.join(root, 'recovery.py'); await fs.writeFile(recovery, 'first\nmiddle\nlast\n');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(recovery)); await command('start');
  const privateDoc = vscode.window.activeTextEditor!.document; await replace(privateDoc, 'FIRST\nmiddle\nlast\n'); await privateDoc.save();
}
