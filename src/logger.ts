import pino from 'pino';

// Always log to stderr: stdout must stay clean for the stdio MCP transport.
export const log = pino(
  { level: process.env.WMH_LOG_LEVEL ?? 'info' },
  pino.destination({ dest: 2, sync: false }),
);
