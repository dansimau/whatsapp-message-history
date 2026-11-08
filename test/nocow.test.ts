import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureNoCow, hasNoCowFlag, parseLsattrFlags, type CommandRunner } from '../src/nocow.js';

const COW = '---------------------- /data';
const NOCOW = '---------------C------ /data';

test('lsattr parsing', () => {
  assert.equal(parseLsattrFlags(NOCOW), '---------------C------');
  assert.equal(hasNoCowFlag(NOCOW), true);
  assert.equal(hasNoCowFlag(COW), false);
  assert.equal(hasNoCowFlag(''), false);
});

function fakeRunner(opts: { fsType?: string; dirNoCow: boolean; fileNoCow: boolean }): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  let dirNoCow = opts.dirNoCow;
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'stat') return { stdout: `${opts.fsType ?? 'btrfs'}\n` };
    if (cmd === 'chattr') {
      dirNoCow = true;
      return { stdout: '' };
    }
    if (cmd === 'lsattr') {
      const target = args[args.length - 1]!;
      if (args[0] === '-d') return { stdout: dirNoCow ? NOCOW : COW };
      // files created after the directory got +C inherit it
      const createdAfter = fs.statSync(target).ctimeMs > (globalThis as { __dirChangedAt?: number }).__dirChangedAt!;
      return { stdout: opts.fileNoCow || (dirNoCow && createdAfter) ? NOCOW : COW };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmh-nocow-'));
}

test('not applicable off linux', async () => {
  const dir = tempDir();
  const { run, calls } = fakeRunner({ dirNoCow: false, fileNoCow: false });
  const r = await ensureNoCow(dir, path.join(dir, 'messages.db'), { run, platform: 'darwin' });
  assert.equal(r.applicable, false);
  assert.deepEqual(calls, []);
});

test('not applicable on non-btrfs filesystems', async () => {
  const dir = tempDir();
  const { run, calls } = fakeRunner({ fsType: 'ext2/ext3', dirNoCow: false, fileNoCow: false });
  const r = await ensureNoCow(dir, path.join(dir, 'messages.db'), { run, platform: 'linux' });
  assert.equal(r.applicable, false);
  assert.equal(r.filesystem, 'ext2/ext3');
  assert.deepEqual(calls, [`stat -f -c %T ${dir}`]);
});

test('sets NOCOW on the directory before the database exists', async () => {
  const dir = tempDir();
  const { run, calls } = fakeRunner({ dirNoCow: false, fileNoCow: false });
  const r = await ensureNoCow(dir, path.join(dir, 'messages.db'), { run, platform: 'linux' });
  assert.equal(r.applicable, true);
  assert.equal(r.directoryChanged, true);
  assert.equal(r.directoryNoCow, true);
  assert.deepEqual(r.rewrittenFiles, []);
  assert.ok(calls.includes(`chattr +C ${dir}`));
});

test('rewrites an existing CoW database into a NOCOW inode', async () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'messages.db');
  fs.writeFileSync(dbPath, 'sqlite-bytes');
  fs.writeFileSync(`${dbPath}-wal`, 'wal');
  (globalThis as { __dirChangedAt?: number }).__dirChangedAt = Date.now() + 1; // files written above count as "before"
  const { run } = fakeRunner({ dirNoCow: false, fileNoCow: false });
  let checkpointed = false;
  const r = await ensureNoCow(dir, dbPath, {
    run,
    platform: 'linux',
    checkpoint: async () => {
      checkpointed = true;
    },
  });
  assert.equal(checkpointed, true, 'WAL is checkpointed before the rewrite');
  assert.deepEqual(r.rewrittenFiles, [dbPath]);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'sqlite-bytes', 'content preserved');
  assert.equal(fs.existsSync(`${dbPath}-wal`), false, 'stale sidecars removed');
  assert.equal(fs.readdirSync(dir).some((f) => f.includes('.tmp')), false, 'no temp files left behind');
});

test('leaves an already NOCOW database alone', async () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'messages.db');
  fs.writeFileSync(dbPath, 'x');
  const { run } = fakeRunner({ dirNoCow: true, fileNoCow: true });
  const r = await ensureNoCow(dir, dbPath, { run, platform: 'linux', checkpoint: async () => assert.fail('must not checkpoint') });
  assert.equal(r.directoryChanged, false);
  assert.deepEqual(r.rewrittenFiles, []);
  assert.deepEqual(r.warnings, []);
});
