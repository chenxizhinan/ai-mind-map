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
  /**
   * 布局方向（对齐 XMind 结构图式）：
   * - 'right'：逻辑图，全部右侧
   * - 'both'：经典地图，根两侧交替（默认）
   * - 'down'：组织结构图，根在上，子级横向展开向下生长
   * - 'up'：向上树，根在下，子级横向展开向上生长
   */
  direction?: 'right' | 'both' | 'down' | 'up';
}

const DEFAULTS = {
  levelGap: 56,
  lineHeight: 22,
  siblingGap: 14,
  paddingX: 14,
  defaultExpandDepth: 2,
  direction: 'both' as const,
};

const MAX_W = 340;
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

  // 图标解析：节点级 props.icon 优先，其次 NodeType.icon（默认内置类型不设置 → 不显示）
  const resolveIcon = (n: BaseNode): string | undefined => {
    const nodeIcon = (n.props as { icon?: string }).icon;
    if (typeof nodeIcon === 'string' && nodeIcon) return nodeIcon;
    if (!registry.has(n.type)) return undefined;
    return registry.get(n.type).icon;
  };

  // 图标位宽度：图标 16px + 间距 4px
  const iconW = (n: BaseNode): number => {
    return resolveIcon(n) ? 20 : 0;
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

  // ---------- 主流程分支 ----------
  const rootM = measure(root);
  const byId = new Map<string, FlatNode>();

  if (o.direction === 'right' || o.direction === 'both') {
    // ===== 横向布局：逻辑图（right）/ 经典地图（both） =====
    const rightTop: BaseNode[] = [];
    const leftTop: BaseNode[] = [];
    (root.children ?? []).forEach((c, i) => {
      if (o.direction === 'right' || i % 2 === 0) rightTop.push(c);
      else leftTop.push(c);
    });

    /**
     * 可见子树总高（折叠则只算自身）。
     * 与放置逻辑严格一致：每个节点的实际占高 = max(子级净高, 自身高)——
     * 子级以节点中线排开时至少要占自身高度，否则深层子树会侵入相邻子树。
     */
    function stackHeight(n: BaseNode): number {
      const kids = n.children ?? [];
      if (!expanded.has(idOf(n)) || kids.length === 0) return measure(n).h;
      let h = 0;
      for (const c of kids) h += stackHeight(c);
      h += o.siblingGap * (kids.length - 1);
      return Math.max(h, measure(n).h);
    }

    /** 直接可见后代的总占高（不含父自身，居中用）。含每个子级的膨胀占高 */
    function innerStackH(n: BaseNode): number {
      const kids = n.children ?? [];
      if (!expanded.has(idOf(n)) || kids.length === 0) return 0;
      let h = 0;
      for (const c of kids) h += stackHeight(c) + o.siblingGap;
      h -= o.siblingGap;
      return h;
    }

    /** 子级排布所需总高（innerStackH 与自身高取 max）：决定该节点在父栈里的占高 */
    function nodeStackH(n: BaseNode): number {
      const kids = n.children ?? [];
      if (!expanded.has(idOf(n)) || kids.length === 0) return measure(n).h;
      return Math.max(innerStackH(n), measure(n).h);
    }

    /** 横向放置一棵子树及其可见后代 */
    function placeStack(
      n: BaseNode,
      top: number,
      side: 'left' | 'right',
      branchIdx: number,
      parentId: string | null,
      depth: number,
    ): void {
      const m = measure(n);
      const slot = nodeStackH(n); // 该子树的实际占高（与子级排布同口径）
      let x: number;
      if (depth === 1) {
        x = side === 'right' ? rootM.w + o.levelGap : -o.levelGap - m.w;
      } else {
        const p = byId.get(parentId!)!;
        x = side === 'right' ? p.x + p.w + o.levelGap : p.x - o.levelGap - m.w;
      }
      // 父框垂直居中于自己的槽位（而不是贴槽位顶）——子级列也居中于同一槽位，
      // 两者同心：父节点在子级正中，且互不越界
      const y = top + (slot - m.h) / 2;
      const flat: FlatNode = {
        id: idOf(n),
        type: n.type,
        text: String(n.text ?? ''),
        props: n.props ?? {},
        depth,
        parentId,
        x,
        y,
        w: m.w,
        h: m.h,
        hidden: false,
        childCount: (n.children ?? []).length,
        side,
        branch: depth === 1 ? branchIdx : undefined,
        lines: m.lines,
        icon: resolveIcon(n),
      };
      out.push(flat);
      byId.set(flat.id, flat);
      const kids = n.children ?? [];
      if (expanded.has(idOf(n)) && kids.length > 0) {
        // 子级列居中于同一槽位 [top, top+slot]：从槽位中心向两侧排开。
        // innerH ≤ slot 恒成立，列高 innerH 居中后完整落在槽位内，
        // 相邻子树互不侵入；父框已按槽位居中，视觉上在子级正中
        const innerH = innerStackH(n);
        let cursor = top + (slot - innerH) / 2;
        for (const k of kids) {
          placeStack(k, cursor, side, branchIdx, n.id, depth + 1);
          cursor += nodeStackH(k) + o.siblingGap;
        }
      }
    }

    const rightH = rightTop.reduce((acc, c) => acc + nodeStackH(c), 0) + o.siblingGap * Math.max(0, rightTop.length - 1);
    const leftH = leftTop.reduce((acc, c) => acc + nodeStackH(c), 0) + o.siblingGap * Math.max(0, leftTop.length - 1);
    const totalH = Math.max(rightH, leftH, rootM.h);
    const rootY = (totalH - rootM.h) / 2;

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
      icon: resolveIcon(root),
      axis: 'h',
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

  // ===== 纵向布局（down：组织结构图 / up：向上树） =====
  // 父子纵向，同级横向展开；同级超过 maxRowWidth 自动换行（XMind 组织结构图行为）。
  const dirSign: 1 | -1 = o.direction === 'down' ? 1 : -1;
  const rowGap = o.levelGap; // 父缘到子缘的行间距
  const maxRowWidth = 3200;  // 单行最大宽度，超过则换行

  /** 模拟 placeVertical 的贪心装箱（共享给 subtreeW/subtreeH，保证口径一致） */
  function packRows(n: BaseNode): BaseNode[][] {
    const kids = n.children ?? [];
    const rows: BaseNode[][] = [];
    let row: BaseNode[] = [];
    let rowW = 0;
    for (const k of kids) {
      const kw = subtreeW(k);
      if (row.length && rowW + o.siblingGap + kw > maxRowWidth) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      if (row.length) rowW += o.siblingGap;
      row.push(k);
      rowW += kw;
    }
    if (row.length) rows.push(row);
    return rows;
  }

  /**
   * 可见子树总宽（折叠则只算自身）。
   * 子级装箱成多行时，实际占宽 = 最宽行（各行都居中于父中心），
   * 而非所有子级单行宽度之和——否则槽位按虚宽推进、行居中后相邻子树互相侵入。
   */
  function subtreeW(n: BaseNode): number {
    const kids = n.children ?? [];
    if (!expanded.has(idOf(n)) || kids.length === 0) return measure(n).w;
    const rows = packRows(n);
    let w = 0;
    for (const r of rows) {
      const rW = r.reduce((acc, k) => acc + subtreeW(k), 0) + o.siblingGap * (r.length - 1);
      w = Math.max(w, rW);
    }
    return Math.max(w, measure(n).w);
  }

  /**
   * 可见子树纵向占高：自身框高 + 子级行带总高。
   * 严格对齐 placeVertical 的行推进：底缘 = y + m.h + Σ_rows(rH_i + rowGap)，
   * 即占高 = m.h + Σ(rH_i + rowGap)。漏掉 m.h 或 rowGap 都会让下一兄弟行
   * 压上来（多级子树堆叠）。
   */
  function subtreeH(n: BaseNode): number {
    const kids = n.children ?? [];
    if (!expanded.has(idOf(n)) || kids.length === 0) return measure(n).h;
    const rows = packRows(n);
    let h = 0;
    for (const r of rows) {
      const rH = Math.max(...r.map((k) => subtreeH(k)));
      h += rH + rowGap;
    }
    return Math.max(measure(n).h + h, measure(n).h);
  }

  /**
   * 纵向放置：n 左缘 x=left；down 时顶缘 y=edge，up 时底缘 y=edge。
   * 子级横排（自动换行），父居中于子级整体包围盒。
   * 返回该子树的占用包围盒（相对世界坐标），供上层布局参考。
   */
  function placeVertical(
    n: BaseNode,
    left: number,
    edge: number,        // down: 该行顶缘 y；up: 该行底缘 y
    dirSign: 1 | -1,
    branchIdx: number,
    parentId: string | null,
    depth: number,
  ): void {
    const m = measure(n);
    const y = dirSign === 1 ? edge : edge - m.h;
    // 父框横向居中于自己的槽位（槽位宽 = subtreeW），展开后父节点始终在子级行正中上方
    const sw = subtreeW(n);
    const flat: FlatNode = {
      id: idOf(n),
      type: n.type,
      text: String(n.text ?? ''),
      props: n.props ?? {},
      depth,
      parentId,
      x: left + (sw - m.w) / 2,
      y,
      w: m.w,
      h: m.h,
      hidden: false,
      childCount: (n.children ?? []).length,
      // side 仅作连线方向提示：down=子从父底缘出（right），up=子从父顶缘出（left）
      side: dirSign === 1 ? 'right' : 'left',
      branch: depth === 1 ? branchIdx : undefined,
      lines: m.lines,
      icon: resolveIcon(n),
      axis: 'v',
    };
    out.push(flat);
    byId.set(flat.id, flat);
    const kids = n.children ?? [];
    if (expanded.has(idOf(n)) && kids.length > 0) {
      // 把子级按宽度切成若干行（贪心装箱），每行内子树间距 siblingGap
      const rows: BaseNode[][] = [];
      let row: BaseNode[] = [];
      let rowW = 0;
      for (const k of kids) {
        const kw = subtreeW(k);
        if (row.length && rowW + o.siblingGap + kw > maxRowWidth) {
          rows.push(row);
          row = [];
          rowW = 0;
        }
        if (row.length) rowW += o.siblingGap;
        row.push(k);
        rowW += kw;
      }
      if (row.length) rows.push(row);

      // 各行依次放置（down 向下长，up 向上长）；行高 = 行内最高子树的纵向占高。
      // 行居中于槽位（left 起、subtreeW(n) 宽）——不用父框中心，否则宽行向左
      // 溢出槽位压到上一个兄弟子树
      let rowEdge = dirSign === 1 ? y + m.h + rowGap : y - rowGap;
      for (const r of rows) {
        const rW = r.reduce((acc, k) => acc + subtreeW(k), 0) + o.siblingGap * (r.length - 1);
        const rH = Math.max(...r.map((k) => subtreeH(k)));
        let cursor = left + (sw - rW) / 2; // 行居中于槽位
        for (const k of r) {
          placeVertical(k, cursor, rowEdge, dirSign, branchIdx, n.id, depth + 1);
          cursor += subtreeW(k) + o.siblingGap;
        }
        rowEdge = dirSign === 1 ? rowEdge + rH + rowGap : rowEdge - rH - rowGap;
      }
    }
  }

  // 根放在原点；子树行从 x=0 起排（placeVertical 内部按父中心居中），根居中于第一行宽
  const firstRowNodes = root.children ?? [];
  let firstRowW = 0;
  {
    // 模拟第一行的行切分，取第一行宽度用于根定位
    let rowW = 0;
    let count = 0;
    for (const k of firstRowNodes) {
      const kw = subtreeW(k);
      if (count && rowW + o.siblingGap + kw > maxRowWidth) break;
      if (count) rowW += o.siblingGap;
      rowW += kw;
      count++;
    }
    firstRowW = rowW;
  }
  const rootX = firstRowW > rootM.w ? (firstRowW - rootM.w) / 2 : 0;

  out.push({
    id: idOf(root),
    type: root.type,
    text: String(root.text ?? ''),
    props: root.props ?? {},
    depth: 0,
    parentId: null,
    x: rootX,
    y: 0,
    w: rootM.w,
    h: rootM.h,
    hidden: false,
    childCount: (root.children ?? []).length,
    side: 'right',
    branch: -1,
    lines: rootM.lines,
    icon: resolveIcon(root),
    axis: 'v',
  });

  {
    // 根的子级同样按行切分（与 placeVertical 内部逻辑一致），各行居中于根中心
    const kids = root.children ?? [];
    const rows: Array<Array<{ k: BaseNode; i: number }>> = [];
    let row: Array<{ k: BaseNode; i: number }> = [];
    let rowW = 0;
    kids.forEach((k, i) => {
      const kw = subtreeW(k);
      if (row.length && rowW + o.siblingGap + kw > maxRowWidth) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      if (row.length) rowW += o.siblingGap;
      row.push({ k, i });
      rowW += kw;
    });
    if (row.length) rows.push(row);

    let rowEdge = dirSign === 1 ? rootM.h + rowGap : -rowGap;
    for (const r of rows) {
      const rW = r.reduce((acc, e) => acc + subtreeW(e.k), 0) + o.siblingGap * (r.length - 1);
      const rH = Math.max(...r.map((e) => subtreeH(e.k)));
      let cursor = rootX + (firstRowW > rootM.w ? (firstRowW - rW) / 2 : 0);
      for (const e of r) {
        placeVertical(e.k, cursor, rowEdge, dirSign, e.i, root.id, 1);
        cursor += subtreeW(e.k) + o.siblingGap;
      }
      rowEdge = dirSign === 1 ? rowEdge + rH + rowGap : rowEdge - rH - rowGap;
    }
  }

  return out;
}
