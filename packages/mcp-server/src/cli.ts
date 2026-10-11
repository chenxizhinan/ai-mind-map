#!/usr/bin/env tsx
/**
 * stdio MCP server 入口：
 *   npx ai-mind-map-mcp --file ./testcases.mindmap.json
 *
 * Claude 侧配置（claude_desktop_config.json / .mcp.json）：
 *   { "command": "npx", "args": ["-y", "tsx", "<repo>/packages/mcp-server/src/cli.ts",
 *                              "--file", "/path/to/testcases.mindmap.json"] }
 */
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRegistry, loadOrCreate } from './store.js';
import { registerTools } from './tools.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: './testcases.mindmap.json' },
  },
});

const registry = createRegistry();
const store = loadOrCreate(values.file, registry);
// loadOrCreate 已经建好 store，包一层惰性引用（未来支持多文档时在此扩展）
let current = store;

const server = new McpServer({ name: 'ai-mind-map', version: '0.1.0' });
registerTools(server, { store: () => current, filePath: values.file });

await server.connect(new StdioServerTransport());
