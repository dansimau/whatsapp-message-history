import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** Root directory for everything this app persists. */
  dataDir: string;
  /** Baileys multi-file auth state (the linked-device credentials). */
  sessionDir: string;
  /** SQLite archive. */
  dbPath: string;
  /** Downloaded media (only when downloadMedia is on). */
  mediaDir: string;
  host: string;
  port: number;
  /** Optional bearer token required on the MCP endpoint. */
  authToken?: string;
  /** Download attachments to mediaDir in addition to recording metadata. */
  downloadMedia: boolean;
  /** Ask WhatsApp for the full history on link (backfills the archive). */
  syncFullHistory: boolean;
  /** Daemon URL used by the stdio proxy. */
  serverUrl: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.WMH_DATA_DIR ?? path.join(os.homedir(), '.whatsapp-message-history'));
  const host = env.WMH_HOST ?? '127.0.0.1';
  const port = Number.parseInt(env.WMH_PORT ?? '8765', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`WMH_PORT must be a valid TCP port, got ${JSON.stringify(env.WMH_PORT)}`);
  }
  return {
    dataDir,
    sessionDir: path.join(dataDir, 'session'),
    dbPath: path.join(dataDir, 'messages.db'),
    mediaDir: path.join(dataDir, 'media'),
    host,
    port,
    authToken: env.WMH_AUTH_TOKEN || undefined,
    downloadMedia: bool(env.WMH_DOWNLOAD_MEDIA, false),
    syncFullHistory: bool(env.WMH_SYNC_FULL_HISTORY, true),
    serverUrl: env.WMH_SERVER_URL ?? `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`,
  };
}
