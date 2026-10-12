#!/usr/bin/env tsx
/**
 * 桥接服务 CLI：
 *   npx tsx packages/mcp-server/src/bridge-cli.ts --file ./testcases.mindmap.json --port 47214
 *
 * 应用侧（vite dev server 代理或直连）通过 REST/SSE 与之协作。
 */
import { parseArgs } from 'node:util';
import { loadOrCreate, createRegistry } from './store.js';
import { startBridge } from './bridge.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: './testcases.mindmap.json' },
    port: { type: 'string', default: '47214' },
    model: { type: 'string', default: 'claude-opus-5-5' },
  },
});

const registry = createRegistry();
let store = loadOrCreate(values.file, registry);

const bridge = startBridge({
  store: () => store,
  setStore: (s) => {
    store = s;
  },
  registry,
  filePath: values.file,
  port: Number(values.port),
  model: values.model,
});

console.log(`[ai-mind-map bridge] http://localhost:${values.port}  (file: ${values.file})`);
console.log('[ai-mind-map bridge] AI chat needs ANTHROPIC_API_KEY env (or run `ant auth login`)');
