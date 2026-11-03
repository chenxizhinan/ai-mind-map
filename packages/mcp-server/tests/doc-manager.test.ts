import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore, NodeTypeRegistry, registerBuiltinTypes } from '@ai-mind-map/core';
import { DirDocManager, singleDocContext, slugifyTitle, isValidDocId } from '../src/doc-manager.js';
import { registerTools } from '../src/tools.js';

function makeRegistry(): NodeTypeRegistry {
  const r = new NodeTypeRegistry();
  registerBuiltinTypes(r);
  return r;
}

function makeStubServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>>();
  return {
    server: {
      tool: (name: string, _d: string, _s: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>) => {
        tools.set(name, handler);
      },
    },
    tools,
  };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('slugifyTitle / isValidDocId', () => {
  it('keeps CJK, strips illegal chars', () => {
    expect(slugifyTitle('BYOS 测试用例')).toBe('BYOS-测试用例');
    expect(slugifyTitle('a/b\\c:d')).toBe('a-b-c-d');
    expect(slugifyTitle('   ')).toBe('untitled');
  });
  it('rejects traversal ids', () => {
    expect(isValidDocId('../etc')).toBe(false);
    expect(isValidDocId('a/b')).toBe(false);
    expect(isValidDocId('BYOS-用例')).toBe(true);
  });
});

describe('DirDocManager', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'aimm-dm-'));
    dirs.push(dir);
    const docs = new DirDocManager(makeRegistry(), dir);
    return { dir, docs };
  }

  it('createDoc writes file with slug name and activates', () => {
    const { dir, docs } = setup();
    const r = docs.createDoc({ title: '登录功能用例' });
    expect(r.rootId).toBe('n_0001');
    expect(existsSync(join(dir, '登录功能用例.mindmap.json'))).toBe(true);
    expect(docs.store().document.meta.title).toBe('登录功能用例');
  });

  it('duplicate title gets -2 suffix', () => {
    const { docs } = setup();
    docs.createDoc({ title: 'X' });
    const r2 = docs.createDoc({ title: 'X' });
    expect(r2.id).toContain('-2');
  });

  it('openDoc by id, exact title, unique fuzzy; ambiguous throws with candidates', () => {
    const { docs } = setup();
    const a = docs.createDoc({ title: '登录模块' });
    docs.createDoc({ title: '支付模块' });
    docs.persist(); // 登录模块落盘过；支付模块只 persist 一次（createDoc 已落盘）
    expect(docs.openDoc({ id: a.id }).title).toBe('登录模块');
    expect(docs.openDoc({ title: '支付模块' }).title).toBe('支付模块');
    expect(docs.openDoc({ title: '支付' }).title).toBe('支付模块'); // 唯一模糊
    docs.createDoc({ title: '支付模块二' });
    expect(() => docs.openDoc({ title: '支付' })).toThrow(/请用 id/);
  });

  it('openDoc missing throws with available titles', () => {
    const { docs } = setup();
    docs.createDoc({ title: '唯一文档' });
    docs.persist();
    expect(() => docs.openDoc({ title: '不存在' })).toThrow(/可用文档/);
  });

  it('two docs persist independently', () => {
    const { dir, docs } = setup();
    const a = docs.createDoc({ title: '甲' });
    const b = docs.createDoc({ title: '乙' });
    docs.openDoc({ id: a.id });
    docs.store().addSubtree(docs.store().root.id, { type: 'folder', text: '模块A' });
    docs.persist();
    docs.openDoc({ id: b.id });
    docs.store().addSubtree(docs.store().root.id, { type: 'folder', text: '模块B' });
    docs.persist();
    const fa = JSON.parse(readFileSync(join(dir, '甲.mindmap.json'), 'utf8'));
    const fb = JSON.parse(readFileSync(join(dir, '乙.mindmap.json'), 'utf8'));
    expect(fa.tree.children[0].text).toBe('模块A');
    expect(fb.tree.children[0].text).toBe('模块B');
  });

  it('putDoc replaces content by id (self-heal unknown id)', () => {
    const { dir, docs } = setup();
    docs.putDoc('外来-id', createEmptyStoreExternal('外部文档'));
    expect(existsSync(join(dir, '外来-id.mindmap.json'))).toBe(true);
    expect(docs.byId('外来-id')!.document.meta.title).toBe('外部文档');
  });

  it('scanForChanges detects external add/change/remove', async () => {
    const { dir, docs } = setup();
    docs.createDoc({ title: '基线' });
    docs.scanForChanges(); // 建立基线快照
    // 外部新增
    const other = createEmptyStoreExternal('外来');
    writeFileSync(join(dir, '外来.mindmap.json'), JSON.stringify(other));
    let r = docs.scanForChanges();
    expect(r.added).toContain('外来');
    // 外部修改
    await new Promise((res) => setTimeout(res, 20));
    const content = JSON.parse(readFileSync(join(dir, '外来.mindmap.json'), 'utf8'));
    content.meta.title = '外来-改';
    writeFileSync(join(dir, '外来.mindmap.json'), JSON.stringify(content));
    r = docs.scanForChanges();
    expect(r.changed).toContain('外来');
    // 重载后内容更新
    expect(docs.byId('外来')!.document.meta.title).toBe('外来-改');
    // 外部删除
    rmSync(join(dir, '外来.mindmap.json'));
    r = docs.scanForChanges();
    expect(r.removed).toContain('外来');
  });
});

function createEmptyStoreExternal(title: string): unknown {
  // 直接构造一份最小合法文档 JSON（不经 registry，模拟外部写入）
  return {
    version: 1,
    meta: { title, updatedAt: new Date().toISOString() },
    tree: { id: 'n_0001', type: 'folder', text: title, props: {}, children: [] },
    annotations: [],
  };
}

describe('tools with {docs} context', () => {
  function setupTools() {
    const dir = mkdtempSync(join(tmpdir(), 'aimm-dmt-'));
    dirs.push(dir);
    const docs = new DirDocManager(makeRegistry(), dir);
    const { server, tools } = makeStubServer();
    registerTools(server as never, { docs });
    return { dir, docs, tools };
  }

  it('requires docId with multiple docs and keeps writes isolated', async () => {
    const { dir, tools } = setupTools();
    const create = tools.get('create_document')!;
    const add = tools.get('add_subtree')!;
    const query = tools.get('query_tree')!;
    const open = tools.get('open_document')!;
    const list = tools.get('list_documents')!;

    const r1 = JSON.parse((await create({ title: '文档一' })).content[0].text.split('。')[0]!);
    const r2 = JSON.parse((await create({ title: '文档二' })).content[0].text.split('。')[0]!);
    expect(r1.rootId).toBe('n_0001');
    expect(r2.rootId).toBe('n_0001');

    // 多文档时拒绝依赖共享 active，避免相同节点 id 写进错误文件。
    const unsafe = await add({ parentId: r1.rootId, subtree: { type: 'folder', text: '不应写入' } });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.content[0].text).toContain('docId');

    await add({ docId: r1.id, parentId: r1.rootId, subtree: { type: 'folder', text: '模块一' } });
    const opened = JSON.parse((await open({ title: '文档一' })).content[0].text);
    expect(opened.title).toBe('文档一');
    await add({ docId: r2.id, parentId: r2.rootId, subtree: { type: 'case', text: '用例2' } });

    const q1 = JSON.parse((await query({ docId: r1.id, nodeId: r1.rootId, limit: 50 })).content[0].text);
    const q2 = JSON.parse((await query({ docId: r2.id, nodeId: r2.rootId, limit: 50 })).content[0].text);
    expect(q1.nodes.map((n: { text: string }) => n.text)).toContain('模块一');
    expect(q1.nodes.map((n: { text: string }) => n.text)).not.toContain('用例2');
    expect(q2.nodes.map((n: { text: string }) => n.text)).toContain('用例2');
    expect(q2.nodes.map((n: { text: string }) => n.text)).not.toContain('模块一');

    // list_documents 标记 active
    const listOut = JSON.parse((await list({})).content[0].text) as Array<{ id: string; active: boolean }>;
    expect(listOut.find((d) => d.id === opened.id)?.active).toBe(true);
    // 两个文件都在磁盘
    expect(existsSync(join(dir, '文档一.mindmap.json'))).toBe(true);
    expect(existsSync(join(dir, '文档二.mindmap.json'))).toBe(true);
  });

  it('single-doc context: create_document errors with --dir hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aimm-sd-'));
    dirs.push(dir);
    const registry = makeRegistry();
    const fp = join(dir, 'one.mindmap.json');
    const { DocStore: DS } = await import('@ai-mind-map/core');
    let store = new DS(registry, { meta: { title: '唯一', updatedAt: new Date().toISOString() } });
    const ctx = singleDocContext(registry, fp, () => store, (s) => { store = s; });
    const { server, tools } = makeStubServer();
    registerTools(server as never, { docs: ctx });
    const create = tools.get('create_document')!;
    const r = await create({ title: '另一篇' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('--dir');
    // list_documents 返回唯一文档
    const list = JSON.parse((await tools.get('list_documents')!({})).content[0].text);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('default');
  });
});
