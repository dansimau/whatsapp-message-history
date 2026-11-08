#!/usr/bin/env node
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { Archive } from './db.js';
import { startHttpServer } from './http.js';
import { log } from './logger.js';
import { ensureNoCow } from './nocow.js';
import { runStdioProxy } from './stdio-proxy.js';
import { WhatsAppClient } from './whatsapp.js';

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const USAGE = `whatsapp-message-history ${VERSION}

Usage:
  whatsapp-message-history serve   Run the archiver daemon with the MCP server over HTTP (default)
  whatsapp-message-history stdio   Expose the running daemon as a stdio MCP server (for clients that spawn servers)

Environment:
  WMH_DATA_DIR            Data directory (default ~/.whatsapp-message-history)
  WMH_HOST / WMH_PORT     MCP listen address (default 127.0.0.1:8765)
  WMH_AUTH_TOKEN          Optional bearer token required on /mcp
  WMH_SERVER_URL          Daemon URL for the stdio proxy (default http://HOST:PORT/mcp)
  WMH_SYNC_FULL_HISTORY   Request full history on link (default true)
  WMH_DOWNLOAD_MEDIA      Also download attachments into the data dir (default false)
  WMH_LOG_LEVEL           pino log level (default info)
`;

async function serve(): Promise<void> {
  const config = loadConfig();
  const nocow = await ensureNoCow(config.dataDir, config.dbPath);
  for (const w of nocow.warnings) log.warn({ nocow: true }, w);
  log.info({ dataDir: config.dataDir, filesystem: nocow.filesystem, nocowApplicable: nocow.applicable, directoryNoCow: nocow.directoryNoCow, rewritten: nocow.rewrittenFiles }, 'copy-on-write check done');

  const db = new Archive(config.dbPath);
  const client = new WhatsAppClient(config, db, log);
  const ctx = { client, db, config, nocow, startedAt: Date.now(), version: VERSION };
  const http = await startHttpServer(ctx, log);
  await client.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    http.close();
    await client.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'serve';
  switch (cmd) {
    case 'serve':
      await serve();
      break;
    case 'stdio':
      await runStdioProxy(loadConfig(), VERSION);
      break;
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      break;
    case '-v':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      break;
    default:
      process.stderr.write(`Unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => {
  log.fatal({ err }, 'fatal');
  process.exit(1);
});
