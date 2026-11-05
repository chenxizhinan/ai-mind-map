import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from '../src/merge.js';
import type { MindDocument, MindNode } from '@ai-mind-map/core';

let seq = 0;
function node(id: string, text: string, children?: MindNode[]): MindNode {
  return { id, type: 'folder', text, props: {}, children } as unknown as MindNode;
}
function doc(tree: MindNode, annotations: Array<Record<string, unknown>> = []): MindDocument {
  return {
    version: 1,
    meta: { title: tree.text, updatedAt: '2026-11-05T00:00:00.000Z' },
    tree,
    annotations,
  } as unknown as MindDocument;
}
function ann(id: string, nodeId: string, body: string): Record<string, unknown> {
  return { id, nodeId, createdBy: 'user', createdAt: 'x', body, status: 'open', replies: [] };
}

describe('mergeThreeWay（服务端三方合并）', () => {
  it('双方各自新增不同节点：合并结果都有', () => {
    const base = doc(node('n1', '根'));
    const mine = doc(node('n1', '根', [node('m1', '我加的')]));
    const theirs = doc(node('n1', '根', [node('t1', '他加的')]));
    const r = mergeThreeWay(base, mine, theirs);
    const kids = (r.merged.tree.children ?? []).map((k) => k.text).sort();
    expect(kids).toEqual(['他加的', '我加的']);
    expect(r.stats.addedMine).toBe(1);
    expect(r.stats.addedTheirs).toBe(1);
    expect(r.stats.conflicts).toHaveLength(0);
  });

  it('只有一方修改：该方内容生效，无冲突', () => {
    const base = doc(node('n1', '根', [node('a1', '原始')]));
    const mine = doc(node('n1', '根', [node('a1', '我改的')]));
    const theirs = doc(node('n1', '根', [node('a1', '原始')]));
    const r = mergeThreeWay(base, mine, theirs);
    expect((r.merged.tree.children ?? [])[0]?.text).toBe('我改的');
    expect(r.stats.conflicts).toHaveLength(0);
  });

  it('同一节点双方都改：mine 优先，theirs 版本写入批注留痕', () => {
    const base = doc(node('n1', '根', [node('a1', '原始')]));
    const mine = doc(node('n1', '根', [node('a1', '我改的')]));
    const theirs = doc(node('n1', '根', [node('a1', '他改的')]));
    const r = mergeThreeWay(base, mine, theirs);
    expect((r.merged.tree.children ?? [])[0]?.text).toBe('我改的');
    expect(r.stats.conflicts).toHaveLength(1);
    const conflictAnn = r.merged.annotations.find((a) => (a as { createdBy?: string }).createdBy === 'merge');
    expect(String((conflictAnn as { body?: string })?.body)).toContain('他改的');
  });

  it('单侧删除（另一侧未改）→ 删除生效', () => {
    const base = doc(node('n1', '根', [node('a1', '要删的')]));
    const mine = doc(node('n1', '根', []));
    const theirs = doc(node('n1', '根', [node('a1', '要删的')]));
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.merged.tree.children ?? []).toHaveLength(0);
    expect(r.stats.deleted).toBe(1);
  });

  it('单侧删除、另一侧修改 → 保留修改版本并记冲突', () => {
    const base = doc(node('n1', '根', [node('a1', '原始')]));
    const mine = doc(node('n1', '根', []));
    const theirs = doc(node('n1', '根', [node('a1', '他同时改了')]));
    const r = mergeThreeWay(base, mine, theirs);
    expect((r.merged.tree.children ?? [])[0]?.text).toBe('他同时改了');
    expect(r.stats.conflicts).toHaveLength(1);
  });

  it('theirs 删除、mine 未改 → 删除生效', () => {
    const base = doc(node('n1', '根', [node('a1', '要删的')]));
    const mine = doc(node('n1', '根', [node('a1', '要删的')]));
    const theirs = doc(node('n1', '根', []));
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.merged.tree.children ?? []).toHaveLength(0);
    expect(r.stats.deleted).toBe(1);
  });

  it('双方新增同 id 不同内容：mine 换新 id，双方都保留', () => {
    const base = doc(node('n1', '根'));
    const mine = doc(node('n1', '根', [node('a1', '我加的 a1')]));
    const theirs = doc(node('n1', '根', [node('a1', '他加的 a1')]));
    const r = mergeThreeWay(base, mine, theirs);
    const kids = r.merged.tree.children ?? [];
    expect(kids).toHaveLength(2);
    const texts = kids.map((k) => k.text).sort();
    expect(texts).toEqual(['他加的 a1', '我加的 a1']);
    expect(new Set(kids.map((k) => k.id)).size).toBe(2); // id 已重排，不互踩
  });

  it('无 base（历史丢失）退化为并集：双方节点都保留', () => {
    const mine = doc(node('n1', '根', [node('m1', '我加的')]));
    const theirs = doc(node('n1', '根', [node('t1', '他加的')]));
    const r = mergeThreeWay(null, mine, theirs);
    const kids = (r.merged.tree.children ?? []).map((k) => k.text).sort();
    expect(kids).toEqual(['他加的', '我加的']);
  });

  it('批注：双方新增都保留', () => {
    const base = doc(node('n1', '根'));
    const mine = doc(node('n1', '根'), [ann('an1', 'n1', '我的批注')]);
    const theirs = doc(node('n1', '根'), [ann('an2', 'n1', '他的批注')]);
    const r = mergeThreeWay(base, mine, theirs);
    const bodies = r.merged.annotations.map((a) => (a as { body: string }).body);
    expect(bodies).toContain('我的批注');
    expect(bodies).toContain('他的批注');
  });

  it('移动：mine 移动节点到新父级（theirs 未动）→ 生效', () => {
    const base = doc(node('n1', '根', [node('g1', '组A', [node('x', '移动我')]), node('g2', '组B')]));
    const mine = doc(node('n1', '根', [node('g1', '组A'), node('g2', '组B', [node('x', '移动我')])]));
    const theirs = doc(node('n1', '根', [node('g1', '组A', [node('x', '移动我')]), node('g2', '组B')]));
    const r = mergeThreeWay(base, mine, theirs);
    const g2 = (r.merged.tree.children ?? []).find((k) => k.id === 'g2');
    expect((g2?.children ?? []).map((c) => c.id)).toContain('x');
    const g1 = (r.merged.tree.children ?? []).find((k) => k.id === 'g1');
    expect((g1?.children ?? []).map((c) => c.id)).not.toContain('x');
  });
});
