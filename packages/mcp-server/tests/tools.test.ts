import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, loadOrCreate } from '../src/store.js';
import { registerTools } from '../src/tools.js';
import { DirDocManager } from '../src/doc-manager.js';

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

/** 多文档模式上下文（--dir），用于文档级工具测试 */
function setupDirTools() {
  const dir = mkdtempSync(join(tmpdir(), 'aimm-tools-dir-'));
  const docsDir = join(dir, 'mindmaps');
  mkdirSync(docsDir, { recursive: true });
  const registry = createRegistry();
  const docs = new DirDocManager(registry, docsDir);
  const { server, tools } = makeStubServer();
  registerTools(server as never, { docs });
  return { tools, dir, docsDir, docs };
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

  it('delete_subtree 与 delete_nodes 删除节点并落盘；根节点/不存在的 id 报错', async () => {
    const ctx = setup();
    cleanup = ctx.dir;
    const add = ctx.tools.get('add_subtree')!;
    const rootId = ctx.store.root.id;
    const a = JSON.parse(
      (await add({ parentId: rootId, subtree: { type: 'folder', text: '空分组A', children: [] } })).content[0].text,
    );
    const b = JSON.parse(
      (await add({
        parentId: rootId,
        subtree: { type: 'folder', text: '分组B', children: [{ type: 'case', text: '用例B', props: { priority: 'P0' } }] },
      })).content[0].text,
    );
    // 单个删除
    const del = ctx.tools.get('delete_subtree')!;
    const single = JSON.parse((await del({ nodeId: a.nodeId })).content[0].text);
    expect(single.removedIds).toEqual([a.nodeId]);
    // 批量删除：成功项 + 不存在 id + 根节点（应返回错误但不影响成功项）
    const batch = ctx.tools.get('delete_nodes')!;
    const res = JSON.parse(
      (await batch({ nodeIds: [b.nodeId, 'nope', rootId] })).content[0].text,
    );
    expect(res.removedIds).toContain(b.nodeId);
    expect(res.removedIds).toContain(b.assignedIds[1]); // 子用例随子树一起删除
    expect(res.errors).toHaveLength(2);
    expect(res.errors.map((e: { nodeId: string }) => e.nodeId).sort()).toEqual(['nope', rootId].sort());
    // 落盘校验：根节点下只剩最初的空树
    const disk = JSON.parse(readFileSync(ctx.filePath, 'utf8'));
    expect(disk.tree.children).toHaveLength(0);
  });

  it('delete_document 在多文档模式下删除文件并从列表移除', async () => {
    const ctx = setupDirTools();
    cleanup = ctx.dir;
    const create = ctx.tools.get('create_document')!;
    const createdText = (await create({ title: '待删文档' })).content[0].text;
    const created = JSON.parse(createdText.slice(0, createdText.indexOf('}') + 1));
    expect(existsSync(join(ctx.docsDir, '待删文档.mindmap.json'))).toBe(true);

    const del = ctx.tools.get('delete_document')!;
    const delRes = await del({ id: created.id });
    expect(delRes.isError).toBeFalsy();
    expect(existsSync(join(ctx.docsDir, `${created.id}.mindmap.json`))).toBe(false);
    // 删除 = 移入回收站（.trash 子目录），不再直接销毁
    expect(readdirSync(ctx.docsDir)).toEqual(['.trash']);

    const list = ctx.tools.get('list_documents')!;
    const docs = JSON.parse((await list({})).content[0].text);
    expect(docs.some((d: { id: string }) => d.id === created.id)).toBe(false);
    // 再删一次 → ERROR
    const again = await del({ id: created.id });
    expect(again.isError).toBe(true);
    // 单文件模式不支持
    const single = setup();
    cleanup = single.dir;
    const singleDel = single.tools.get('delete_document')!;
    expect((await singleDel({ id: 'x' })).isError).toBe(true);
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
