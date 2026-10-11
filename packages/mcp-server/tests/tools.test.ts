import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, loadOrCreate } from '../src/store.js';
import { registerTools } from '../src/tools.js';

// 轻量桩：只实现 registerTools 用到的 server.tool()，捕获处理函数直接调用
function makeStubServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>>();
  return {
    server: {
      tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>) => {
        tools.set(name, handler);
      },
    },
    tools,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aimm-'));
  const filePath = join(dir, 'testcases.mindmap.json');
  const registry = createRegistry();
  const store = loadOrCreate(filePath, registry);
  const { server, tools } = makeStubServer();
  registerTools(server as never, { store: () => store, filePath });
  return { store, tools, filePath, dir, registry };
}

let cleanup: string | null = null;
afterEach(() => {
  if (cleanup) {
    rmSync(cleanup, { recursive: true, force: true });
    cleanup = null;
  }
});

describe('MCP tools', () => {
  it('create_tree resets root text and persists to file', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const create = ctx.tools.get('create_tree')!;
    const r = await create({ rootText: '订单中心', title: '订单用例' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(readFileSync(ctx.filePath, 'utf8')).meta.title).toBe('订单用例');
  });

  it('add_subtree assigns ids, persists, and reload sees them', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const add = ctx.tools.get('add_subtree')!;
    const r = await add({
      parentId: ctx.store.root.id,
      subtree: {
        type: 'folder',
        text: '登录',
        children: [{ type: 'case', text: 'c1', props: { priority: 'P0' } }],
      },
    });
    expect(r.isError).toBeFalsy();
    const { assignedIds } = JSON.parse(r.content[0].text);
    expect(assignedIds).toHaveLength(2);

    // 模拟脑图应用重新加载同一文件
    const reloaded = loadOrCreate(ctx.filePath, ctx.registry);
    expect(reloaded.root.children[0].children[0].props).toEqual({ priority: 'P0' });
  });

  it('invalid props return ERROR text instead of throwing', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const add = ctx.tools.get('add_subtree')!;
    const r = await add({
      parentId: ctx.store.root.id,
      subtree: { type: 'case', text: 'bad', props: { priority: 'PX' } },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ERROR.*priority/);
  });

  it('query_tree filters by type and truncates', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const add = ctx.tools.get('add_subtree')!;
    const subtree = {
      type: 'folder',
      text: 'm',
      children: Array.from({ length: 30 }, (_, i) => ({
        type: 'case',
        text: `c${i}`,
        props: { priority: 'P1' },
      })),
    };
    await add({ parentId: ctx.store.root.id, subtree });
    const q = ctx.tools.get('query_tree')!;
    const all = await q({ limit: 100 });
    expect(JSON.parse(all.content[0].text).nodes).toHaveLength(32);
    const casesOnly = await q({ type: 'case', limit: 100 });
    expect(JSON.parse(casesOnly.content[0].text).nodes).toHaveLength(30);
    const truncated = await q({ limit: 5 });
    const body = JSON.parse(truncated.content[0].text);
    expect(body.truncated).toBe(true);
    expect(body.nodes).toHaveLength(5);
  });

  it('annotation tools roundtrip with store', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const add = ctx.tools.get('add_subtree')!;
    const r = await add({ parentId: ctx.store.root.id, subtree: { type: 'case', text: 'c' } });
    const { nodeId } = JSON.parse(r.content[0].text);
    const annAdd = ctx.tools.get('add_annotation')!;
    const ann = JSON.parse((await annAdd({ nodeId, body: '边界缺失' })).content[0].text);
    expect(ann.status).toBe('open');
    const reply = ctx.tools.get('reply_annotation')!;
    const replied = JSON.parse(await reply({ annotationId: ann.id, body: '已补充' }).then((x) => x.content[0].text));
    expect(replied.replies).toHaveLength(1);
    const resolve = ctx.tools.get('resolve_annotation')!;
    await resolve({ annotationId: ann.id, resolved: true });
    expect(JSON.parse(readFileSync(ctx.filePath, 'utf8')).annotations[0].status).toBe('resolved');
  });

  it('loadOrCreate creates file when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aimm-missing-'));
    cleanup = dir;
    const filePath = join(dir, 'sub', 'testcases.mindmap.json');
    expect(existsSync(filePath)).toBe(false);
    loadOrCreate(filePath, createRegistry());
    expect(existsSync(filePath)).toBe(true);
  });
});
