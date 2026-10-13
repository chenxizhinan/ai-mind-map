#!/usr/bin/env tsx
/**
 * stdio MCP server 入口：
 *   多文档：npx tsx <repo>/packages/mcp-server/src/cli.ts --dir ./mindmaps
 *   单文档（兼容）：npx tsx <repo>/packages/mcp-server/src/cli.ts --file ./testcases.mindmap.json
 *
 * Claude 侧配置（claude_desktop_config.json / .mcp.json）：
 *   { "command": "npx", "args": ["-y", "tsx", "<repo>/packages/mcp-server/src/cli.ts",
 *                              "--dir", "/path/to/mindmaps"] }
 */
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRegistry, loadOrCreate } from './store.js';
import { registerTools } from './tools.js';
import { DirDocManager } from './doc-manager.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    dir: { type: 'string' },
  },
});

const registry = createRegistry();
const server = new McpServer({ name: 'ai-mind-map', version: '0.2.0' });

if (values.dir) {
  const dir = resolve(values.dir);
  mkdirSync(dir, { recursive: true });
  const docs = new DirDocManager(registry, dir);
  registerTools(server, { docs });
  console.error(`[ai-mind-map mcp] dir mode: ${dir}`);
} else {
  const fp = values.file ?? './testcases.mindmap.json';
  const store = loadOrCreate(fp, registry);
  let current = store;
  registerTools(server, {
    store: () => current,
    filePath: fp,
  });
  console.error(`[ai-mind-map mcp] file mode: ${resolve(fp)}  [单文档模式]`);
}

await server.connect(new StdioServerTransport());
