/**
 * Canvas 渲染器：视口裁剪 + 逐帧重绘。
 *
 * 性能模型（对应调研报告 §2）：
 * - 节点/连线/角标全部画在 canvas，DOM 里只有被编辑/悬停的节点。
 * - 平移缩放不重建布局，只按 visibleWorldRect 求交绘制相交节点。
 * - 绘制循环挂在 rAF：有 dirty 标记才重绘，静止零开销。
 */
import type { FlatNode } from '@ai-mind-map/core';
import {
  visibleWorldRect,
  worldToScreen,
  type Viewport,
} from './viewport.js';

export interface Theme {
  pathFill: string;
  pathStroke: string;
  pathText: string;
  caseFill: string;
  caseStroke: string;
  caseText: string;
  linkColor: string;
  badgeColors: Record<string, string>;
  selectionColor: string;
  rootFill: string;
  rootText: string;
}

export const defaultTheme: Theme = {
  pathFill: '#eef2ff',
  pathStroke: '#c7d2fe',
  pathText: '#3730a3',
  caseFill: '#ffffff',
  caseStroke: '#e2e8f0',
  caseText: '#1e293b',
  linkColor: '#cbd5e1',
  badgeColors: {
    critical: '#dc2626',
    warning: '#ea580c',
    info: '#2563eb',
    muted: '#94a3b8',
  },
  selectionColor: '#2563eb',
  rootFill: '#1e293b',
  rootText: '#ffffff',
};

export interface RendererOptions {
  theme?: Partial<Theme>;
  /** 节点被选中回调（画布点击） */
  onSelect?: (node: FlatNode | null) => void;
  /** 请求展开/折叠（renderer 不持有树，交回应用层处理） */
  onToggleCollapse?: (node: FlatNode) => void;
  /** 双击节点（进入编辑） */
  onActivate?: (node: FlatNode) => void;
}

export class MindRenderer {
  private ctx: CanvasRenderingContext2D;
  private vp: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private nodes: FlatNode[] = [];
  private byId = new Map<string, FlatNode>();
  private openAnnCounts = new Map<string, number>();
  private dirty = true;
  private rafId = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private theme: Theme;
  private ro: ResizeObserver;
  private cssW = 0;
  private cssH = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: RendererOptions = {},
  ) {
    this.theme = { ...defaultTheme, ...opts.theme };
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.bindEvents();
    this.requestFrame();
  }

  /** 更新数据（布局已完成）；不做任何布局计算 */
  setData(nodes: FlatNode[], openAnnCounts?: Map<string, number>): void {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.openAnnCounts = openAnnCounts ?? new Map();
    this.dirty = true;
    this.requestFrame();
  }

  setViewport(vp: Partial<Viewport>): void {
    this.vp = { ...this.vp, ...vp };
    this.dirty = true;
    this.requestFrame();
  }

  get viewport(): Viewport {
    return this.vp;
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.dirty = true;
    this.requestFrame();
  }

  /** 平移视口使节点居中可见（批注导航用） */
  focusNode(id: string): void {
    const n = this.byId.get(id);
    if (!n) return;
    const w = this.cssW;
    const h = this.cssH;
    this.setViewport({
      scale: Math.max(this.vp.scale, 0.8),
      offsetX: w / 2 - (n.x + n.w / 2) * Math.max(this.vp.scale, 0.8),
      offsetY: h / 2 - (n.y + n.h / 2) * Math.max(this.vp.scale, 0.8),
    });
  }

  /** 命中测试：屏幕坐标 → 节点；点在折叠按钮上时返回 { node, zone: 'toggle' } */
  hitTest(sx: number, sy: number): { node: FlatNode; zone: 'toggle' | 'body' } | null {
    const wx = (sx - this.vp.offsetX) / this.vp.scale;
    const wy = (sy - this.vp.offsetY) / this.vp.scale;
    // 从后往前（后绘制者在上层）
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        // 折叠按钮：节点右缘 +N 胶囊（世界坐标 ~26px 宽）
        if (n.childCount > 0 && wx > n.x + n.w && wx <= n.x + n.w + 26 / this.vp.scale) {
          return { node: n, zone: 'toggle' };
        }
        return { node: n, zone: 'body' };
      }
    }
    // +N 胶囊在节点框外，单独扫一遍（只对有子节点的节点）
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.childCount === 0) continue;
      const pad = 26 / this.vp.scale;
      if (wx > n.x + n.w && wx <= n.x + n.w + pad && wy >= n.y + n.h / 2 - 11 / this.vp.scale && wy <= n.y + n.h / 2 + 11 / this.vp.scale) {
        return { node: n, zone: 'toggle' };
      }
    }
    return null;
  }

  /** 世界坐标 → 屏幕（DOM overlay 定位用） */
  nodeScreenRect(n: FlatNode): { left: number; top: number; width: number; height: number } {
    const tl = worldToScreen(this.vp, n.x, n.y);
    return { left: tl.x, top: tl.y, width: n.w * this.vp.scale, height: n.h * this.vp.scale };
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent ? parent.clientWidth : this.canvas.clientWidth;
    const h = parent ? parent.clientHeight : this.canvas.clientHeight;
    const attrW = Math.round(w * dpr);
    const attrH = Math.round(h * dpr);
    // 尺寸没变就不动位图——ResizeObserver 的迟到回调会在这里把刚画好的
    // 内容清掉（canvas.width 赋值即清空），且 dirty 已被消费导致不再重绘
    if (w === this.cssW && h === this.cssH && this.canvas.width === attrW && this.canvas.height === attrH) {
      return;
    }
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = attrW;
    this.canvas.height = attrH;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // 位图已重置，无条件重绘一帧（不受 dirty 影响）
    this.dirty = true;
    this.requestFrame();
    if (!this.rafId) {
      // dirty 被上一次 rAF 消费完的情况下 requestFrame 会提前返回，这里兜底直接画
      this.draw();
    }
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('dblclick', this.onDblClick);
    c.addEventListener('pointerleave', this.onPointerLeave);
  }

  dispose(): void {
    this.ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('dblclick', this.onDblClick);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    cancelAnimationFrame(this.rafId);
  }

  private dragging = false;
  private dragStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private dragMoved = false;

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.002);
      this.setViewport(zoomAtViewport(this.vp, sx, sy, factor));
    } else {
      this.setViewport({ offsetX: this.vp.offsetX - e.deltaX, offsetY: this.vp.offsetY - e.deltaY });
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.dragMoved = false;
    this.dragStart = { x: e.clientX, y: e.clientY, ox: this.vp.offsetX, oy: this.vp.offsetY };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (this.dragging) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true;
      this.setViewport({ offsetX: this.dragStart.ox + dx, offsetY: this.dragStart.oy + dy });
      return;
    }
    const hit = this.hitTest(sx, sy);
    const hid = hit?.node.id ?? null;
    if (hid !== this.hoveredId) {
      this.hoveredId = hid;
      this.dirty = true;
      this.requestFrame();
      this.canvas.style.cursor =
        hit?.zone === 'toggle' ? 'pointer' : hit ? 'default' : 'grab';
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
    if (!this.dragMoved) {
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit?.zone === 'toggle') {
        this.selectedId = hit.node.id;
        this.opts.onToggleCollapse?.(hit.node);
      } else {
        this.selectedId = hit?.node.id ?? null;
        this.opts.onSelect?.(hit?.node ?? null);
      }
      this.dirty = true;
      this.requestFrame();
    }
  };

  private onDblClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit && hit.zone === 'body') this.opts.onActivate?.(hit.node);
  };

  private onPointerLeave = (): void => {
    if (this.hoveredId) {
      this.hoveredId = null;
      this.dirty = true;
      this.requestFrame();
    }
  };

  private requestFrame(): void {
    if (this.rafId || !this.dirty) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const rect = visibleWorldRect(this.vp, this.cssW, this.cssH);
    const visible: FlatNode[] = [];
    for (const n of this.nodes) {
      if (n.x + n.w < rect.x0 || n.x > rect.x1 || n.y + n.h < rect.y0 || n.y > rect.y1) continue;
      visible.push(n);
    }

    // 连线先画（在节点下层）
    ctx.strokeStyle = this.theme.linkColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const n of visible) {
      if (!n.parentId) continue;
      const p = this.byId.get(n.parentId);
      if (!p) continue;
      const x1 = p.x + p.w;
      const y1 = p.y + p.h / 2;
      const x2 = n.x;
      const y2 = n.y + n.h / 2;
      const mx = (x1 + x2) / 2;
      ctx.moveTo(x1 * this.vp.scale + this.vp.offsetX, y1 * this.vp.scale + this.vp.offsetY);
      ctx.bezierCurveTo(
        mx * this.vp.scale + this.vp.offsetX, y1 * this.vp.scale + this.vp.offsetY,
        mx * this.vp.scale + this.vp.offsetX, y2 * this.vp.scale + this.vp.offsetY,
        x2 * this.vp.scale + this.vp.offsetX, y2 * this.vp.scale + this.vp.offsetY,
      );
    }
    ctx.stroke();

    // 节点
    for (const n of visible) this.drawNode(n);
  }

  private drawNode(n: FlatNode): void {
    const ctx = this.ctx;
    const s = worldToScreen(this.vp, n.x, n.y);
    const w = n.w * this.vp.scale;
    const h = n.h * this.vp.scale;
    const isRoot = n.depth === 0;
    const isPath = n.type !== 'case' && !isRoot;

    // 框
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, w, h, isRoot ? 12 : 8);
    if (isRoot) {
      ctx.fillStyle = this.theme.rootFill;
    } else if (isPath) {
      ctx.fillStyle = this.theme.pathFill;
    } else {
      ctx.fillStyle = this.theme.caseFill;
    }
    ctx.fill();
    ctx.strokeStyle = n.id === this.selectedId
      ? this.theme.selectionColor
      : isRoot ? this.theme.rootFill : isPath ? this.theme.pathStroke : this.theme.caseStroke;
    ctx.lineWidth = n.id === this.selectedId ? 2.5 : 1;
    ctx.stroke();

    // 文本
    ctx.fillStyle = isRoot ? this.theme.rootText : isPath ? this.theme.pathText : this.theme.caseText;
    const fontSize = Math.max(9, 14 * this.vp.scale);
    ctx.font = `${isRoot ? '600' : '400'} ${fontSize}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textBaseline = 'middle';
    const maxTextW = w - 16;
    let label = n.text;
    if (ctx.measureText(label).width > maxTextW) {
      while (label.length > 1 && ctx.measureText(label + '…').width > maxTextW) {
        label = label.slice(0, -1);
      }
      label += '…';
    }
    ctx.fillText(label, s.x + 8, s.y + h / 2);

    // 徽标（优先级等）右对齐
    if (n.depth > 0) this.drawBadges(n, s.x, s.y, w, h, fontSize);

    // 批注角标
    const annCount = this.openAnnCounts.get(n.id) ?? 0;
    if (annCount > 0) {
      const r = 8;
      const cx = s.x + w - r - 2;
      const cy = s.y - r + 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(9, 10 * this.vp.scale)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(annCount > 9 ? '9+' : String(annCount), cx, cy + 0.5);
      ctx.textAlign = 'left';
    }

    // 折叠指示（有子节点且折叠时在右缘画 +N）
    if (n.childCount > 0 && !this.isExpandedVisible(n)) {
      const label = `+${n.childCount}`;
      ctx.font = `500 ${Math.max(9, 11 * this.vp.scale)}px -apple-system, sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.beginPath();
      ctx.roundRect(s.x + w + 4, s.y + h / 2 - 9, tw + 10, 18, 9);
      ctx.fillStyle = '#f1f5f9';
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#475569';
      ctx.fillText(label, s.x + w + 9, s.y + h / 2);
    }
  }

  private drawBadges(n: FlatNode, x: number, y: number, w: number, h: number, fontSize: number): void {
    const ctx = this.ctx;
    // 徽标从右侧往左画；颜色由 type describe 决定——这里简化为 priority 色条
    const p = (n.props as { priority?: string }).priority;
    if (!p) return;
    const colors: Record<string, string> = {
      P0: '#dc2626',
      P1: '#ea580c',
      P2: '#2563eb',
      P3: '#94a3b8',
    };
    ctx.fillStyle = colors[p] ?? '#94a3b8';
    ctx.beginPath();
    ctx.roundRect(x + w - 30, y + 6, 22, h - 12, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.max(9, 10 * this.vp.scale)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(p, x + w - 19, y + h / 2);
    ctx.textAlign = 'left';
  }

  private isExpandedVisible(_n: FlatNode): boolean {
    // 布局只输出可见节点；有子节点却未见子节点 = 折叠。
    // childCount>0 且该节点 id 的子节点不在 nodes 中（渲染器无法直接判断，
    // 由 demo 层在数据组装时保证：折叠节点仍出现在 flat 里，childCount 正确）。
    return !this.nodes.some((m) => m.parentId === _n.id);
  }
}

function zoomAtViewport(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = Math.min(8, Math.max(0.05, vp.scale * factor));
  const applied = scale / vp.scale;
  return {
    scale,
    offsetX: sx - (sx - vp.offsetX) * applied,
    offsetY: sy - (sy - vp.offsetY) * applied,
  };
}
