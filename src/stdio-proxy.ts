/**
 * A thin stdio MCP server that forwards every tool call to the running daemon.
 * For MCP clients that can only spawn stdio servers.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';

export async function runStdioProxy(config: Config, version: string): Promise<void> {
  const headers: Record<string, string> = config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {};
  const client = new Client({ name: 'whatsapp-message-history-stdio', version });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.serverUrl), { requestInit: { headers } }));
  } catch (err) {
    throw new Error(`Could not reach the whatsapp-message-history daemon at ${config.serverUrl}: ${(err as Error).message}. Start it with "whatsapp-message-history serve".`);
  }

  const server = new Server({ name: 'whatsapp-message-history', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await client.callTool(req.params)) as CallToolResult);
  server.onclose = () => {
    void client.close();
  };
  await server.connect(new StdioServerTransport());
}
