#!/usr/bin/env tsx
/**
 * 桥接服务 CLI：
 *   多文档：npx tsx packages/mcp-server/src/bridge-cli.ts --dir ./mindmaps --port 47214
 *   单文档（兼容）：npx tsx packages/mcp-server/src/bridge-cli.ts --file doc.json --port 47214
 *
 * 应用侧（vite dev server 代理或直连）通过 REST/SSE 与之协作。
 */
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRegistry } from './store.js';
import { loadOrCreate } from './store.js';
import { startBridge } from './bridge.js';
import { DirDocManager } from './doc-manager.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    dir: { type: 'string' },
    port: { type: 'string', default: '47214' },
    model: { type: 'string', default: 'claude-opus-5-5' },
  },
});

const registry = createRegistry();
let handle;

if (values.dir) {
  const dir = resolve(values.dir);
  mkdirSync(dir, { recursive: true });
  const docs = new DirDocManager(registry, dir);
  handle = startBridge({ docs, registry, port: Number(values.port), model: values.model });
  console.log(`[ai-mind-map bridge] http://localhost:${values.port}  (dir: ${dir})`);
} else {
  const fp = values.file ?? './testcases.mindmap.json';
  let store = loadOrCreate(fp, registry);
  handle = startBridge({
    store: () => store,
    setStore: (s) => {
      store = s;
    },
    registry,
    filePath: fp,
    port: Number(values.port),
    model: values.model,
  });
  console.log(`[ai-mind-map bridge] http://localhost:${values.port}  (file: ${resolve(fp)})  [单文档模式]`);
}

console.log('[ai-mind-map bridge] AI chat needs ANTHROPIC_API_KEY env (or run `ant auth login`)');
void handle;
