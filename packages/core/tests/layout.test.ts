import { describe, expect, it } from 'vitest';
import { NodeTypeRegistry, layoutTree, registerBuiltinTypes } from '../src/index.js';
import type { LayoutNode } from '../src/index.js';

function makeRegistry(): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  registerBuiltinTypes(registry);
  return registry;
}

function bigTree(folders: number, casesPerFolder: number): LayoutNode {
  const root: LayoutNode = { type: 'folder', text: '根', children: [] };
  for (let i = 0; i < folders; i++) {
    const folder: LayoutNode = { type: 'folder', text: `模块${i}`, children: [] };
    for (let j = 0; j < casesPerFolder; j++) {
      folder.children!.push({ type: 'case', text: `用例${i}-${j}`, props: { priority: 'P1' } });
    }
    root.children!.push(folder);
  }
  return root;
}

describe('layoutTree', () => {
  it('places children under default expand depth', () => {
    const tree = {
      type: 'folder',
      text: '根',
      children: [
        { type: 'folder', text: 'A', children: [{ type: 'case', text: 'a1' }] },
        { type: 'folder', text: 'B', children: [{ type: 'case', text: 'b1' }] },
      ],
    };
    const flat = layoutTree(tree, makeRegistry(), { defaultExpandDepth: 2 });
    expect(flat).toHaveLength(5); // 根 + A + B + a1 + b1
    const a = flat.find((f) => f.text === 'A');
    const a1 = flat.find((f) => f.text === 'a1');
    expect(a1!.x).toBeGreaterThan(a!.x);
    expect(a1!.parentId).toBe(a!.id);
  });

  it('hides collapsed subtrees and counts children', () => {
    const tree = {
      type: 'folder',
      text: '根',
      children: [{ type: 'folder', text: 'A', children: [{ type: 'case', text: 'a1' }] }],
    };
    // 深度 1：根展开、A 可见但折叠（a1 不可见）
    const flat = layoutTree(tree, makeRegistry(), { defaultExpandDepth: 1 });
    expect(flat).toHaveLength(2);
    const a = flat.find((f) => f.text === 'A')!;
    expect(a.childCount).toBe(1);
  });

  it('handles 10k nodes within layout budget', () => {
    const root = bigTree(100, 100); // 100 模块 × 100 用例 = 10,101 节点
    const t0 = performance.now();
    const flat = layoutTree(root, makeRegistry(), { defaultExpandDepth: 2 }); // 全部展开
    const ms = performance.now() - t0;
    expect(flat.length).toBe(10101);
    // 万级全展开布局预算：放 500ms 防 CI 抖动
    expect(ms).toBeLessThan(500);
  });
});
