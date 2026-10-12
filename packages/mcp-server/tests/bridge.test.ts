import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore, NodeTypeRegistry, registerBuiltinTypes } from '@ai-mind-map/core';
import { startBridge } from '../src/bridge.js';

function makeRegistry(): NodeTypeRegistry {
  const r = new NodeTypeRegistry();
  registerBuiltinTypes(r);
  return r;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aimm-bridge-'));
  const filePath = join(dir, 'testcases.mindmap.json');
  const registry = makeRegistry();
  let store = new DocStore(registry, {
    meta: { title: 't', updatedAt: new Date().toISOString() },
  });
  const handle = startBridge({
    store: () => store,
    setStore: (s) => {
      store = s;
    },
    registry,
    filePath,
    port: 0,
  });
  const ready = handle.ready;
  return { handle, ready, filePath, dir, getStore: () => store };
}

const cleanupDirs: string[] = [];
const openHandles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (openHandles.length) await openHandles.pop()!.close();
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe('bridge', () => {
  it('GET /doc returns document JSON', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const res = await fetch(`http://localhost:${port}/doc`);
    expect(res.ok).toBe(true);
    const d = (await res.json()) as { meta: { title: string } };
    expect(d.meta.title).toBe('t');
  });

  it('PUT /doc persists and replaces store', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const s = ctx.getStore();
    s.addSubtree(s.root.id, { type: 'folder', text: 'm', children: [{ type: 'case', text: 'c' }] });
    const res = await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s.toJSON()),
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(readFileSync(ctx.filePath, 'utf8')).tree.children[0].text).toBe('m');
  });

  it('PUT /doc rejects invalid props', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const s = ctx.getStore();
    const bad = JSON.parse(JSON.stringify(s.toJSON())) as Record<string, unknown>;
    (bad.tree as { children: unknown[] }).children = [
      { id: 'n_x', type: 'case', text: 'bad', props: { priority: 'PX' }, children: [] },
    ];
    const res = await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(res.ok).toBe(false);
  });

  it('SSE clients receive changed events on PUT', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;

    // Node 无内置 EventSource：手写 SSE 客户端（fetch 流式读）
    const sseChanged = (async () => {
      const res = await fetch(`http://localhost:${port}/events`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'timeout';
        buf += dec.decode(value, { stream: true });
        if (buf.includes('event: changed')) return 'changed';
      }
    })();

    const s = ctx.getStore();
    s.addSubtree(s.root.id, { type: 'folder', text: 'x' });
    await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s.toJSON()),
    });
    expect(await sseChanged).toBe('changed');
  });

  it('external file change triggers reload and broadcast', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;

    // setup 的 store 只在内存：先落盘（此时 SSE 尚未连接，避免收到 PUT 的广播）
    const s = ctx.getStore();
    await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s.toJSON()),
    });

    // 连接 SSE 并等 hello（确认已注册）
    const sseChanged = (async () => {
      const res = await fetch(`http://localhost:${port}/events`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'timeout';
        buf += dec.decode(value, { stream: true });
        if (buf.includes('event: changed')) return 'changed';
      }
    })();
    await new Promise((r) => setTimeout(r, 100));

    // 模拟外部改文件（内容 + mtime 前移）
    const raw = readFileSync(ctx.filePath, 'utf8');
    writeFileSync(ctx.filePath, raw.replace('"title": "t"', '"title": "T2"'), 'utf8');
    utimesSync(ctx.filePath, new Date(Date.now() + 3000), new Date(Date.now() + 3000));
    expect(await sseChanged).toBe('changed');
    const d = (await (await fetch(`http://localhost:${port}/doc`)).json()) as { meta: { title: string } };
    expect(d.meta.title).toBe('T2');
  });
});
