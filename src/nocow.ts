/**
 * Copy-on-write guard for the SQLite archive.
 *
 * On btrfs, a database file that is subject to copy-on-write fragments badly:
 * every page write lands in a fresh extent, and a long-lived, append-heavy
 * SQLite file ends up with hundreds of thousands of extents. The standard
 * remedy is the NOCOW attribute (`chattr +C`). It only takes effect on empty
 * files, so the reliable way to apply it is to set it on the directory before
 * the database is created; new files then inherit it.
 *
 * `ensureNoCow` runs before the database is opened:
 *   1. If we are not on Linux, or the data directory is not on btrfs, nothing
 *      needs doing (other filesystems either have no CoW or cannot disable it
 *      per file).
 *   2. Make sure the data directory carries the NOCOW attribute.
 *   3. If a database file already exists *with* CoW, checkpoint it, rewrite it
 *      into a fresh file (which inherits NOCOW from the directory) and atomically
 *      swap it in.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CommandRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface NoCowOptions {
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  /** Checkpoint and close a SQLite db so no -wal/-shm sidecars remain. */
  checkpoint?: (dbPath: string) => Promise<void>;
}

export interface NoCowReport {
  platform: NodeJS.Platform;
  filesystem?: string;
  /** True when the data dir lives on btrfs and the guard applies. */
  applicable: boolean;
  directoryNoCow?: boolean;
  directoryChanged: boolean;
  rewrittenFiles: string[];
  warnings: string[];
}

const defaultRunner: CommandRunner = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
  return { stdout: String(stdout) };
};

async function defaultCheckpoint(dbPath: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** The attribute flags column of `lsattr` output, e.g. `---------------C------`. */
export function parseLsattrFlags(output: string): string {
  const line = output.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().split(/\s+/)[0] ?? '';
}

export function hasNoCowFlag(output: string): boolean {
  return parseLsattrFlags(output).includes('C');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite `file` into a new inode in the same directory (inheriting NOCOW) and swap it in. */
async function rewriteInPlace(file: string): Promise<void> {
  const tmp = `${file}.nocow-${process.pid}.tmp`;
  await fs.copyFile(file, tmp, fs.constants.COPYFILE_EXCL);
  const handle = await fs.open(tmp, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export async function ensureNoCow(dataDir: string, dbPath: string, options: NoCowOptions = {}): Promise<NoCowReport> {
  const run = options.run ?? defaultRunner;
  const platform = options.platform ?? process.platform;
  const checkpoint = options.checkpoint ?? defaultCheckpoint;
  const report: NoCowReport = { platform, applicable: false, directoryChanged: false, rewrittenFiles: [], warnings: [] };

  await fs.mkdir(dataDir, { recursive: true });
  if (platform !== 'linux') return report;

  try {
    report.filesystem = (await run('stat', ['-f', '-c', '%T', dataDir])).stdout.trim();
  } catch (err) {
    report.warnings.push(`could not determine filesystem type: ${(err as Error).message}`);
    return report;
  }
  if (report.filesystem !== 'btrfs') return report;
  report.applicable = true;

  // 1. The directory: new files inherit NOCOW from it.
  try {
    let dirFlags = (await run('lsattr', ['-d', dataDir])).stdout;
    if (!hasNoCowFlag(dirFlags)) {
      await run('chattr', ['+C', dataDir]);
      report.directoryChanged = true;
      dirFlags = (await run('lsattr', ['-d', dataDir])).stdout;
    }
    report.directoryNoCow = hasNoCowFlag(dirFlags);
    if (!report.directoryNoCow) report.warnings.push(`NOCOW attribute could not be set on ${dataDir}`);
  } catch (err) {
    report.warnings.push(`could not set NOCOW on ${dataDir}: ${(err as Error).message}`);
    return report;
  }

  // 2. An existing database created before the directory had NOCOW.
  if (await exists(dbPath)) {
    try {
      const dbFlags = (await run('lsattr', [dbPath])).stdout;
      if (!hasNoCowFlag(dbFlags)) {
        await checkpoint(dbPath); // leaves no -wal/-shm behind
        for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
          if (await exists(sidecar)) await fs.unlink(sidecar);
        }
        await rewriteInPlace(dbPath);
        report.rewrittenFiles.push(dbPath);
        if (!hasNoCowFlag((await run('lsattr', [dbPath])).stdout)) {
          report.warnings.push(`${path.basename(dbPath)} was rewritten but still reports CoW enabled`);
        }
      }
    } catch (err) {
      report.warnings.push(`could not disable CoW on ${dbPath}: ${(err as Error).message}`);
    }
  }
  return report;
}
