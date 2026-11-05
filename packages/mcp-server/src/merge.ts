/**
 * 三方树合并（节点级 diff3）：base（共同祖先）/ mine（请求方）/ theirs（服务器当前版）。
 *
 * 规则（节点粒度）：
 * - 单侧新增 → 保留
 * - 单侧修改 → 应用该侧
 * - 单侧删除、另一侧未改 → 删除生效
 * - 一侧删除、另一侧修改 → 保留修改方并批注留痕
 * - 双侧修改同一节点（文本/props 不同）→ mine 优先，theirs 版本写入该节点批注
 * - 双侧新增同 id 但内容不同 → mine 子树换新 id，双方都保留
 * - 顺序：以 mine 的兄弟顺序为骨架，theirs 新增子节点追加在尾部
 *
 * base 为 null（无共同祖先快照，如 bridge 重启后历史丢失）时退化为并集：
 * 保留双方全部节点，同 id 冲突按"双侧修改"处理（mine 优先 + 留痕）。
 */
import type { MindDocument, MindNode } from '@ai-mind-map/core';

export interface MergeConflictInfo {
  nodeId: string;
  mineText: string;
  theirsText: string;
  resolution: 'mine' | 'theirs';
}

export interface ThreeWayStats {
  addedMine: number;
  addedTheirs: number;
  deleted: number;
  /** 本地新增批注数（远端新增批注不计，直接合入） */
  conflicts: MergeConflictInfo[];
}

export interface ThreeWayResult {
  merged: MindDocument;
  stats: ThreeWayStats;
}

interface N {
  node: MindNode;
  parent: string | null;
}

function idx(root: MindNode): Map<string, N> {
  const map = new Map<string, N>();
  const walk = (n: MindNode, parent: string | null): void => {
    map.set(n.id, { node: n, parent });
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(root, null);
  return map;
}

/** 键序无关的 props 稳定序列化 */
function propsStable(props: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = norm((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(norm(props));
}

function nodeChanged(a: MindNode | undefined, b: MindNode | undefined): boolean {
  if (!a || !b) return true;
  return a.type !== b.type || a.text !== b.text || propsStable(a.props ?? {}) !== propsStable(b.props ?? {});
}

let freshSeq = 0;
/** 为 mine 的冲突子树重新分配 id（避免与 theirs 的同 id 节点互踩） */
function reIdSubtree(node: MindNode): MindNode {
  const clone: MindNode = JSON.parse(JSON.stringify(node));
  const walk = (n: MindNode): void => {
    n.id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${(freshSeq++).toString(36)}`;
    for (const c of n.children ?? []) walk(c);
  };
  walk(clone);
  return clone;
}

export function mergeThreeWay(
  base: MindDocument | null,
  mine: MindDocument,
  theirs: MindDocument,
): ThreeWayResult {
  const stats: ThreeWayStats = { addedMine: 0, addedTheirs: 0, deleted: 0, conflicts: [] };
  const bI = base ? idx(base.tree) : new Map<string, N>();
  const mI = idx(mine.tree);
  const tI = idx(theirs.tree);

  const ids = new Set<string>([...mI.keys(), ...tI.keys(), ...bI.keys()]);
  const finalNode = new Map<string, MindNode>();
  const finalParent = new Map<string, string | null>();

  for (const id of ids) {
    const b = bI.get(id);
    const m = mI.get(id);
    const t = tI.get(id);
    const inB = !!b;
    const inM = !!m;
    const inT = !!t;

    if (!inM && !inT) {
      stats.deleted++;
      continue; // 双方都删了
    }
    if (inM && !inT) {
      // mine 保留、theirs 删除：mine 修改过 → 保留 mine 并留痕；未改 → theirs 的删除生效
      if (!inB) {
        finalNode.set(id, m!.node);
        finalParent.set(id, m!.parent);
        stats.addedMine++;
      } else if (nodeChanged(b!.node, m!.node) || m!.parent !== b!.parent) {
        finalNode.set(id, m!.node);
        finalParent.set(id, m!.parent);
        stats.conflicts.push({ nodeId: id, mineText: m!.node.text, theirsText: '(另一端已删除)', resolution: 'mine' });
      } else {
        stats.deleted++;
      }
      continue;
    }
    if (!inM && inT) {
      // mine 删除、theirs 保留：theirs 修改过 → 保留 theirs 并批注；未改 → mine 的删除生效
      if (!inB) {
        finalNode.set(id, t!.node);
        finalParent.set(id, t!.parent);
        stats.addedTheirs++;
      } else if (nodeChanged(b!.node, t!.node) || t!.parent !== b!.parent) {
        finalNode.set(id, t!.node);
        finalParent.set(id, t!.parent);
        stats.conflicts.push({ nodeId: id, mineText: '(本端已删除)', theirsText: t!.node.text, resolution: 'theirs' });
      } else {
        stats.deleted++;
      }
      continue;
    }
    if (!inB) {
      // 双方新增同 id：内容与父级一致 → 留一份；不同 → mine 换新 id，双方都保留
      if (m!.parent === t!.parent && !nodeChanged(m!.node, t!.node)) {
        finalNode.set(id, m!.node);
        finalParent.set(id, m!.parent);
      } else {
        const clone = reIdSubtree(m!.node);
        finalNode.set(clone.id, clone);
        finalParent.set(clone.id, m!.parent);
        finalNode.set(id, t!.node);
        finalParent.set(id, t!.parent);
        stats.addedMine++;
        stats.addedTheirs++;
      }
      continue;
    }
    // 三方都有：内容三判定
    const mineChanged = nodeChanged(b!.node, m!.node) || m!.parent !== b!.parent;
    const theirsChanged = nodeChanged(b!.node, t!.node) || t!.parent !== b!.parent;
    if (!mineChanged && !theirsChanged) {
      finalNode.set(id, b!.node);
      finalParent.set(id, b!.parent);
    } else if (theirsChanged && !mineChanged) {
      finalNode.set(id, t!.node);
      finalParent.set(id, t!.parent);
    } else {
      // 双侧都改：只有同一节点的文本/props 不同才是真冲突；mine 优先 + theirs 留痕
      finalNode.set(id, m!.node);
      finalParent.set(id, m!.parent);
      if (theirsChanged && (m!.node.text !== t!.node.text || propsStable(m!.node.props ?? {}) !== propsStable(t!.node.props ?? {}))) {
        stats.conflicts.push({ nodeId: id, mineText: m!.node.text, theirsText: t!.node.text, resolution: 'mine' });
      }
    }
  }

  // —— 父级与顺序：以 mine 的兄弟顺序为骨架，theirs 新增子节点追加尾部 ——
  const childrenOf = new Map<string | null, string[]>();
  const pushChild = (parent: string | null, id: string): void => {
    const arr = childrenOf.get(parent) ?? [];
    if (!arr.includes(id)) arr.push(id);
    childrenOf.set(parent, arr);
  };
  for (const [id, m] of mI) {
    if (!finalNode.has(id)) continue; // 已被删除
    if (finalParent.get(id) === m.parent) pushChild(m.parent, id);
  }
  for (const [id, t] of tI) {
    if (!finalNode.has(id)) continue;
    if (finalParent.get(id) === t.parent) pushChild(t.parent, id);
  }
  // 兜底：换过新 id 的节点（同 id 双侧新增）等，确保每个节点都挂在 finalParent 下
  for (const [id] of finalNode) {
    const p = finalParent.get(id) ?? null;
    const arr = childrenOf.get(p);
    if (!arr || !arr.includes(id)) pushChild(p, id);
  }

  // —— 组装（根不可删除，必然存在） ——
  const rootId = theirs.tree.id;
  if (!finalNode.has(rootId)) {
    finalNode.set(rootId, theirs.tree);
    finalParent.set(rootId, null);
  }
  const assemble = (id: string, depth: number): MindNode | null => {
    if (depth > 200) return null; // 防环
    const content = finalNode.get(id);
    if (!content) return null;
    const kids = (childrenOf.get(id) ?? [])
      .map((cid) => assemble(cid, depth + 1))
      .filter((x): x is MindNode => !!x);
    return { ...content, children: kids.length ? kids : [] };
  };
  const mergedTree = assemble(rootId, 0);
  if (!mergedTree) throw new Error('merge produced empty tree');

  // —— 批注：按同规则三方合并，冲突留痕写入节点批注 ——
  const mergedAnnotations: Array<{ [k: string]: unknown }> = [];
  const baseAnns = new Map<string, object>();
  if (base) for (const a of base.annotations) baseAnns.set(a.id as string, a);
  const mineAnns = new Map<string, object>();
  for (const a of mine.annotations) mineAnns.set(a.id as string, a);
  const theirsAnns = new Map<string, object>();
  for (const a of theirs.annotations) theirsAnns.set(a.id as string, a);
  const annIds = new Set<string>([...mineAnns.keys(), ...theirsAnns.keys(), ...baseAnns.keys()]);
  for (const aid of annIds) {
    const bA = baseAnns.get(aid);
    const mA = mineAnns.get(aid);
    const tA = theirsAnns.get(aid);
    const same = (x: unknown, y: unknown): boolean => (!x || !y ? x === y : JSON.stringify(x) === JSON.stringify(y));
    if (mA && !tA) {
      if (!(bA && JSON.stringify(bA) === JSON.stringify(mA))) mergedAnnotations.push(mA as unknown as { [k: string]: unknown }); // mine 新增或修改
      // else mine 恢复原样：不输出（相当于删除了 no-op）
      continue;
    }
    if (!mA && tA) {
      if (!(bA && JSON.stringify(bA) === JSON.stringify(tA))) mergedAnnotations.push(tA as unknown as { [k: string]: unknown }); // theirs 新增或修改
      continue;
    }
    if (mA && tA) mergedAnnotations.push(mA as unknown as { [k: string]: unknown }); // 双方都在：取 mine（批注冲突极少）
  }

  // 冲突留痕：给冲突节点追加批注（所有人可见）
  for (const c of stats.conflicts) {
    mergedAnnotations.push({
      id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${mergedAnnotations.length}`,
      nodeId: c.nodeId,
      createdBy: 'merge',
      createdAt: new Date().toISOString(),
      body: `并发修改：${c.resolution === 'mine' ? '保留了这一端的版本' : '保留了另一端的版本'}；另一端内容为「${c.theirsText}」`,
      status: 'open',
      replies: [],
    });
  }

  const merged: MindDocument = {
    ...theirs,
    meta: { ...theirs.meta, title: mine.meta.title || theirs.meta.title },
    tree: mergedTree,
    annotations: mergedAnnotations as unknown as typeof theirs.annotations,
  };
  return { merged, stats };
}
