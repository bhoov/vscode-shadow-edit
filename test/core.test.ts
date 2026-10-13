import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { merge, hasMarkers } from '../src/merge';
import { Store, Session, readReal, publish } from '../src/storage';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const file = path.join(repo, 'a.py'); await fs.writeFile(file, 'x = 1\n');
  const store = new Store(path.join(root, 'private')); await store.init();
  const s: Session = { id: 'test', originalUri: 'file://' + file, originalPath: file, language: 'python', base: 'x = 1\n', mine: 'x = 3\n', createdAt: 1, updatedAt: 2 };
  return { root, repo, file, store, s, cleanup: async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
test('merge preserves replacement plus adjacent append from prompt', () => {
  assert.deepEqual(merge('x = 1\n', 'x = 3\n', 'x = 1\ny = 2\n'), { content: 'x = 3\ny = 2\n', conflicts: 0 });
});
test('independent changes, deletion, repeated lines, identical edits, CRLF and final newline', () => {
  for (const [base, mine, theirs, expected] of [
    ['a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n', 'A\nb\nC\n'],
    ['a\nb\nc\n', 'a\nc\n', 'a\nb\nC\n', 'a\nC\n'],
    ['a\na\nb\n', 'z\na\nb\n', 'a\na\nB\n', 'z\na\nB\n'],
    ['a', 'b', 'b', 'b'], ['', 'a', '', 'a'],
    ['a\r\nb\r\n', 'A\r\nb\r\n', 'a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n'],
    ['a\nb', 'A\nb', 'a\nb', 'A\nb'],
    ['a\nb\n', 'A\nb\n', 'a\nB\n', 'A\nB\n'],
    ['a\nb\n', 'a\nX\nb\n', 'a\nB\n', 'a\nX\nB\n'],
  ]) assert.deepEqual(merge(base, mine, theirs), { content: expected, conflicts: 0 });
});
test('overlap and same-position insertions conflict and retain all three sides', () => {
  for (const [base, mine, theirs] of [['x=1\n', 'x=2\n', 'x=3\n'], ['', 'mine\n', 'theirs\n'], ['a\nb\nc\n', 'replacement\n', 'a\ninsert\nb\nc\n']]) {
    const r = merge(base, mine, theirs); assert.equal(r.conflicts, 1); assert.ok(hasMarkers(r.content)); assert.ok(r.content.includes('MINE')); assert.ok(r.content.includes('THEIRS'));
  }
});
test('merge identity properties over generated line edits', () => {
  for (let i = 0; i < 100; i++) {
    const base = Array.from({ length: i % 11 }, (_, n) => `${n}\n`).join('');
    const changed = `${i}\n${base.slice(i % (base.length + 1))}`;
    assert.deepEqual(merge(base, changed, base), { content: changed, conflicts: 0 });
    assert.deepEqual(merge(base, base, changed), { content: changed, conflicts: 0 });
    assert.deepEqual(merge(base, changed, changed), { content: changed, conflicts: 0 });
  }
});
test('A/B/C/F: private saves invisible to Git; external commits survive publication; other file is ordinary', async () => {
  const f = await fixture();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base');
    await f.store.save(f.s); assert.equal(git('status', '--porcelain'), ''); assert.equal(await fs.readFile(f.file, 'utf8'), f.s.base);
    await fs.writeFile(f.file, 'x = 1\ny = 2\n'); git('add', '.'); git('commit', '-qm', 'agent'); const head = git('rev-parse', 'HEAD');
    assert.equal((await f.store.load())[0].mine, 'x = 3\n');
    const theirs = await readReal(f.file); const result = merge(f.s.base, f.s.mine, theirs.content);
    await publish(f.file, theirs, result.content, f.store.root);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'x = 3\ny = 2\n'); assert.equal(git('rev-parse', 'HEAD'), head); assert.match(git('status', '--porcelain'), /M a.py/);
    await fs.writeFile(path.join(f.repo, 'b.py'), 'ordinary\n'); assert.match(git('status', '--porcelain'), /\?\? b.py/);
  } finally { await f.cleanup(); }
});
test('D/E: conflicts, cancelled resolution and pending state survive storage restart', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.file, 'x = 4\n'); const theirs = await readReal(f.file);
    const r = merge(f.s.base, f.s.mine, theirs.content); assert.equal(r.conflicts, 1);
    f.s.pending = { mine: f.s.mine, theirs, result: r.content, stop: true }; await f.store.save(f.s); await f.store.close();
    const reloaded = new Store(f.store.root); await reloaded.init();
    assert.deepEqual((await reloaded.load())[0], f.s); assert.equal(await fs.readFile(f.file, 'utf8'), 'x = 4\n');
    await publish(f.file, theirs, 'x = 7\n', reloaded.root); assert.equal(await fs.readFile(f.file, 'utf8'), 'x = 7\n'); await reloaded.close();
  } finally { await f.cleanup(); }
});
test('concurrent external modification before final check aborts without loss', async () => {
  const f = await fixture();
  try {
    await f.store.save(f.s); const expected = await readReal(f.file);
    await assert.rejects(publish(f.file, expected, f.s.mine, f.store.root, async () => { await fs.writeFile(f.file, 'new agent\n'); }), /changed during merging/);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'new agent\n'); assert.equal((await f.store.load())[0].mine, f.s.mine);
    assert.equal((await fs.readdir(f.store.root)).filter(x => x.startsWith('publish-')).length, 0);
  } finally { await f.cleanup(); }
});
test('failed publication, deletion and invalid encoding preserve private state', async () => {
  const f = await fixture();
  try {
    await f.store.save(f.s); const expected = await readReal(f.file);
    await assert.rejects(publish(f.file, expected, f.s.mine, '/no-such-shadow-storage')); assert.equal(await fs.readFile(f.file, 'utf8'), f.s.base);
    await fs.unlink(f.file); await assert.rejects(publish(f.file, expected, f.s.mine, f.store.root));
    assert.equal((await f.store.load())[0].mine, f.s.mine);
    await fs.writeFile(f.file, Buffer.from([0xff])); await assert.rejects(readReal(f.file), /UTF-8/);
    await fs.writeFile(f.file, '\uFEFFtext'); await assert.rejects(readReal(f.file), /BOM/);
    await assert.rejects(publish(f.file, expected, 'a'.repeat(5 * 1024 * 1024 + 1), f.store.root), /5 MiB/);
  } finally { await f.cleanup(); }
});
test('queued snapshots persist in order; archives retain prior state; concurrent store blocked', async () => {
  const f = await fixture();
  try {
    await assert.rejects(new Store(f.store.root).init(), /already open/);
    const writes = [];
    for (let i = 0; i < 20; i++) { f.s.mine = String(i); writes.push(f.store.save(f.s)); }
    await Promise.all(writes); assert.equal((await f.store.load())[0].mine, '19');
    await f.store.archive(f.s, 'test'); await f.store.remove(f.s); assert.deepEqual(await f.store.load(), []);
    assert.equal((await fs.readdir(path.join(f.store.root, 'history'))).length, 1);
  } finally { await f.cleanup(); }
});
test('permissions survive atomic publication; symlinks and hardlinks are rejected', async () => {
  const f = await fixture();
  try {
    await fs.chmod(f.file, 0o755); await publish(f.file, await readReal(f.file), 'new\n', f.store.root); assert.equal((await fs.stat(f.file)).mode & 0o777, 0o755);
    const link = path.join(f.repo, 'link'); await fs.symlink(f.file, link); await assert.rejects(readReal(link), /regular files/);
    await fs.link(f.file, path.join(f.repo, 'hard')); await assert.rejects(readReal(f.file), /regular files/);
  } finally { await f.cleanup(); }
});

test('EXDEV retries outside the Git worktree and cleans private staging after success', async () => {
  const f = await fixture();
  const native = require('node:fs/promises') as typeof fs;
  const rename = native.rename;
  const staged: string[] = [];
  let checks = 0;
  const previousTmp = process.env.TMPDIR;
  try {
    execFileSync('git', ['-C', f.repo, 'init', '-q']);
    // Even a temp directory configured inside the worktree must be excluded.
    process.env.TMPDIR = f.repo;
    const canonicalRepo = await fs.realpath(f.repo);
    await f.store.save(f.s);
    native.rename = async (from, to) => {
      const source = String(from); staged.push(source);
      if (path.dirname(source) === f.store.root) throw Object.assign(new Error('simulated cross-device rename'), { code: 'EXDEV' });
      assert.ok(!source.startsWith(canonicalRepo + path.sep));
      assert.equal((await fs.stat(path.dirname(source))).mode & 0o777, 0o700);
      await rename(from, to);
    };
    await publish(f.file, await readReal(f.file), f.s.mine, f.store.root, async () => { checks++; });
    assert.equal(checks, 2); assert.equal(staged.length, 2);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.s.mine);
    assert.equal((await f.store.load())[0].mine, f.s.mine);
    for (const file of staged) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(staged[1])), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(f.repo)).sort(), ['.git', 'a.py']);
  } finally {
    native.rename = rename;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    await f.cleanup();
  }
});

test('EXDEV retry rechecks newer external edits and retains the private session', async () => {
  const f = await fixture();
  const native = require('node:fs/promises') as typeof fs;
  const rename = native.rename;
  let checks = 0;
  try {
    await f.store.save(f.s);
    native.rename = async (from, to) => {
      if (path.dirname(String(from)) === f.store.root) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      await rename(from, to);
    };
    await assert.rejects(publish(f.file, await readReal(f.file), f.s.mine, f.store.root, async () => {
      if (++checks === 2) await fs.writeFile(f.file, 'newer agent text\n');
    }, [f.repo]), /changed during merging/);
    assert.equal(checks, 2);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'newer agent text\n');
    assert.equal((await f.store.load())[0].mine, f.s.mine);
  } finally { native.rename = rename; await f.cleanup(); }
});

test('publication errors other than EXDEV fail without attempting a fallback', async () => {
  const f = await fixture();
  const native = require('node:fs/promises') as typeof fs;
  const rename = native.rename;
  let attempts = 0;
  try {
    native.rename = async () => { attempts++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    await assert.rejects(publish(f.file, await readReal(f.file), f.s.mine, f.store.root), { code: 'EACCES' });
    assert.equal(attempts, 1); assert.equal(await fs.readFile(f.file, 'utf8'), f.s.base);
  } finally { native.rename = rename; await f.cleanup(); }
});

test('real cross-device publication on Linux with /dev/shm', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  let separate: string | undefined;
  try {
    separate = await fs.mkdtemp('/dev/shm/shadow-cross-device-');
    assert.notEqual((await fs.stat(separate)).dev, (await fs.stat(f.file)).dev);
    await publish(f.file, await readReal(f.file), f.s.mine, separate, undefined, [f.repo]);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.s.mine);
    assert.deepEqual(await fs.readdir(separate), []);
  } finally { if (separate) await fs.rm(separate, { recursive: true, force: true }); await f.cleanup(); }
});

test('no writable staging location leaves the original and private session intact', async () => {
  const f = await fixture();
  const native = require('node:fs/promises') as typeof fs;
  const rename = native.rename, mkdtemp = native.mkdtemp;
  try {
    await f.store.save(f.s);
    native.rename = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    native.mkdtemp = async () => { throw Object.assign(new Error('read-only mount'), { code: 'EROFS' }); };
    await assert.rejects(publish(f.file, await readReal(f.file), f.s.mine, f.store.root, undefined, [f.repo]), /no writable staging directory/);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.s.base);
    assert.equal((await f.store.load())[0].mine, f.s.mine);
  } finally { native.rename = rename; native.mkdtemp = mkdtemp; await f.cleanup(); }
});
