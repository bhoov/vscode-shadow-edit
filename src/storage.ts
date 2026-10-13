import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Snapshot { content: string; version: string; mode: number }
export interface Pending { id?: string; mine: string; theirs: Snapshot; result: string; stop: boolean }
export interface Session {
  id: string; originalUri: string; originalPath: string; language: string;
  base: string; mine: string; createdAt: number; updatedAt: number; pending?: Pending;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID();
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}
export class Store {
  private queue: Promise<void> = Promise.resolve();
  private lock?: fs.FileHandle;
  constructor(readonly root: string) {}
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, 'lock');
    try { this.lock = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Private storage is locked. Inspect its lock file before retrying.');
      try { process.kill(pid, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(file); return this.init(); }
      }
      throw new Error('Shadow Edit is already open for this workspace in another extension host.');
    }
    await this.lock.writeFile(String(process.pid));
  }
  async load(): Promise<Session[]> {
    const result: Session[] = [];
    for (const name of await fs.readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      const s = JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')) as Session;
      if (typeof s.id !== 'string' || name !== s.id + '.json' || typeof s.originalPath !== 'string' || typeof s.originalUri !== 'string' || typeof s.base !== 'string' || typeof s.mine !== 'string') throw new Error('Invalid session: ' + name + '. Files retained for recovery.');
      result.push(s);
    }
    return result;
  }
  save(s: Session): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(s));
    const task = this.queue.then(() => atomicJson(path.join(this.root, s.id + '.json'), snapshot));
    this.queue = task.catch(() => {});
    return task;
  }
  async archive(s: Session, reason: string): Promise<void> {
    await this.queue;
    await atomicJson(path.join(this.root, 'history', `${s.id}-${Date.now()}-${randomUUID()}-${reason}.json`), s);
  }
  async remove(s: Session): Promise<void> {
    await this.queue;
    await fs.unlink(path.join(this.root, s.id + '.json'));
  }
  async close(): Promise<void> {
    await this.queue;
    if (this.lock) { await this.lock.close(); await fs.unlink(path.join(this.root, 'lock')); this.lock = undefined; }
  }
}

export async function readReal(file: string): Promise<Snapshot> {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error('Only regular files with one hard link are supported (no symlinks).');
  if (before.size > 5n * 1024n * 1024n) throw new Error('Files over 5 MiB are not supported.');
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file, { bigint: true });
  const stamp = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;
  if (stamp(before) !== stamp(after)) throw new Error('File changed while reading. Retry.');
  const content = bytes.toString('utf8');
  if (content.includes('\0') || !Buffer.from(content).equals(bytes)) throw new Error('Only UTF-8 text files are supported.');
  if (content.startsWith('\uFEFF')) throw new Error('UTF-8 BOM files are not supported. Convert to UTF-8 without BOM before starting.');
  return { content, version: stamp(after), mode: Number(after.mode) };
}
export async function publish(file: string, expected: Snapshot, result: string, storage: string, beforeCheck?: () => Promise<void>): Promise<void> {
  if (Buffer.byteLength(result) > 5 * 1024 * 1024 || result.includes('\0') || result.startsWith('\uFEFF')) throw new Error('Result must be UTF-8 text without BOM or NUL and at most 5 MiB. Private state retained.');
  const temp = path.join(storage, 'publish-' + randomUUID());
  try {
    const handle = await fs.open(temp, 'wx', expected.mode & 0o777);
    try { await handle.writeFile(result, 'utf8'); await handle.chmod(expected.mode & 0o777); await handle.sync(); } finally { await handle.close(); }
    await beforeCheck?.();
    const now = await readReal(file);
    if (now.version !== expected.version || now.content !== expected.content) throw new Error('The real file changed during merging. Private edits and resolution are preserved. Review & Merge again.');
    // Atomic replacement, but not a compare-and-swap: a noncooperating writer can
    // still race the final check. EXDEV fails safely; never fall back to truncation.
    await fs.rename(temp, file);
    if ((await readReal(file)).content !== result) throw new Error('The real file changed immediately after publishing. Recovery snapshots are retained.');
  } finally { await fs.rm(temp, { force: true }); }
}
