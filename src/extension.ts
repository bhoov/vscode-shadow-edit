import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store, Session, readReal, publish } from './storage';
import { merge, hasMarkers } from './merge';

const scheme = 'shadow-edit';
let activeStore: Store | undefined;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const uriFor = (s: Session, result = false) => vscode.Uri.from({ scheme, authority: s.id, path: `/${result ? 'Resolution/' + (s.pending?.id ?? 'legacy') : 'Shadow' + (s.generation ? '/' + s.generation : '')}/${path.basename(s.originalPath)}` });

class ShadowFS implements vscode.FileSystemProvider {
  readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this.changes.event;
  constructor(readonly sessions: Map<string, Session>, readonly store: Store) {}
  has(uri: vscode.Uri): boolean {
    const s = this.sessions.get(uri.authority);
    return uri.scheme === scheme && !!s && (!this.isResult(uri) || !!s.pending) && uri.toString() === uriFor(s, this.isResult(uri)).toString();
  }
  session(uri: vscode.Uri): Session {
    const s = this.sessions.get(uri.authority);
    if (!this.has(uri)) throw vscode.FileSystemError.FileNotFound('This Shadow document belongs to an older session. Use Resume to open the current session.');
    return s!;
  }
  isResult(uri: vscode.Uri): boolean { return uri.path.startsWith('/Resolution/'); }
  content(uri: vscode.Uri): string {
    const s = this.session(uri);
    if (this.isResult(uri)) {
      if (!s.pending || uri.toString() !== uriFor(s, true).toString()) throw vscode.FileSystemError.FileNotFound(uri);
      return s.pending.result;
    }
    return s.mine;
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    const s = this.session(uri);
    return { type: vscode.FileType.File, ctime: s.createdAt, mtime: s.updatedAt, size: Buffer.byteLength(this.content(uri)) };
  }
  readFile(uri: vscode.Uri): Uint8Array { return Buffer.from(this.content(uri)); }
  async capture(uri: vscode.Uri, content: string): Promise<void> {
    const s = this.session(uri);
    if (this.isResult(uri)) {
      if (!s.pending || uri.toString() !== uriFor(s, true).toString()) throw vscode.FileSystemError.FileNotFound(uri);
      s.pending.result = content;
    } else s.mine = content;
    s.updatedAt = Date.now();
    await this.store.save(s);
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> { await this.capture(uri, Buffer.from(content).toString('utf8')); }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Use Shadow Edit: Start.'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Use Shadow Edit: Discard & Stop.'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Shadow documents cannot be renamed.'); }
  changed(uri: vscode.Uri): void { this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]); }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const location = context.storageUri ?? context.globalStorageUri;
  if (location.scheme !== 'file') throw new Error('Shadow Edit MVP requires a desktop or remote Node extension host with local storage.');
  const store = new Store(path.join(location.fsPath, 'sessions'));
  await store.init();
  activeStore = store;
  let loaded: Session[];
  try { loaded = await store.load(); } catch (e) { await store.close(); activeStore = undefined; throw e; }
  const sessions = new Map(loaded.map(s => [s.id, s]));
  const provider = new ShadowFS(sessions, store);
  const busy = new Set<string>();
  const snapshots = new Map<string, string>();
  const watchers = new Map<string, vscode.Disposable>();
  const external = new Map<string, string>();
  const status = vscode.window.createStatusBarItem('shadowEdit.session', vscode.StatusBarAlignment.Left, 100);
  status.command = 'shadowEdit.actions';
  status.name = 'Shadow Edit';
  status.color = new vscode.ThemeColor('shadowEdit.indicator');
  const tint = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('shadowEdit.background'),
  });
  const updateTint = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      // Leave native diff highlighting and conflict resolution colors unobscured.
      const inDiff = vscode.window.tabGroups.all.some(group => group.viewColumn === editor.viewColumn && group.activeTab?.input instanceof vscode.TabInputTextDiff);
      const enabled = vscode.workspace.getConfiguration('shadowEdit', doc.uri).get<boolean>('editorTint', true);
      const privateDraft = provider.has(doc.uri) && !provider.isResult(doc.uri);
      editor.setDecorations(tint, enabled && privateDraft && !inDiff
        ? [new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)] : []);
    }
  };
  const decorationChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  context.subscriptions.push(status, tint, provider.changes, decorationChanged,
    vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider('shadow-review', { provideTextDocumentContent: uri => {
      const content = snapshots.get(uri.toString());
      if (content === undefined) throw vscode.FileSystemError.FileNotFound('Review snapshot expired. Run Review Differences again.');
      return content;
    } }),
    vscode.window.registerFileDecorationProvider({ onDidChangeFileDecorations: decorationChanged.event, provideFileDecoration: uri => uri.scheme === scheme ? { badge: 'S', tooltip: 'Private Shadow Edit document', color: new vscode.ThemeColor('shadowEdit.indicator') } : undefined }));

  const updateStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const s = doc && provider.has(doc.uri) ? sessions.get(doc.uri.authority) : undefined;
    if (!s) { status.hide(); return; }
    status.text = `$(edit) ${provider.isResult(doc!.uri) ? 'Shadow Resolution · Private' : 'Shadow · Private edits'}${external.get(s.id) ?? ''}`;
    status.tooltip = 'Private saves • Review, merge, suspend, or discard'; status.show();
  };
  const observe = (s: Session) => {
    const check = async () => {
      try { external.set(s.id, (await readReal(s.originalPath)).content === s.base ? '' : ' $(sync) External changes'); }
      catch { external.set(s.id, ' $(warning) Original unavailable'); }
      updateStatus();
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(s.originalPath)), '*'));
    const onEvent = (uri: vscode.Uri) => { if (uri.fsPath === s.originalPath) void check(); };
    watcher.onDidChange(onEvent); watcher.onDidCreate(onEvent); watcher.onDidDelete(onEvent);
    watchers.set(s.id, watcher); context.subscriptions.push(watcher); void check();
  };
  for (const s of sessions.values()) observe(s);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); updateTint(); }),
    vscode.window.onDidChangeVisibleTextEditors(updateTint),
    vscode.window.tabGroups.onDidChangeTabs(updateTint),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('shadowEdit.editorTint')) updateTint(); }),
    vscode.workspace.onDidChangeTextDocument(e => {
    if (!provider.has(e.document.uri) || !e.contentChanges.length) return;
    updateTint();
    // Queue a complete snapshot for every edit, independently of manual saves.
    void provider.capture(e.document.uri, e.document.getText()).catch(e => vscode.window.showErrorMessage('Shadow recovery write failed: ' + errorText(e)));
  }));

  const show = async (s: Session, result = false) => {
    const doc = await vscode.workspace.openTextDocument(uriFor(s, result));
    if (doc.languageId !== s.language) await vscode.languages.setTextDocumentLanguage(doc, s.language);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    updateStatus(); updateTint(); decorationChanged.fire(doc.uri);
    return editor;
  };
  const choose = async (arg?: vscode.Uri): Promise<Session | undefined> => {
    const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === scheme) return provider.session(uri);
    const existing = [...sessions.values()].find(s => s.originalUri === uri?.toString());
    if (existing) return existing;
    const item = await vscode.window.showQuickPick([...sessions.values()].map(s => ({ label: path.basename(s.originalPath), description: s.originalPath, s })), { placeHolder: 'Resume or manage a private session' });
    return item?.s;
  };
  const sync = async (s: Session) => {
    for (const doc of vscode.workspace.textDocuments.filter(d => provider.has(d.uri) && d.uri.authority === s.id && !d.isClosed)) {
      // Tab closure and TextDocument disposal are separate host events.
      if (provider.isResult(doc.uri) && (!s.pending || doc.uri.toString() !== uriFor(s, true).toString())) continue;
      await provider.capture(doc.uri, doc.getText());
      if (doc.isDirty && !await doc.save()) throw new Error('Could not save private edits. Session retained.');
    }
    await store.save(s);
  };
  const realIsDirty = (s: Session) => vscode.workspace.textDocuments.some(d => d.uri.toString() === s.originalUri && d.isDirty);
  const snapshotUri = (content: string, label: string, s: Session) => {
    const uri = vscode.Uri.from({ scheme: 'shadow-review', authority: randomUUID(), path: `/${label}/${path.basename(s.originalPath)}` });
    snapshots.set(uri.toString(), content); return uri;
  };
  const isPrivate = (s: Session) => (t: vscode.Tab) => {
    const input = t.input;
    return input instanceof vscode.TabInputText ? input.uri.scheme === scheme && input.uri.authority === s.id : input instanceof vscode.TabInputTextDiff && [input.original, input.modified].some(u => u.scheme === scheme && u.authority === s.id);
  };
  const isUri = (uri: vscode.Uri) => (t: vscode.Tab) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString();
  // Closing the last tab of a group removes the group and the split layout.
  // Open `doc` in each group where a matching tab is visible or is the only
  // content, then close the matches. Returns the number of groups that got `doc`.
  const replaceTabs = async (match: (t: vscode.Tab) => boolean, doc: vscode.TextDocument) => {
    const active = vscode.window.tabGroups.activeTabGroup;
    const groups = vscode.window.tabGroups.all
      .filter(g => g.tabs.some(match) && ((g.activeTab && match(g.activeTab)) || g.tabs.every(match)))
      .sort((a, b) => Number(a === active) - Number(b === active));
    for (const g of groups) await vscode.window.showTextDocument(doc, { viewColumn: g.viewColumn, preview: false, preserveFocus: g !== active });
    if (!await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(match))) return undefined;
    return groups.length;
  };
  const closePrivate = async (s: Session) => vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(isPrivate(s)));
  const stop = async (s: Session, remove: boolean, discard = false) => {
    await sync(s);
    const original = await vscode.workspace.openTextDocument(vscode.Uri.parse(s.originalUri));
    const replaced = await replaceTabs(isPrivate(s), original);
    if (replaced === undefined) throw new Error('Closing was cancelled. Session retained.');
    if (remove && (discard || s.mine === s.base)) {
      await store.archive(s, 'stopped');
      await store.remove(s); sessions.delete(s.id); watchers.get(s.id)?.dispose();
    } else if (remove) void vscode.window.showInformationMessage('New private edits arrived while stopping. The session is suspended and can be resumed.');
    if (!replaced) await vscode.window.showTextDocument(original, { preview: false });
    updateStatus();
  };
  const apply = async (s: Session) => {
    await sync(s);
    const p = s.pending;
    if (!p) throw new Error('Run Merge & Stop or Merge & Continue first.');
    if (s.mine !== p.mine) throw new Error('Your shadow changed during resolution. Run Merge & Stop or Merge & Continue again. Resolution retained.');
    if (hasMarkers(p.result)) throw new Error('Remove all conflict marker lines in the private resolution before applying.');
    if (realIsDirty(s)) throw new Error('The ordinary file has unsaved edits. Save or discard that ordinary buffer before merging. Private edits are safe.');
    const mine = p.mine, result = p.result;
    await store.archive(s, 'before-publish');
    await publish(s.originalPath, p.theirs, result, store.root, async () => {
      if (s.mine !== mine || p.result !== result || realIsDirty(s)) throw new Error('An editing buffer changed during publishing. Retry the merge.');
    }, (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath));
    if (p.result !== result || s.mine !== mine) throw new Error('Published, but private text changed during publishing. Your session and recovery snapshots are retained. Inspect the real file before retrying.');
    await closeResolution(s);
    if (p.result !== result) throw new Error('Published, but the resolution changed while closing. Draft retained for recovery.');
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriFor(s).toString() && !d.isClosed);
    // Rebase typing received while closing the result, then use a versioned
    // WorkspaceEdit. A rejected edit leaves the original private state intact.
    const rebased = merge(mine, doc?.getText() ?? s.mine, result);
    if (rebased.conflicts) throw new Error('Published, but new private typing needs review. Session and recovery snapshots retained.');
    if (doc && doc.getText() !== rebased.content) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), rebased.content);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('Merged on disk, but the private editor could not refresh. Session retained.');
    }
    s.base = result; s.mine = doc?.getText() ?? rebased.content;
    s.pending = undefined;
    await store.save(s);
    if (doc) { if (!await doc.save()) throw new Error('Published, but saving the refreshed private document failed. Session retained.'); }
    else provider.changed(uriFor(s));
    external.set(s.id, ''); updateStatus();
    if (p.stop && s.mine === s.base) await stop(s, true);
    else await show(s);
    void vscode.window.showInformationMessage('Shadow edits merged into the working directory.');
  };
  const closeResolution = async (s: Session) => {
    const draft = await vscode.workspace.openTextDocument(uriFor(s));
    if (await replaceTabs(isUri(uriFor(s, true)), draft) === undefined) throw new Error('Closing the resolution was cancelled. Draft retained.');
  };
  const prepare = async (s: Session, stopAfter: boolean) => {
    await sync(s);
    if (realIsDirty(s)) throw new Error('The ordinary file has unsaved edits. Save or discard that ordinary buffer before merging.');
    const theirs = await readReal(s.originalPath);
    const mine = s.mine;
    const computed = merge(s.base, mine, theirs.content);
    if (s.pending) {
      const answer = await vscode.window.showWarningMessage('Replace the previous resolution draft? A recovery copy will be kept.', { modal: true }, 'Replace');
      if (answer !== 'Replace') return;
      await store.archive(s, 'previous-resolution');
      await closeResolution(s);
    }
    s.pending = { id: randomUUID(), mine, theirs, result: computed.content, stop: stopAfter };
    await store.save(s);
    if (computed.conflicts) {
      await show(s, true);
      void vscode.window.showInformationMessage('Resolve MINE / BASE / THEIRS markers here, then run Shadow Edit: Apply Resolution. Saves remain private.');
    } else await apply(s);
  };

  const register = (id: string, action: (arg?: vscode.Uri) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand('shadowEdit.' + id, async (arg?: vscode.Uri) => {
    const key = arg?.toString() ?? vscode.window.activeTextEditor?.document.uri.toString() ?? 'picker';
    // Commands are globally serialized; typing and recovery writes remain enabled.
    if (busy.size) { void vscode.window.showInformationMessage('A Shadow Edit operation is already running.'); return; }
    busy.add(key);
    try { return await action(arg); } catch (e) { console.error('Shadow Edit:', e); void vscode.window.showErrorMessage('Shadow Edit: ' + errorText(e)); } finally { busy.delete(key); }
  }));
  const start = async (arg?: vscode.Uri) => {
    const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === scheme) return show(provider.session(uri));
    if (!uri || uri.scheme !== 'file') throw new Error('Start from a saved, local UTF-8 file.');
    const existing = [...sessions.values()].find(s => s.originalUri === uri.toString());
    if (existing) {
      const choice = await vscode.window.showInformationMessage(
        `A saved Shadow session already exists for ${path.basename(uri.fsPath)}.`,
        { modal: true, detail: 'Start Fresh uses the current editor contents and archives the previous private draft for recovery. To continue that draft instead, cancel and use Shadow Edit: Resume.' },
        'Start Fresh');
      if (choice !== 'Start Fresh') return;
      await sync(existing);
      if (!await closePrivate(existing)) throw new Error('Closing was cancelled. Existing session retained.');
      await sync(existing);
      await store.archive(existing, 'restarted');
    }
    const base = await readReal(uri.fsPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const now = Date.now();
    const s: Session = { id: existing?.id ?? createHash('sha256').update(uri.toString()).digest('hex'), generation: randomUUID(), originalUri: uri.toString(), originalPath: uri.fsPath, language: doc.languageId, base: base.content, mine: doc.getText(), createdAt: now, updatedAt: now };
    // Invalidate old document URIs before persisting so delayed events from a
    // closed editor cannot overwrite the new session. Keep legacy URIs resumable.
    sessions.set(s.id, s);
    try { await store.save(s); }
    catch (error) { if (existing) sessions.set(existing.id, existing); else sessions.delete(s.id); throw error; }
    watchers.get(s.id)?.dispose(); observe(s);
    const editor = await show(s);
    if (doc.isDirty) void vscode.window.showWarningMessage('Unsaved edits were copied safely into Shadow. The original dirty tab is still open: close it and choose Don’t Save to prevent ordinary saves.');
    else await replaceTabs(isUri(uri), editor.document);
    return s.id;
  };
  register('start', arg => start(arg));
  register('resume', async arg => { const s = await choose(arg); if (s) await show(s); });
  register('review', async arg => {
    const s = await choose(arg); if (!s) return;
    await sync(s);
    const real = await readReal(s.originalPath);
    await vscode.commands.executeCommand('vscode.diff', snapshotUri(real.content, 'Disk snapshot', s), uriFor(s), `${path.basename(s.originalPath)}: disk snapshot ↔ Shadow`, { preview: false });
  });
  register('reviewBase', async arg => {
    const s = await choose(arg); if (s) await vscode.commands.executeCommand('vscode.diff', snapshotUri(s.base, 'BASE', s), uriFor(s), 'BASE ↔ Shadow', { preview: false });
  });
  register('mergeStop', async arg => { const s = await choose(arg); if (s) await prepare(s, true); });
  register('mergeContinue', async arg => { const s = await choose(arg); if (s) await prepare(s, false); });
  register('applyResolution', async arg => { const s = await choose(arg); if (s) await apply(s); });
  register('resumeResolution', async arg => { const s = await choose(arg); if (s?.pending) await show(s, true); });
  register('cancelMerge', async arg => { const s = await choose(arg); if (s) { await sync(s); await closeResolution(s); await show(s); } });
  register('suspend', async arg => { const s = await choose(arg); if (s) await stop(s, false); });
  register('discard', async arg => {
    const s = await choose(arg); if (!s) return;
    await sync(s);
    if ((s.mine !== s.base || s.pending) && await vscode.window.showWarningMessage('Discard this private session? A recovery snapshot will remain in extension storage.', { modal: true }, 'Discard') !== 'Discard') return;
    await store.archive(s, 'discarded'); await stop(s, true, true);
  });
  register('storage', async () => { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(store.root), { forceNewWindow: true }); });
  // Dispatch after the picker closes so the command serialization guard is released.
  context.subscriptions.push(vscode.commands.registerCommand('shadowEdit.actions', async () => {
    const choices = [['Review differences', 'review'], ['Merge & Stop', 'mergeStop'], ['Merge & Continue', 'mergeContinue'], ['Apply Resolution', 'applyResolution'], ['Resume Resolution', 'resumeResolution'], ['Cancel Merge (keep draft)', 'cancelMerge'], ['Suspend', 'suspend'], ['Discard & Stop', 'discard']];
    const choice = await vscode.window.showQuickPick(choices.map(([label, command]) => ({ label, command })));
    if (choice) await vscode.commands.executeCommand('shadowEdit.' + choice.command);
  }));
  updateStatus();
  updateTint();
  if (sessions.size) void vscode.window.showInformationMessage(`${sessions.size} saved Shadow Edit session(s) available.`, 'Resume').then(choice => { if (choice) void vscode.commands.executeCommand('shadowEdit.resume'); });
  // Exposed only through the extension API for integration tests; no filesystem bypass.
  return;
}
export async function deactivate(): Promise<void> { await activeStore?.close(); }
