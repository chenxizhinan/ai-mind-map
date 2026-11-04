/**
 * MCP server：把 DocStore 暴露为增量构建工具。
 *
 * 形态：stdio 传输的本地进程；数据持久化到单个 JSON 文件
 * （--file 参数，默认 ./testcases.mindmap.json），脑图应用监听该文件刷新。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DocStore,
  NodeTypeRegistry,
  registerBuiltinTypes,
} from '@ai-mind-map/core';

export interface PersistedState {
  store: DocStore;
  registry: NodeTypeRegistry;
  filePath: string;
}

export function createRegistry(customTypes?: (r: NodeTypeRegistry) => void): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  registerBuiltinTypes(registry);
  customTypes?.(registry);
  return registry;
}

/** 加载或创建文档；每次工具调用后由 save() 落盘 */
export function loadOrCreate(filePath: string, registry: NodeTypeRegistry): DocStore {
  const abs = resolve(filePath);
  if (existsSync(abs)) {
    const raw = JSON.parse(readFileSync(abs, 'utf8'));
    return DocStore.fromJSON(registry, raw);
  }
  const store = new DocStore(registry, {
    meta: { title: '测试用例导图', updatedAt: new Date().toISOString() },
  });
  save(store, abs);
  return store;
}

export function save(store: DocStore, filePath: string): void {
  const abs = resolve(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  // 版本戳：每次落盘刷新 meta.updatedAt。它是浏览器 PUT /doc/:id（If-Match 乐观锁）
  // 与多端并发写同一文档时的版本基准——后写者版本过期会收到 409，而不是静默覆盖他人修改。
  store.document.meta.updatedAt = new Date().toISOString();
  writeFileSync(abs, JSON.stringify(store.toJSON(), null, 2), 'utf8');
}

export { DocStore, NodeTypeRegistry, registerBuiltinTypes };
