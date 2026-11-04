import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
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

  it('PUT /doc enforces If-Match in single-file mode', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const v1 = ctx.getStore().document.meta.updatedAt;

    const stale = await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '2000-01-01T00:00:00.000Z' },
      body: JSON.stringify(ctx.getStore().toJSON()),
    });
    expect(stale.status).toBe(409);

    const good = await fetch(`http://localhost:${port}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': v1 },
      body: JSON.stringify(ctx.getStore().toJSON()),
    });
    expect(good.ok).toBe(true);
    const r = (await good.json()) as { updatedAt?: string };
    expect(r.updatedAt).toBeTruthy();
    // 落盘后版本被 save() 刷新
    expect(JSON.parse(readFileSync(ctx.filePath, 'utf8')).meta.updatedAt).toBe(r.updatedAt);
  });

  it('PUT /doc preserves UTF-8 text when request chunks split a Chinese character', async () => {
    const ctx = setup();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const s = ctx.getStore();
    s.addSubtree(s.root.id, { type: 'folder', text: '迁移状态与页面恢复' });
    const body = Buffer.from(JSON.stringify(s.toJSON()), 'utf8');
    const marker = Buffer.from('迁', 'utf8');
    const markerOffset = body.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    const splitAt = markerOffset + 1;

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/doc',
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(body.subarray(0, splitAt));
      setTimeout(() => req.end(body.subarray(splitAt)), 10);
    });

    expect(status).toBe(200);
    expect(JSON.parse(readFileSync(ctx.filePath, 'utf8')).tree.children[0].text).toBe('迁移状态与页面恢复');
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

// ---------- 多文档（--dir）模式 ----------

import { mkdirSync, readdirSync } from 'node:fs';
import { DirDocManager } from '../src/doc-manager.js';
import type { AnthropicLike } from '../src/tool-loop.js';

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aimm-bridge-dir-'));
  const docsDir = join(dir, 'mindmaps');
  mkdirSync(docsDir, { recursive: true });
  const registry = makeRegistry();
  const docs = new DirDocManager(registry, docsDir);
  const handle = startBridge({ docs, registry, port: 0 });
  return { handle, ready: handle.ready, docsDir, docs, dir };
}

function minimalDoc(title: string): unknown {
  return {
    version: 1,
    meta: { title, updatedAt: new Date().toISOString() },
    tree: { id: 'n_0001', type: 'folder', text: title, props: {}, children: [] },
    annotations: [],
  };
}

/** 收集下一条 changed 事件的 data 负载 */
function nextChangedData(port: number): Promise<string> {
  return (async () => {
    const res = await fetch(`http://localhost:${port}/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 'timeout';
      buf += dec.decode(value, { stream: true });
      const idx = buf.indexOf('event: changed\ndata: ');
      if (idx >= 0) {
        const tail = buf.slice(idx + 'event: changed\ndata: '.length);
        const end = tail.indexOf('\n\n');
        return end >= 0 ? tail.slice(0, end) : 'timeout';
      }
    }
  })();
}

describe('bridge dir mode (multi-doc)', () => {
  it('GET /docs lists pre-seeded docs with nodeCount', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    writeFileSync(join(ctx.docsDir, '甲.mindmap.json'), JSON.stringify(minimalDoc('甲')));
    writeFileSync(join(ctx.docsDir, '乙.mindmap.json'), JSON.stringify(minimalDoc('乙')));
    const port = await ctx.ready;
    await new Promise((r) => setTimeout(r, 1200)); // 等首轮扫描
    const res = await fetch(`http://localhost:${port}/docs`);
    const body = (await res.json()) as { docs: Array<{ id: string; title: string; nodeCount: number }> };
    const ids = body.docs.map((d) => d.id).sort();
    expect(ids).toEqual(['乙', '甲']);
    expect(body.docs[0].nodeCount).toBe(1);
  });

  it('POST /docs creates doc file; PUT /doc/:id persists per id; GET /doc/:id reads it back', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;

    const created = (await (
      await fetch(`http://localhost:${port}/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新文档' }),
      })
    ).json()) as { id: string; title: string; rootId: string; updatedAt: string };
    expect(created.rootId).toBe('n_0001');
    expect(created.updatedAt).toBeTruthy();
    expect(existsSync(join(ctx.docsDir, `${created.id}.mindmap.json`))).toBe(true);

    // PUT 按.id 落对应文件（dir 模式强制 If-Match，版本来自 POST 响应；body 为独立内容，
    // 不直接改服务端内存 store——节点变更会自动刷新 updatedAt，旧版本号本就该被拒）
    const put = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': created.updatedAt },
      body: JSON.stringify({
        version: 1,
        meta: { title: '新文档', updatedAt: created.updatedAt },
        tree: {
          id: 'n_0001', type: 'folder', text: '新文档', props: {},
          children: [{ id: 'n_0002', type: 'folder', text: '模块X', props: {}, children: [] }],
        },
        annotations: [],
      }),
    });
    expect(put.ok).toBe(true);
    const back = (await (await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`)).json()) as {
      tree: { children: Array<{ text: string }> };
    };
    expect(back.tree.children[0].text).toBe('模块X');

    // 未知 id PUT 拒绝自建文件（404）：防止已删除文档被离线浏览器的自动保存"复活"
    const ok2 = await fetch(`http://localhost:${port}/doc/${encodeURIComponent('自愈-id')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalDoc('自愈')),
    });
    expect(ok2.status).toBe(404);
    expect(existsSync(join(ctx.docsDir, '自愈-id.mindmap.json'))).toBe(false);
  });

  it('POST /docs with stable id is idempotent; DELETE /doc/:id removes the file', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;

    const create = async (id: string) =>
      (await (
        await fetch(`http://localhost:${port}/docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '应用文档', id }),
        })
      ).json()) as { id: string; title: string; rootId: string; updatedAt: string };

    const first = await create('web-stable-id');
    expect(first.id).toBe('web-stable-id');
    // 再次用同一 id 挂载：复用而不是生成 -2 副本
    const second = await create('web-stable-id');
    expect(second.id).toBe('web-stable-id');
    const matching = readdirSync(ctx.docsDir).filter((f) => f.startsWith('web-stable-id'));
    expect(matching).toEqual(['web-stable-id.mindmap.json']);

    // PUT 写内容后 DELETE 删除
    await fetch(`http://localhost:${port}/doc/web-stable-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': first.updatedAt },
      body: JSON.stringify(minimalDoc('应用文档')),
    });
    const del = await fetch(`http://localhost:${port}/doc/web-stable-id`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(join(ctx.docsDir, 'web-stable-id.mindmap.json'))).toBe(false);
    const delAgain = await fetch(`http://localhost:${port}/doc/web-stable-id`, { method: 'DELETE' });
    expect(delAgain.status).toBe(404);
  });

  it('changed SSE carries docId in data payload', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const created = (await (
      await fetch(`http://localhost:${port}/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '事件文档' }),
      })
    ).json()) as { id: string; updatedAt: string };

    const dataPromise = nextChangedData(port);
    await new Promise((r) => setTimeout(r, 100));
    const s = ctx.docs.byId(created.id)!;
    await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': created.updatedAt },
      body: JSON.stringify(s.toJSON()),
    });
    const data = await dataPromise;
    const parsed = JSON.parse(data) as { docId: string };
    expect(parsed.docId).toBe(created.id);
  });

  it('legacy /doc 404s in dir mode', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const res = await fetch(`http://localhost:${port}/doc`);
    expect(res.status).toBe(404);
  });

  it('external file add in dir triggers changed with new docId', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    await new Promise((r) => setTimeout(r, 1100)); // 首轮扫描基线
    const dataPromise = nextChangedData(port);
    writeFileSync(join(ctx.docsDir, '外部新增.mindmap.json'), JSON.stringify(minimalDoc('外部新增')));
    const data = (await Promise.race([
      dataPromise,
      new Promise<string>((r) => setTimeout(() => r('timeout'), 3000)),
    ])) as string;
    const parsed = JSON.parse(data) as { docId?: string };
    expect(parsed.docId).toBe('外部新增');
  });

  it('PUT /doc/:id enforces If-Match optimistic lock (stale version → 409)', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const created = (await (
      await fetch(`http://localhost:${port}/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '锁测试' }),
      })
    ).json()) as { id: string; updatedAt: string };

    // dir 模式强制 If-Match：不带版本号的 PUT 一律 409（旧页面/旧脚本无法覆盖他人修改）
    const noVersion = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalDoc('无版本写入')),
    });
    expect(noVersion.status).toBe(409);
    const nv = (await noVersion.json()) as { currentUpdatedAt?: string };
    expect(nv.currentUpdatedAt).toBe(created.updatedAt);
    // 无版本写入未生效
    expect(ctx.docs.byId(created.id)!.document.meta.title).toBe('锁测试');

    // 带 POST 返回的正确版本 → 200，响应返回落盘后的新版本号
    const put1 = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': created.updatedAt },
      body: JSON.stringify(minimalDoc('锁测试')),
    });
    expect(put1.ok).toBe(true);
    const r1 = (await put1.json()) as { updatedAt?: string };
    const v1 = ctx.docs.byId(created.id)!.document.meta.updatedAt;
    expect(r1.updatedAt).toBe(v1);

    // 过期版本 → 409，并带回服务端当前版本
    const stale = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '2000-01-01T00:00:00.000Z' },
      body: JSON.stringify(minimalDoc('过期写入')),
    });
    expect(stale.status).toBe(409);
    const r2 = (await stale.json()) as { currentUpdatedAt?: string };
    expect(r2.currentUpdatedAt).toBe(v1);
    // 过期写入未生效
    expect(ctx.docs.byId(created.id)!.document.meta.title).toBe('锁测试');

    // 正确版本 → 200，返回刷新后的版本号
    const fresh = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': v1 },
      body: JSON.stringify(minimalDoc('锁测试-v2')),
    });
    expect(fresh.ok).toBe(true);
    const r3 = (await fresh.json()) as { updatedAt?: string };
    const v2 = ctx.docs.byId(created.id)!.document.meta.updatedAt;
    expect(r3.updatedAt).toBe(v2);
    expect(v2).not.toBe(v1);

    // 上一次成功写入前拿到的版本再写 → 409
    const replay = await fetch(`http://localhost:${port}/doc/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': v1 },
      body: JSON.stringify(minimalDoc('重放写入')),
    });
    expect(replay.status).toBe(409);
  });

  it('PUT /doc/:id to unknown id 404s in dir mode (no silent file resurrection)', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;
    const res = await fetch(`http://localhost:${port}/doc/${encodeURIComponent('已删除文档')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalDoc('不该被重建')),
    });
    expect(res.status).toBe(404);
    expect(existsSync(join(ctx.docsDir, '已删除文档.mindmap.json'))).toBe(false);
  });
});

describe('bridge /ai/chat with injected client', () => {
  it('AI create_document tool call creates a new doc file and broadcasts its docId', async () => {
    const ctx = setupDir();
    cleanupDirs.push(ctx.dir);
    openHandles.push(ctx.handle);
    const port = await ctx.ready;

    // 假 Anthropic 客户端：第一轮返回 create_document 工具调用，第二轮结束
    const factory = (): AnthropicLike => {
      let turn = 0;
      return {
        messages: {
          stream: (req: unknown) => {
            const body = req as { messages: Array<{ role: string; content: unknown }> };
            const last = body.messages[body.messages.length - 1]!;
            const isToolResult = last.role === 'user' && Array.isArray(last.content);
            turn++;
            const message = isToolResult
              ? ({ id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'x', role_: '' } as never)
              : ({
                  id: 'm1',
                  model: 'x',
                  role: 'assistant',
                  content: [
                    { type: 'text', text: '' },
                    { type: 'tool_use', id: 'tu1', name: 'create_document', input: { title: 'AI 新文档' } },
                  ],
                  stop_reason: 'tool_use',
                } as never);
            return {
              on: () => {},
              finalMessage: async () => message,
            };
          },
        },
      };
    };

    // 重新起一个带 anthropicFactory 的 bridge
    const registry = makeRegistry();
    const docs2 = new DirDocManager(registry, ctx.docsDir);
    const handle2 = startBridge({ docs: docs2, registry, port: 0, anthropicFactory: factory });
    openHandles.push(handle2);
    const port2 = await handle2.ready;

    const before = readdirSync(ctx.docsDir).filter((f) => f.endsWith('.mindmap.json')).length;
    const res = await fetch(`http://localhost:${port2}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '建一篇新文档' }),
    });
    expect(res.ok).toBe(true);
    // 读到 done 事件
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: done')) break;
    }
    await reader.cancel();
    const files = readdirSync(ctx.docsDir).filter((f) => f.endsWith('.mindmap.json'));
    expect(files.some((f) => f.includes('AI-新文档'))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(before + 1);
  });
});
