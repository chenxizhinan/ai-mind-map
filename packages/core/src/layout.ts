import type { BaseNode, FlatNode } from './types.js';
import type { NodeTypeRegistry } from './node-type.js';

export interface LayoutOptions {
  /** 同层水平间距（相邻列节点框之间的空隙） */
  levelGap?: number;
  /** 兄弟垂直间距 */
  siblingGap?: number;
  /** 节点基准高度 */
  rowHeight?: number;
  /** 无显式展开集合时的默认展开深度（0 = 只显示根） */
  defaultExpandDepth?: number;
  /**
   * 显式展开集合（交互式折叠）。提供后 defaultExpandDepth 失效，
   * 集合外的节点一律折叠——demo 层以它为唯一折叠状态来源。
   */
  expandedIds?: Set<string>;
}

const DEFAULTS: Omit<Required<LayoutOptions>, 'expandedIds'> = {
  levelGap: 48,
  siblingGap: 10,
  rowHeight: 44,
  defaultExpandDepth: 2,
};

/**
 * 树布局：输出扁平节点数组（renderer 直接绘制）。
 *
 * 单次遍历：折叠子树贡献占位高度（兄弟位置稳定）；节点 x 依据
 * 「父节点右缘 + levelGap」累积，宽度不同的节点不会重叠。
 * 万级节点一次布局在几十 ms 量级，数据变更时调用、不逐帧调用。
 */
/**
 * 布局入参允许省略 props/id（测试与外部直接构造树时更宽松）；
 * 省略的 id 由布局器合成（synth_N），不回写。
 */
export type LayoutNode = {
  id?: string;
  type: string;
  text: string;
  props?: Record<string, unknown>;
  children?: LayoutNode[];
};

export function layoutTree(
  root: LayoutNode,
  registry: NodeTypeRegistry,
  opts: LayoutOptions = {},
): FlatNode[] {
  const o = { ...DEFAULTS, ...opts };
  const out: FlatNode[] = [];
  const byId = new Map<string, FlatNode>();
  const expanded = new Set<string>();
  let synthSeq = 0;

  const idOf = (n: LayoutNode): string => {
    if (n.id === undefined || n.id === null || n.id === '') {
      n.id = `synth_${synthSeq++}`;
    }
    return String(n.id);
  };

  const collectExpanded = (n: LayoutNode, depth: number): void => {
    if (depth < o.defaultExpandDepth) {
      expanded.add(idOf(n));
      for (const c of n.children ?? []) collectExpanded(c, depth + 1);
    }
  };
  if (opts.expandedIds) {
    // 显式展开集合模式：以调用方集合为准
    for (const id of opts.expandedIds) expanded.add(id);
  } else {
    collectExpanded(root, 0);
  }

  const measure = (n: LayoutNode): { w: number; h: number } => {
    let textW = 0;
    for (const ch of String(n.text ?? '')) textW += ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
    let badgeW = 0;
    if (registry.has(n.type)) {
      const badges = registry.get(n.type).describe?.(n.props ?? {}) ?? [];
      badgeW = badges.reduce((acc, b) => acc + b.text.length * 9 + 10, 0);
    }
    const w = Math.max(96, Math.min(380, textW + badgeW + 30));
    return { w, h: o.rowHeight };
  };

  const subtreeHeight = (n: LayoutNode): number => {
    const kids = n.children ?? [];
    if (!expanded.has(idOf(n)) || kids.length === 0) return o.rowHeight;
    let h = 0;
    for (const c of kids) h += subtreeHeight(c);
    return h + o.siblingGap * (kids.length - 1);
  };

  const place = (n: LayoutNode, depth: number, top: number, parentId: string | null): void => {
    const id = idOf(n);
    const { w, h } = measure(n);
    const kids = n.children ?? [];
    const isExpanded = expanded.has(id) && kids.length > 0;
    const parent = parentId === null ? null : byId.get(parentId);
    const flat: FlatNode = {
      id,
      type: n.type,
      text: String(n.text ?? ''),
      props: n.props ?? {},
      depth,
      parentId,
      x: parent ? parent.x + parent.w + o.levelGap : 0,
      y: top + subtreeHeight(n) / 2 - h / 2,
      w,
      h,
      hidden: false,
      childCount: kids.length,
    };
    out.push(flat);
    byId.set(id, flat);
    if (isExpanded) {
      let cursor = top;
      for (const c of kids) {
        place(c, depth + 1, cursor, id);
        cursor += subtreeHeight(c) + o.siblingGap;
      }
    }
  };

  place(root, 0, 0, null);
  return out;
}
