import { describe, expect, it } from 'vitest';
import { NodeTypeRegistry, layoutTree, registerBuiltinTypes } from '../src/index.js';
import type { BaseNode } from '../src/index.js';

function makeRegistry(): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  registerBuiltinTypes(registry);
  return registry;
}

function node(type: string, text: string, children: BaseNode[] = [], props: Record<string, unknown> = {}): BaseNode {
  return { id: '', type, text, props, children };
}

function bigTree(folders: number, casesPerFolder: number): BaseNode {
  const root = node('folder', '根');
  for (let i = 0; i < folders; i++) {
    const folder = node('folder', `模块${i}`);
    for (let j = 0; j < casesPerFolder; j++) {
      folder.children!.push(node('case', `用例${i}-${j}`, [], { priority: 'P1' }));
    }
    root.children!.push(folder);
  }
  return root;
}

describe('layoutTree', () => {
  it('双侧地图布局：一级子节点交替分配左右，深层继承侧向', () => {
    const tree = node('folder', '根', [
      node('folder', 'A', [node('case', 'a1')]),
      node('folder', 'B', [node('case', 'b1')]),
      node('folder', 'C', [node('case', 'c1')]),
      node('folder', 'D', [node('case', 'd1')]),
    ]);
    const flat = layoutTree(tree, makeRegistry(), { defaultExpandDepth: 2 });
    expect(flat).toHaveLength(9);
    const a = flat.find((f) => f.text === 'A')!;
    const b = flat.find((f) => f.text === 'B')!;
    const c = flat.find((f) => f.text === 'C')!;
    const d = flat.find((f) => f.text === 'D')!;
    expect(a.side).toBe('right');
    expect(b.side).toBe('left');
    expect(c.side).toBe('right');
    expect(d.side).toBe('left');
    const a1 = flat.find((f) => f.text === 'a1')!;
    expect(a1.side).toBe('right');
    expect(a1.parentId).toBe(a.id);
  });

  it('折叠子树不输出，childCount 保持全量', () => {
    const tree = node('folder', '根', [node('folder', 'A', [node('case', 'a1')])]);
    const flat = layoutTree(tree, makeRegistry(), { defaultExpandDepth: 1 });
    expect(flat).toHaveLength(2);
    const a = flat.find((f) => f.text === 'A')!;
    expect(a.childCount).toBe(1);
  });

  it('right 模式全部在右侧', () => {
    const tree = node('folder', '根', [node('folder', 'A'), node('folder', 'B')]);
    const flat = layoutTree(tree, makeRegistry(), { direction: 'right', defaultExpandDepth: 1 });
    expect(flat.every((f) => f.side === 'right')).toBe(true);
  });

  it('handles 10k nodes within layout budget', () => {
    const root = bigTree(100, 100); // 10,101 节点
    const t0 = performance.now();
    const flat = layoutTree(root, makeRegistry(), { defaultExpandDepth: 99 });
    const ms = performance.now() - t0;
    expect(flat.length).toBe(10101);
    expect(ms).toBeLessThan(500);
  });

  it('expandedIds 显式集合控制可见性', () => {
    const tree = node('folder', '根', [
      node('folder', 'A', [node('case', 'a1')]),
      node('folder', 'B', [node('case', 'b1')]),
    ]);
    const flat = layoutTree(tree, makeRegistry(), { expandedIds: new Set(['synth_0']) });
    // 根可见（synth_0），A/B 可见（depth1 总是放置），但 a1/b1 折叠不可见
    expect(flat).toHaveLength(3);
  });
});
