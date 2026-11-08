/**
 * Hosts the MCP server over Streamable HTTP on a local port, one McpServer
 * instance per MCP session, plus a /health endpoint.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { buildMcpServer, type McpContext } from './mcp.js';

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startHttpServer(ctx: McpContext, log: Logger): Promise<http.Server> {
  const { config } = ctx;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/health') {
        const link = ctx.client.status();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: link.state, account: link.account?.jid ?? null, messages: ctx.db.stats().messages }));
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (config.authToken) {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${config.authToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
          return;
        }
      }
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
      if (existing) {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await existing.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null }));
        return;
      }
      const body = await readJsonBody(req);
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: expected initialize request' }, id: null }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          log.debug({ sessionId: id }, 'mcp session started');
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = buildMcpServer(ctx);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error({ err }, 'http request failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      log.info({ url: `http://${config.host}:${config.port}/mcp` }, 'MCP server listening');
      resolve(server);
    });
  });
}
