# Shadow Edit

A VS Code extension for private, per-file editing while agents continue to use the real working directory. Shadow Edit is opt-in. It never changes Git branches, the index, hooks, or agent workflows.

## Install and launch

Requires desktop VS Code 1.95 or newer. For development, use Node.js 22 or newer.

```sh
npm ci
npm run build
```

Open this project in VS Code and press **F5** (`Run Shadow Edit`). In the Extension Development Host, open the repository you want to edit. The launch configuration builds the extension before starting; breakpoints work through source maps.

To produce an installable package:

```sh
npm run package
```

In VS Code, run **Extensions: Install from VSIX…** and select `shadow-edit-0.1.4.vsix`. Installation does not shadow any files automatically.

## Use

1. Open a UTF-8 text file. Run **Shadow Edit: Start**, use the pencil in the editor title, or select Start from the tab context menu.
2. Edit the new private document. The tab has a purple **S** decoration, its URI path includes **Shadow**, and the purple status-bar indicator says **Shadow**. The purple follows your VS Code theme. Normal typing, undo/redo, find/replace, and Cmd+S/Ctrl+S use the native text editor. Saves go to extension storage.
3. Agents can edit, commit, or switch branches in the real repository. External changes update the status indicator, never your private document.
4. Use **Review Differences** for a native diff against a fresh disk snapshot. **Review Baseline** shows your changes since the last successful merge. Review snapshots are fixed; reopen Review to refresh.
5. Run **Merge & Stop** to merge and return to the real file, or **Merge & Continue** to merge and keep editing privately. Clean merges apply immediately without opening a review or resolution editor. Only conflicts open the private resolution document; reviewing differences beforehand is optional.

The status bar opens all session actions. Multiple files can have separate sessions. **Start** always creates a fresh session from the ordinary editor’s current text (including unsaved edits) and captures a new disk baseline. If a saved session already exists, confirm **Start Fresh** to archive the previous draft and replace it, or cancel to leave it untouched. **Resume** explicitly continues the saved private draft with its existing baseline. Starting again while already in that file’s shadow keeps the active session. Fresh sessions use distinct document URIs so VS Code cannot reuse an earlier buffer. Closing a private tab preserves its session; use **Resume** to reopen it.

**Starting with unsaved edits:** these are copied to private storage before opening the shadow. The original dirty tab remains open because the public API cannot silently retarget or discard that buffer. Close the original tab and choose **Don’t Save**. Do not save that original buffer unless you intend to change the real file. Merging is blocked while an ordinary buffer for the target is dirty.

### Conflicts

The merge compares the start/last-merge baseline, your private text, and current **disk contents**, independently of Git HEAD. Nonoverlapping line edits merge automatically, including a replacement next to an insertion. Overlapping edits produce a private **Resolution** document with MINE / BASE / THEIRS markers.

Edit that document into the complete desired result, remove the marker lines, and run **Apply Resolution**. Saving the resolution remains private. The native text editor and diff views are used; no undocumented Merge Editor API is required. Marker-like lines also block publishing if they were already in the source; remove them or use an ordinary manual workflow for such files.

**Cancel Merge** returns to your shadow and retains the draft. **Resume Resolution** reopens it. A subsequent merge asks before replacing a prior draft and archives it first. If the original or your shadow changes during resolution, applying is blocked; run Merge & Stop or Merge & Continue again against current contents. No unresolved markers are written to the real file.

### Stop, suspend, and recover

- **Merge & Stop:** publish a clean result and reopen the ordinary file.
- **Merge & Continue:** publish, update the baseline, and keep a private document.
- **Discard & Stop:** confirm before discarding unmerged work, keep a recovery archive, and reopen the ordinary file.
- **Suspend:** save private state and return to the real file; later use Resume.

Saved state survives restarts and extension-host crashes. Changes are also checkpointed on every document edit; a crash can still lose the last edits whose asynchronous checkpoint has not completed. Use Save to wait for persistence. VS Code's own dirty-editor recovery is an additional safeguard.

Private session JSON files live in VS Code's workspace storage (global storage for an empty window), outside the repository. Each contains the baseline, private contents, original URI, language, timestamps, and any resolution draft with its disk snapshot. Writes are serialized, flushed, and atomically replaced. An active-host lock prevents ordinary simultaneous use of the same storage by two hosts. **Open Recovery Storage** opens the directory. `history/` contains pre-publish snapshots, replaced resolutions, restarted sessions, and discarded sessions. These are intentionally retained; delete old archives manually when no longer needed. Storage is private to the OS user, not encrypted or hidden from processes with the same account.

If a file is renamed or deleted, the session remains recoverable; Shadow Edit does not guess its new location or recreate it. Restore the original path, or copy your private text to a file you choose. Workspace moves and storage/profile changes do not automatically migrate sessions. A malformed session stops loading and reports an error; files are retained for manual recovery.

## Concurrency guarantees

Before publication the extension saves a recovery snapshot containing BASE, MINE, THEIRS, and RESULT. It writes a temporary result **outside the repository**, flushes it, rereads the target, and compares its contents and filesystem identity/timestamps. A mismatch aborts. It then atomically renames the temporary file over the target and checks the result. It does not truncate the real file or fall back to a non-atomic copy.

This is optimistic concurrency, **not atomic compare-and-swap**. A noncooperating writer can change or replace the target between the final check and rename, or immediately afterward. An agent holding an old file descriptor can continue writing to the replaced inode. No standalone extension can eliminate those races. Recovery snapshots retain the versions observed by the extension, but cannot retain an unseen intervening write. If VS Code storage is on a different filesystem (`EXDEV`), publishing retries from a temporary owner-only directory outside all detected Git worktrees and open workspace folders. It tries the OS temporary directory, then eligible ancestor directories, and repeats the version/content check on each attempt. Temporary staging is removed afterward; saved sessions and recovery archives stay in VS Code storage. If the repository occupies an entire mount and no suitable directory outside it permits an atomic rename, merging fails safely with an explanation and retains private state. No copy-overwrite fallback or temporary file inside the repository is used. An abrupt host crash during fallback staging may leave a `.shadow-edit-publish-*` directory outside the repository; it can be removed once no merge is running. File permission bits are preserved; extended attributes, ACLs, and inode identity are not.

After merging, changes are ordinary working-directory edits. An agent's next `git add -A` may stage and commit them. Shadow Edit does not coordinate ownership after publication.

## Architecture and limits

- A writable `FileSystemProvider` serves `shadow-edit:` documents. A read-only `TextDocumentContentProvider` serves review snapshots. Public filesystem watchers monitor originals; actual disk reads at merge time are authoritative even if notifications are delayed or missed.
- The extension retains the language ID (Python, TypeScript, Markdown, etc.) and filename suffix. Syntax highlighting and native editor behavior work. Language-server features depend on each extension's document selector and URI support. Python/Pylance and TypeScript project diagnostics, imports, navigation, refactoring, debugging, and Markdown relative-link/preview behavior are **not guaranteed** on a custom scheme. No proxy forwards shadow edits into real-file language servers.
- Language tools, terminals, builds, search across the workspace, and agents still see real files. A language extension that edits other ordinary documents can change those files; isolation applies only to the private URI.
- Only Node-based desktop extension hosts, regular single-link `file:` files, UTF-8 text without BOM, and files up to 5 MiB are supported. Symlink files, hardlinks, binary/other encodings, web hosts, and arbitrary remote filesystem providers are rejected. SSH/containers are not validated in this MVP.
- Line-oriented merge uses `node-diff3` diff primitives with explicit overlap handling. Same-position insertions conflict; adjacent replacements/insertions are independent. Exact line endings and missing final newlines are retained in clean merges. Conflicting fragments may need a final-newline adjustment during manual resolution.
- Private saves run normal VS Code save hooks. Formatters or other installed extensions can affect private text. Save As / exporting can explicitly write a copy elsewhere; this is not a security sandbox.

API references used for the implementation:

- https://code.visualstudio.com/api/extension-guides/virtual-documents
- https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider
- https://code.visualstudio.com/api/extension-guides/virtual-workspaces
- https://code.visualstudio.com/api/references/commands

The public API cannot change a TextDocument's URI in place. This extension opens a separate native text document. No documented public API accepts arbitrary BASE/MINE/THEIRS inputs for the native Merge Editor, so it uses supported diff commands and a private editable resolution instead.

## Tests

```sh
npm test
npm run test:integration
```

Core tests exercise merge boundaries and conflicts, newline handling, persistence/recovery, failed writes, cancellation state, raced publication, cross-filesystem fallback and cleanup, permissions, and real Git commits. Integration tests launch an isolated VS Code instance and exercise native documents, saves, languages, multiple files, duplicate start, agent commits, undo/redo, merge/continue, conflicts, cancellation, stale resolutions, suspend/resume, merge/stop, unsaved initial buffers, and baseline recovery across a full VS Code restart. By default the runner downloads VS Code; set `VSCODE_EXECUTABLE_PATH` to use an installed executable. Test repositories and profiles are temporary and separate from your settings.
