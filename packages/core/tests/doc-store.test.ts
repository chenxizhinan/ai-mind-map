import { describe, expect, it } from 'vitest';
import { DocStore, NodeTypeRegistry, registerBuiltinTypes } from '../src/index.js';
import type { NodeTypeRegistry as Registry } from '../src/index.js';

function makeRegistry(): Registry {
  const registry = new NodeTypeRegistry();
  registerBuiltinTypes(registry);
  return registry;
}

function makeStore(title = 't'): DocStore {
  return new DocStore(makeRegistry(), {
    meta: { title, updatedAt: new Date().toISOString() },
  });
}

describe('NodeTypeRegistry', () => {
  it('rejects duplicate registration', () => {
    const registry = makeRegistry();
    expect(() => registerBuiltinTypes(registry)).toThrow(/already registered/);
  });

  it('rejects unknown type', () => {
    const registry = makeRegistry();
    expect(() => registry.get('nope')).toThrow(/Unknown node type/);
  });

  it('normalizeProps rejects invalid priority', () => {
    const registry = makeRegistry();
    expect(() =>
      registry.normalizeNode({ type: 'case', text: 't', props: { priority: 'PX' } }),
    ).toThrow(/priority/);
  });

  it('leafOnly type cannot have children', () => {
    const registry = makeRegistry();
    expect(() =>
      registry.normalizeNode({
        type: 'case',
        text: 't',
        children: [{ type: 'folder', text: 'x' }],
      }),
    ).toThrow(/leafOnly/);
  });

  it('custom node types are first-class', () => {
    const registry = makeRegistry();
    registry.register({
      name: 'risk',
      label: '风险项',
      leafOnly: true,
      normalizeProps: (i) => ({ level: (i as { level?: string }).level ?? 'low' }),
    });
    const n = registry.normalizeNode({ type: 'risk', text: '支付网关单点', props: { level: 'high' } });
    expect(n.props).toEqual({ level: 'high' });
    expect(() => registry.normalizeNode({ type: 'risk', text: 'x', children: [{ type: 'risk', text: 'y' }] })).toThrow(
      /leafOnly/,
    );
  });
});

describe('DocStore', () => {
  it('creates root and allocates ids', () => {
    const store = makeStore();
    expect(store.root.id).toBe('n_0001');
    expect(store.document.version).toBe(1);
  });

  it('addSubtree assigns ids and indexes nodes', () => {
    const store = makeStore();
    const { nodeId, assignedIds } = store.addSubtree(store.root.id, {
      type: 'folder',
      text: '登录模块',
      children: [
        { type: 'case', text: '正确密码登录成功', props: { priority: 'P1' } },
        { type: 'case', text: '错误密码提示', props: { priority: 'P2' } },
      ],
    });
    expect(nodeId).toMatch(/^n_/);
    expect(assignedIds).toHaveLength(3);
    expect(store.getNode(assignedIds[1])?.props).toEqual({ priority: 'P1' });
  });

  it('addSubtree rejects unknown parent and leafOnly parent', () => {
    const store = makeStore();
    expect(() => store.addSubtree('n_9999', { type: 'folder', text: 'x' })).toThrow(/not found/);
    const { nodeId } = store.addSubtree(store.root.id, { type: 'case', text: '叶子' });
    expect(() => store.addSubtree(nodeId, { type: 'folder', text: 'x' })).toThrow(/leafOnly/);
  });

  it('addSubtree rejects duplicate explicit ids', () => {
    const store = makeStore();
    store.addSubtree(store.root.id, { id: 'custom_1', type: 'folder', text: 'a' });
    expect(() =>
      store.addSubtree(store.root.id, { id: 'custom_1', type: 'folder', text: 'b' }),
    ).toThrow(/duplicate/);
  });

  it('updateNode validates props via registry', () => {
    const store = makeStore();
    const { nodeId } = store.addSubtree(store.root.id, { type: 'case', text: 'c' });
    store.updateNode(nodeId, { props: { priority: 'P0', steps: ['a', 'b'] } });
    expect(store.getNode(nodeId)?.props).toEqual({ priority: 'P0', steps: ['a', 'b'] });
    expect(() => store.updateNode(nodeId, { props: { priority: 'P9' } })).toThrow(/priority/);
  });

  it('setNodeType converts leaf to container and back', () => {
    const store = makeStore();
    const { nodeId } = store.addSubtree(store.root.id, { type: 'case', text: '疑似路径' });
    store.setNodeType(nodeId, 'folder');
    expect(store.getNode(nodeId)?.type).toBe('folder');
    store.addSubtree(nodeId, { type: 'case', text: '子用例' });
    expect(() => store.setNodeType(nodeId, 'case')).toThrow(/children/);
  });

  it('deleteSubtree removes indexed nodes', () => {
    const store = makeStore();
    const { nodeId, assignedIds } = store.addSubtree(store.root.id, {
      type: 'folder',
      text: 'm',
      children: [{ type: 'case', text: 'c' }],
    });
    const { removedIds } = store.deleteSubtree(nodeId);
    expect(removedIds).toEqual(assignedIds);
    expect(store.getNode(assignedIds[1])).toBeUndefined();
  });

  it('moveSubtree prevents cycles', () => {
    const store = makeStore();
    const { nodeId: a } = store.addSubtree(store.root.id, {
      type: 'folder',
      text: 'a',
      children: [{ type: 'folder', text: 'a1' }],
    });
    const a1 = store.root.children[0].children[0].id;
    expect(() => store.moveSubtree(a, a1)).toThrow(/itself/);
  });

  it('sibling order (reorder) persists through JSON roundtrip', () => {
    const store = makeStore();
    const { nodeId: a } = store.addSubtree(store.root.id, { type: 'folder', text: 'A' });
    const { nodeId: b } = store.addSubtree(store.root.id, { type: 'folder', text: 'B' });
    const { nodeId: c } = store.addSubtree(store.root.id, { type: 'folder', text: 'C' });
    // 下移 A（A,B,C → B,A,C）：删除自身后插到原 idx+1
    store.moveSubtree(a, store.root.id, 1);
    expect(store.root.children.map((x) => x.text)).toEqual(['B', 'A', 'C']);
    // 置底 A
    store.moveSubtree(a, store.root.id, store.root.children.length - 1);
    expect(store.root.children.map((x) => x.text)).toEqual(['B', 'C', 'A']);
    // 置顶 A
    store.moveSubtree(a, store.root.id, 0);
    expect(store.root.children.map((x) => x.text)).toEqual(['A', 'B', 'C']);
    // 顺序写入文档 JSON（固化）
    const json = JSON.parse(JSON.stringify(store.toJSON()));
    expect(json.tree.children.map((x: { text: string }) => x.text)).toEqual(['A', 'B', 'C']);
  });

  it('annotations attach to nodes and count open ones', () => {
    const store = makeStore();
    const { nodeId } = store.addSubtree(store.root.id, { type: 'case', text: 'c' });
    const ann = store.addAnnotation(nodeId, '边界缺失', 'user');
    store.replyAnnotation(ann.id, '已补充', 'ai');
    expect(store.openAnnotationCount(nodeId)).toBe(1);
    store.setAnnotationStatus(ann.id, 'resolved');
    expect(store.openAnnotationCount(nodeId)).toBe(0);
    expect(store.listAnnotations(nodeId, 'resolved')).toHaveLength(1);
  });

  it('roundtrips through JSON', () => {
    const store = makeStore();
    store.addSubtree(store.root.id, {
      type: 'folder',
      text: 'm',
      children: [{ type: 'case', text: 'c', props: { priority: 'P0' } }],
    });
    const json = JSON.parse(JSON.stringify(store.toJSON()));
    const restored = DocStore.fromJSON(makeRegistry(), json);
    expect(restored.root.children[0].children[0].props).toEqual({ priority: 'P0' });
    // 新分配 id 不与恢复的冲突
    const { assignedIds } = restored.addSubtree(restored.root.id, { type: 'folder', text: 'x' });
    expect(assignedIds[0]).not.toBe('n_0001');
  });
});
