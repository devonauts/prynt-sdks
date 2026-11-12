#!/usr/bin/env node
/**
 * stdio entry point: `prynt-mcp`. Reads PRYNT_SECRET_KEY and PRYNT_ENDPOINT from the
 * environment. stdout carries the MCP protocol, so diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { createPryntMcpServer } from './server.js';

async function main(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[prynt-mcp] ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  for (const w of loaded.warnings) process.stderr.write(`[prynt-mcp] warning: ${w}\n`);

  const server = createPryntMcpServer(loaded.config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[prynt-mcp] ready (endpoint ${loaded.config.endpoint})\n`);
}

main().catch((e) => {
  process.stderr.write(`[prynt-mcp] fatal: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
