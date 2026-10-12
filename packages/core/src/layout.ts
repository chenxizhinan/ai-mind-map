import type { BaseNode, FlatNode } from './types.js';
import type { NodeTypeRegistry } from './node-type.js';

export interface LayoutOptions {
  /** 相邻列水平间距 */
  levelGap?: number;
  /** 兄弟垂直间距 */
  siblingGap?: number;
  /** 单行文本行高 */
  lineHeight?: number;
  /** 无显式展开集合时的默认展开深度（0 = 只显示根） */
  defaultExpandDepth?: number;
  /** 显式展开集合（交互式折叠）。提供后默认深度失效。 */
  expandedIds?: Set<string>;
  /** 布局方向：right=全部右侧；both=经典地图（根两侧分布，默认） */
  direction?: 'right' | 'both';
}

const DEFAULTS = {
  levelGap: 56,
  lineHeight: 22,
  siblingGap: 8,
  paddingX: 14,
  defaultExpandDepth: 2,
  direction: 'both' as const,
};

const MAX_W = 260;
const MIN_W = 64;
const CHAR_W = 8;
const CJK_W = 15;

/**
 * 树布局：输出扁平节点数组（renderer 直接绘制）。
 *
 * - 双侧地图布局：根的一级子节点交替分配左右两侧，深层继承侧向
 * - 文本自动换行（近似字宽测量），节点高度随行数增长
 * - side / branch 元数据供渲染器按分支着色
 * - 折叠子树贡献占位高度，兄弟位置稳定
 */
export function layoutTree(
  root: BaseNode,
  registry: NodeTypeRegistry,
  opts: LayoutOptions = {},
): FlatNode[] {
  const o = { ...DEFAULTS, ...opts };
  const out: FlatNode[] = [];
  const expanded = new Set<string>();
  let synthSeq = 0;

  const idOf = (n: BaseNode): string => {
    if (n.id === undefined || n.id === null || n.id === '') {
      n.id = `synth_${synthSeq++}`;
    }
    return String(n.id);
  };

  // 预遍历：按文档顺序分配全部 id。否则惰性合成顺序由调用点决定，
  // expandedIds 里的 synth 引用会错位
  const preAssign = (n: BaseNode): void => {
    idOf(n);
    for (const c of n.children ?? []) preAssign(c);
  };
  preAssign(root);

  if (opts.expandedIds) {
    for (const id of opts.expandedIds) expanded.add(id);
  } else {
    const collect = (n: BaseNode, depth: number): void => {
      if (depth < o.defaultExpandDepth) {
        expanded.add(idOf(n));
        for (const c of n.children ?? []) collect(c, depth + 1);
      }
    };
    collect(root, 0);
  }

  // ---------- 测量与换行 ----------
  const textWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? CJK_W : CHAR_W;
    return w;
  };

  const wrapText = (text: string, maxW: number): string[] => {
    if (!text) return [''];
    const lines: string[] = [];
    let cur = '';
    let curW = 0;
    for (const ch of text) {
      const cw = ch.charCodeAt(0) > 0x2e7f ? CJK_W : CHAR_W;
      if (curW + cw > maxW && cur) {
        lines.push(cur);
        cur = ch;
        curW = cw;
      } else {
        cur += ch;
        curW += cw;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  // case 徽标位宽度计入（优先级徽标画在框内右侧）
  const badgeW = (n: BaseNode): number => {
    if (!registry.has(n.type)) return 0;
    const badges = registry.get(n.type).describe?.(n.props ?? {}) ?? [];
    return badges.length ? 34 : 0;
  };

  // 类型图标位（NodeType.icon）：图标 16px + 间距 4px
  const iconW = (n: BaseNode): number => {
    if (!registry.has(n.type)) return 0;
    return registry.get(n.type).icon ? 20 : 0;
  };

  const measure = (n: BaseNode): { w: number; h: number; lines: string[] } => {
    const avail = MAX_W - o.paddingX * 2 - badgeW(n) - iconW(n);
    const lines = wrapText(String(n.text ?? ''), avail);
    const w = Math.max(
      MIN_W,
      Math.min(MAX_W, Math.max(...lines.map(textWidth)) + o.paddingX * 2 + badgeW(n) + iconW(n)),
    );
    const h = Math.max(36, lines.length * o.lineHeight + 14);
    return { w, h, lines };
  };

  // ---------- 侧向分配 ----------
  const rightTop: BaseNode[] = [];
  const leftTop: BaseNode[] = [];
  (root.children ?? []).forEach((c, i) => {
    if (o.direction === 'right' || i % 2 === 0) rightTop.push(c);
    else leftTop.push(c);
  });

  /** 可见子树总高（折叠则只算自身） */
  function stackHeight(n: BaseNode): number {
    const kids = n.children ?? [];
    if (!expanded.has(idOf(n)) || kids.length === 0) return measure(n).h;
    let h = 0;
    for (const c of kids) h += stackHeight(c);
    h += o.siblingGap * (kids.length - 1);
    return Math.max(h, measure(n).h);
  }

  /** 直接可见后代的栈高（不含父自身，居中用） */
  function innerStackH(n: BaseNode): number {
    const kids = n.children ?? [];
    if (!expanded.has(idOf(n)) || kids.length === 0) return 0;
    let h = 0;
    for (const c of kids) h += stackHeight(c) + o.siblingGap;
    return h - o.siblingGap;
  }

  /** 放置一棵子树及其可见后代 */
  function placeStack(
    n: BaseNode,
    top: number,
    side: 'left' | 'right',
    branchIdx: number,
    parentId: string | null,
    depth: number,
  ): void {
    const m = measure(n);
    let x: number;
    if (depth === 1) {
      x = side === 'right' ? rootEdgeR + o.levelGap : rootEdgeL - o.levelGap - m.w;
    } else {
      const p = byId.get(parentId!)!;
      x = side === 'right' ? p.x + p.w + o.levelGap : p.x - o.levelGap - m.w;
    }
    const flat: FlatNode = {
      id: idOf(n),
      type: n.type,
      text: String(n.text ?? ''),
      props: n.props ?? {},
      depth,
      parentId,
      x,
      y: top,
      w: m.w,
      h: m.h,
      hidden: false,
      childCount: (n.children ?? []).length,
      side,
      branch: depth === 1 ? branchIdx : undefined,
      lines: m.lines,
      icon: registry.has(n.type) ? registry.get(n.type).icon : undefined,
    };
    out.push(flat);
    byId.set(flat.id, flat);
    const kids = n.children ?? [];
    if (expanded.has(idOf(n)) && kids.length > 0) {
      let cursor = top + m.h / 2 - innerStackH(n) / 2;
      for (const k of kids) {
        placeStack(k, cursor, side, branchIdx, n.id, depth + 1);
        cursor += stackHeight(k) + o.siblingGap;
      }
    }
  }

  const byId = new Map<string, FlatNode>();

  // ---------- 主流程 ----------
  const rootM = measure(root);
  let rightH = 0;
  rightTop.forEach((c, i) => {
    rightH += stackHeight(c) + (i < rightTop.length - 1 ? o.siblingGap : 0);
  });
  let leftH = 0;
  leftTop.forEach((c, i) => {
    leftH += stackHeight(c) + (i < leftTop.length - 1 ? o.siblingGap : 0);
  });
  const totalH = Math.max(rightH, leftH, rootM.h);
  const rootY = (totalH - rootM.h) / 2;

  // 世界原点 = 根节点左缘；右树从根右缘向右，左树向负方向延伸
  const rootEdgeL = 0;
  const rootEdgeR = rootM.w;

  out.push({
    id: idOf(root),
    type: root.type,
    text: String(root.text ?? ''),
    props: root.props ?? {},
    depth: 0,
    parentId: null,
    x: 0,
    y: rootY,
    w: rootM.w,
    h: rootM.h,
    hidden: false,
    childCount: (root.children ?? []).length,
    side: 'right',
    branch: -1,
    lines: rootM.lines,
    icon: registry.has(root.type) ? registry.get(root.type).icon : undefined,
  });

  let rc = rootY + rootM.h / 2 - rightH / 2;
  rightTop.forEach((c, i) => {
    placeStack(c, rc, 'right', i, root.id, 1);
    rc += stackHeight(c) + o.siblingGap;
  });
  let lc = rootY + rootM.h / 2 - leftH / 2;
  leftTop.forEach((c, i) => {
    placeStack(c, lc, 'left', rightTop.length + i, root.id, 1);
    lc += stackHeight(c) + o.siblingGap;
  });

  return out;
}
