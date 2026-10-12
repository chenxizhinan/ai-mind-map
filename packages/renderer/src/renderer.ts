/**
 * Canvas 渲染器（正式版）。
 *
 * - XMind 风格连线：宽度与透明度随深度衰减、按顶层分支着色
 * - 多行文本渲染（布局阶段已换行），左枝右对齐
 * - 布局动画：节点位置/尺寸缓动过渡（200ms，数据变更时自动触发）
 * - 框选多选：空白处拖拽画 marquee，命中节点进入多选集合
 * - 拖拽指示：目标中间=子节点（虚线框），上/下边缘=兄弟节点（插入线）
 * - 悬浮/选中态、折叠胶囊、批注角标、优先级徽标
 * - 视口裁剪 + rAF 脏帧调度
 */
import type { FlatNode } from '@ai-mind-map/core';
import { visibleWorldRect, worldToScreen, type Viewport } from './viewport.js';

export interface Theme {
  canvasBg: string;
  rootFill: string;
  rootText: string;
  branchPalette: string[];
  level2Fill: string;
  level2Text: string;
  leafFill: string;
  leafStroke: string;
  leafText: string;
  linkBaseWidth: number;
  selectionColor: string;
  hoverOverlay: string;
  badgeColors: Record<string, string>;
  annBadgeFill: string;
  marqueeFill: string;
  marqueeStroke: string;
  insertLine: string;
}

export const defaultTheme: Theme = {
  canvasBg: '#f6f7fb',
  rootFill: '#1e293b',
  rootText: '#ffffff',
  branchPalette: [
    '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c',
    '#dc2626', '#7c3aed', '#db2777', '#0d9488', '#64748b',
  ],
  level2Fill: '#ffffff',
  level2Text: '#1e293b',
  leafFill: '#ffffff',
  leafStroke: '#e2e8f0',
  leafText: '#1e293b',
  linkBaseWidth: 3.5,
  selectionColor: '#2563eb',
  hoverOverlay: 'rgba(37, 99, 235, 0.08)',
  badgeColors: { P0: '#dc2626', P1: '#ea580c', P2: '#2563eb', P3: '#94a3b8' },
  annBadgeFill: '#dc2626',
  marqueeFill: 'rgba(37, 99, 235, 0.06)',
  marqueeStroke: 'rgba(37, 99, 235, 0.5)',
  insertLine: '#dc2626',
};

export interface RendererOptions {
  theme?: Partial<Theme>;
  onSelect?: (node: FlatNode | null) => void;
  /** 多选变化（框选/追加） */
  onMultiSelect?: (ids: string[]) => void;
  onToggleCollapse?: (node: FlatNode) => void;
  onActivate?: (node: FlatNode) => void;
  onContextMenu?: (node: FlatNode, screen: { x: number; y: number }) => void;
  /**
   * 拖放。position: 'child' 挂到 target 下；'before'/'after' 成为 target 的兄弟。
   */
  onDrop?: (node: FlatNode, target: FlatNode | null, position: 'child' | 'before' | 'after') => void;
}

/** 内置主题：默认（清爽蓝）/ 黑金（商务）/ 森绿（护眼） */
export const builtinThemes: Record<string, { label: string; theme: Partial<Theme> }> = {
  default: { label: '默认蓝', theme: {} },
  gold: {
    label: '黑金',
    theme: {
      canvasBg: '#191919',
      rootFill: '#d4af37',
      rootText: '#191919',
      branchPalette: ['#d4af37', '#c9a227', '#b8912f', '#e6c35c', '#a8842c', '#dbb84c', '#9c7a1f', '#f0d060', '#b8963e', '#8f701f'],
      level2Fill: '#242424',
      level2Text: '#f0e6c8',
      leafFill: '#202020',
      leafStroke: '#3a3a3a',
      leafText: '#e8e0c0',
      selectionColor: '#d4af37',
      hoverOverlay: 'rgba(212, 175, 55, 0.12)',
    },
  },
  forest: {
    label: '森绿',
    theme: {
      canvasBg: '#f2f7f2',
      rootFill: '#14532d',
      rootText: '#ffffff',
      branchPalette: ['#16a34a', '#15803d', '#166534', '#22c55e', '#0d9488', '#4d7c0f', '#3f6212', '#10b981', '#84cc16', '#4d7c0f'],
      leafStroke: '#d7e5da',
    },
  },
};

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 动画帧上的节点视觉状态 */
interface AnimState {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 = 完全显示，0 = 未出现（新节点淡入） */
  alpha: number;
}

const ANIM_MS = 200;

export class MindRenderer {
  private ctx: CanvasRenderingContext2D;
  /** 主画布（draw 的 dpr 判定用；exportPNG 时 canvas 会被临时替换） */
  private mainCanvas: HTMLCanvasElement;
  /** 当前绘制目标（主画布或导出画布） */
  private canvas: HTMLCanvasElement;
  private vp: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private nodes: FlatNode[] = [];
  private byId = new Map<string, FlatNode>();
  private openAnnCounts = new Map<string, number>();
  private dirty = true;
  private rafId = 0;
  private selectedId: string | null = null;
  private multiSelected = new Set<string>();
  private hoveredId: string | null = null;
  private theme: Theme;
  private ro: ResizeObserver;
  private cssW = 0;
  private cssH = 0;

  // 动画：nodeId → 当前渲染态（从上一位置向 setData 目标位置过渡）
  private anim = new Map<string, { from: { x: number; y: number; w: number; h: number; alpha: number }; start: number }>();
  private animating = false;

  // 框选
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

  // 搜索命中高亮
  private searchHits: Set<string> | null = null;
  private currentHitId: string | null = null;

  // 拖拽
  private dragMode: 'pan' | 'node' | 'marquee' | null = null;
  private panStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private dragNode: FlatNode | null = null;
  private dragMoved = false;
  private dropTargetId: string | null = null;
  private dropPosition: 'child' | 'before' | 'after' = 'child';

  constructor(
    canvas: HTMLCanvasElement,
    private opts: RendererOptions = {},
  ) {
    this.mainCanvas = canvas;
    this.canvas = canvas;
    this.theme = { ...defaultTheme, ...opts.theme };
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.bindEvents();
  }

  setData(nodes: FlatNode[], openAnnCounts?: Map<string, number>): void {
    const prevRects = new Map(this.byId);
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.openAnnCounts = openAnnCounts ?? new Map();
    // 记录动画起点：旧位置（或淡入）
    const now = performance.now();
    for (const n of nodes) {
      const prev = prevRects.get(n.id);
      if (prev) {
        if (prev.x !== n.x || prev.y !== n.y || prev.w !== n.w || prev.h !== n.h) {
          this.anim.set(n.id, {
            from: { x: prev.x, y: prev.y, w: prev.w, h: prev.h, alpha: 1 },
            start: now,
          });
        }
      } else if (!this.anim.has(n.id)) {
        // 新节点：从自身位置淡入
        this.anim.set(n.id, {
          from: { x: n.x, y: n.y, w: n.w, h: n.h, alpha: 0 },
          start: now,
        });
      }
    }
    this.startAnimLoop();
    this.dirty = true;
    this.requestFrame();
  }

  setViewport(vp: Partial<Viewport>): void {
    this.vp = { ...this.vp, ...vp };
    this.dirty = true;
    this.requestFrame();
  }

  setTheme(t: Partial<Theme>): void {
    this.theme = { ...defaultTheme, ...t };
    this.dirty = true;
    this.requestFrame();
  }

  get viewport(): Viewport {
    return this.vp;
  }

  select(id: string | null): void {
    this.selectedId = id;
    if (id) {
      this.multiSelected.clear();
      this.multiSelected.add(id);
    } else {
      this.multiSelected.clear();
    }
    this.dirty = true;
    this.requestFrame();
  }

  /** 设置多选集合（不改变单选） */
  setMultiSelect(ids: string[]): void {
    this.multiSelected = new Set(ids);
    this.dirty = true;
    this.requestFrame();
  }

  /** 搜索命中高亮；hits=null 清除。current 是当前定位的那一条（画更重描边）。 */
  setSearchHits(hits: Set<string> | null, current?: string | null): void {
    this.searchHits = hits;
    this.currentHitId = current ?? null;
    this.dirty = true;
    this.requestFrame();
  }

  get currentSearchHit(): string | null {
    return this.currentHitId;
  }

  /**
   * 离屏导出整张图：按所有节点的包围盒渲染到新 canvas，返回 dataURL。
   * pixelScale 控制输出分辨率（相对世界坐标像素），上限保证最长边 ≤ 8192。
   */
  exportPNG(): string | null {
    if (!this.nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    const pad = 48;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const w = x1 - x0;
    const h = y1 - y0;
    // 输出最长边目标 ≤ 8192（各浏览器 canvas 尺寸安全上限内）
    const pixelScale = Math.min(2, 8192 / Math.max(w, h));
    // 极端长宽比（全展开超大树）会缩成不可读的细条：拒绝导出，由调用方提示
    if (Math.min(w, h) * pixelScale < 150) return null;
    const out = document.createElement('canvas');
    out.width = Math.round(w * pixelScale);
    out.height = Math.round(h * pixelScale);
    const octx = out.getContext('2d')!;

    // 暂存现场：draw() 读取 canvas/ctx/vp/cssW/cssH，导出后恢复
    const saved = { canvas: this.canvas, ctx: this.ctx, vp: this.vp, cssW: this.cssW, cssH: this.cssH, dpr: window.devicePixelRatio || 1 };
    this.canvas = out;
    this.ctx = octx;
    this.cssW = w * pixelScale;
    this.cssH = h * pixelScale;
    this.vp = { scale: pixelScale, offsetX: -x0 * pixelScale, offsetY: -y0 * pixelScale };
    const animSaved = this.anim;
    const marqueeSaved = this.marquee;
    this.anim = new Map();
    this.marquee = null;
    try {
      this.draw();
    } finally {
      this.canvas = saved.canvas;
      this.ctx = saved.ctx;
      this.vp = saved.vp;
      this.cssW = saved.cssW;
      this.cssH = saved.cssH;
      this.anim = animSaved;
      this.marquee = marqueeSaved;
      this.dirty = true;
      this.requestFrame();
    }
    return out.toDataURL('image/png');
  }

  get multiSelectIds(): string[] {
    return [...this.multiSelected];
  }

  focusNode(id: string): void {
    const n = this.byId.get(id);
    if (!n) return;
    const s = Math.max(this.vp.scale, 0.8);
    this.setViewport({
      scale: s,
      offsetX: this.cssW / 2 - (n.x + n.w / 2) * s,
      offsetY: this.cssH / 2 - (n.y + n.h / 2) * s,
    });
  }

  hitTest(sx: number, sy: number): { node: FlatNode; zone: 'toggle' | 'body' } | null {
    const wx = (sx - this.vp.offsetX) / this.vp.scale;
    const wy = (sy - this.vp.offsetY) / this.vp.scale;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        return { node: n, zone: 'body' };
      }
      if (n.childCount > 0) {
        const pad = 30 / this.vp.scale;
        const halfH = 11 / this.vp.scale;
        const inX =
          n.side === 'left'
            ? wx >= n.x - pad && wx <= n.x - 2 / this.vp.scale
            : wx >= n.x + n.w + 2 / this.vp.scale && wx <= n.x + n.w + pad;
        const inY = wy >= n.y + n.h / 2 - halfH && wy <= n.y + n.h / 2 + halfH;
        if (inX && inY) return { node: n, zone: 'toggle' };
      }
    }
    return null;
  }

  /**
   * 拖放位置判定：目标节点上 1/4 = before 兄弟，下 1/4 = after 兄弟，中部 = child
   */
  private dropPositionAt(n: FlatNode, sy: number): 'child' | 'before' | 'after' {
    const r = this.nodeScreenRect(n);
    const rel = (sy - r.top) / r.height;
    if (n.depth === 0) return 'child'; // 根只接受子节点
    if (rel < 0.3) return 'before';
    if (rel > 0.7) return 'after';
    return 'child';
  }

  nodeScreenRect(n: FlatNode): { left: number; top: number; width: number; height: number } {
    const tl = worldToScreen(this.vp, n.x, n.y);
    return { left: tl.x, top: tl.y, width: n.w * this.vp.scale, height: n.h * this.vp.scale };
  }

  dispose(): void {
    this.ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('contextmenu', this.onContextMenuEvt);
    cancelAnimationFrame(this.rafId);
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent ? parent.clientWidth : this.canvas.clientWidth;
    const h = parent ? parent.clientHeight : this.canvas.clientHeight;
    const attrW = Math.round(w * dpr);
    const attrH = Math.round(h * dpr);
    if (w === this.cssW && h === this.cssH && this.canvas.width === attrW && this.canvas.height === attrH) {
      return;
    }
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = attrW;
    this.canvas.height = attrH;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dirty = true;
    this.requestFrame();
    if (!this.rafId) this.draw();
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('contextmenu', this.onContextMenuEvt);
  }

  // ---------- 交互 ----------

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.002);
      const scale = Math.min(8, Math.max(0.05, this.vp.scale * factor));
      const applied = scale / this.vp.scale;
      this.setViewport({
        scale,
        offsetX: sx - (sx - this.vp.offsetX) * applied,
        offsetY: sy - (sy - this.vp.offsetY) * applied,
      });
    } else {
      this.setViewport({ offsetX: this.vp.offsetX - e.deltaX, offsetY: this.vp.offsetY - e.deltaY });
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = this.hitTest(sx, sy);
    this.panStart = { x: e.clientX, y: e.clientY, ox: this.vp.offsetX, oy: this.vp.offsetY };
    this.dragMoved = false;
    if (hit) {
      this.dragMode = 'node';
      this.dragNode = hit.node;
    } else {
      // 空白按下：延迟判定是平移还是框选（移动超过阈值 = marquee）
      this.dragMode = 'marquee';
      this.marquee = { x0: sx, y0: sy, x1: sx, y1: sy };
    }
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (this.dragMode === 'marquee') {
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      if (!this.dragMoved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) this.dragMoved = true;
      if (this.dragMoved && this.marquee) {
        this.marquee.x1 = sx;
        this.marquee.y1 = sy;
        this.dirty = true;
        this.requestFrame();
      } else if (this.marquee) {
        // 未超过阈值时跟随（点击无位移时 marquee 无效）
        this.marquee.x1 = sx;
        this.marquee.y1 = sy;
      }
      return;
    }
    if (this.dragMode === 'pan') {
      this.setViewport({
        offsetX: this.panStart.ox + (e.clientX - this.panStart.x),
        offsetY: this.panStart.oy + (e.clientY - this.panStart.y),
      });
      return;
    }
    if (this.dragMode === 'node' && this.dragNode) {
      if (
        !this.dragMoved &&
        (Math.abs(e.clientX - this.panStart.x) > 4 || Math.abs(e.clientY - this.panStart.y) > 4)
      ) {
        this.dragMoved = true;
      }
      if (this.dragMoved) {
        const under = this.hitTest(sx, sy)?.node ?? null;
        const candidate = under && under.id !== this.dragNode.id ? under : null;
        const pos = candidate ? this.dropPositionAt(candidate, sy) : null;
        const changed = candidate?.id !== this.dropTargetId || (candidate && pos !== this.dropPosition);
        this.dropPosition = pos ?? this.dropPosition;
        this.dropTargetId = candidate?.id ?? null;
        if (changed) {
          this.dirty = true;
          this.requestFrame();
        }
      }
      return;
    }
    const hit = this.hitTest(sx, sy);
    const hid = hit?.node.id ?? null;
    if (hid !== this.hoveredId) {
      this.hoveredId = hid;
      this.dirty = true;
      this.requestFrame();
      this.canvas.style.cursor = hit?.zone === 'toggle' ? 'pointer' : hit ? 'default' : 'grab';
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (this.dragMode === 'marquee' && this.marquee) {
      if (this.dragMoved) {
        // 框选：收集与 marquee 相交的节点
        const wx0 = (Math.min(this.marquee.x0, this.marquee.x1) - this.vp.offsetX) / this.vp.scale;
        const wy0 = (Math.min(this.marquee.y0, this.marquee.y1) - this.vp.offsetY) / this.vp.scale;
        const wx1 = (Math.max(this.marquee.x0, this.marquee.x1) - this.vp.offsetX) / this.vp.scale;
        const wy1 = (Math.max(this.marquee.y0, this.marquee.y1) - this.vp.offsetY) / this.vp.scale;
        const hits: string[] = [];
        for (const n of this.nodes) {
          if (n.x + n.w >= wx0 && n.x <= wx1 && n.y + n.h >= wy0 && n.y <= wy1) hits.push(n.id);
        }
        this.multiSelected = new Set(hits);
        this.selectedId = hits.length === 1 ? hits[0]! : null;
        this.opts.onMultiSelect?.(hits);
        this.dirty = true;
        this.requestFrame();
      } else {
        // 空白单击 = 取消选择
        this.marquee = null;
        this.selectedId = null;
        this.multiSelected.clear();
        this.opts.onSelect?.(null);
        this.dirty = true;
        this.requestFrame();
      }
      this.marquee = null;
    } else if (this.dragMode === 'node' && this.dragNode) {
      if (this.dragMoved) {
        const targetId = this.dropTargetId;
        const pos = this.dropPosition;
        this.dropTargetId = null;
        const target = targetId ? this.byId.get(targetId) ?? null : null;
        this.opts.onDrop?.(this.dragNode, target, pos);
      } else {
        const hit = this.hitTest(sx, sy);
        if (hit?.zone === 'toggle') {
          this.selectedId = hit.node.id;
          this.opts.onToggleCollapse?.(hit.node);
        } else {
          this.selectedId = this.dragNode.id;
          this.multiSelected = new Set([this.dragNode.id]);
          this.opts.onSelect?.(this.dragNode);
        }
      }
      this.dirty = true;
      this.requestFrame();
    } else if (this.dragMode === 'pan' && !this.dragMoved) {
      this.selectedId = null;
      this.multiSelected.clear();
      this.opts.onSelect?.(null);
      this.dirty = true;
      this.requestFrame();
    }
    this.dragMode = null;
    this.dragNode = null;
    this.dragMoved = false;
  };

  private onPointerLeave = (): void => {
    if (this.hoveredId) {
      this.hoveredId = null;
      this.dirty = true;
      this.requestFrame();
    }
  };

  private onContextMenuEvt = (e: MouseEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      this.selectedId = hit.node.id;
      this.dirty = true;
      this.requestFrame();
      this.opts.onContextMenu?.(hit.node, { x: e.clientX, y: e.clientY });
    }
  };

  // ---------- 动画帧循环 ----------

  private startAnimLoop(): void {
    if (this.animating) return;
    this.animating = true;
    const tick = (): void => {
      const now = performance.now();
      let active = false;
      for (const [id, a] of this.anim) {
        if (now - a.start >= ANIM_MS) {
          this.anim.delete(id);
        } else {
          active = true;
        }
      }
      this.dirty = true;
      this.draw();
      if (active) {
        requestAnimationFrame(tick);
      } else {
        this.animating = false;
      }
    };
    requestAnimationFrame(tick);
  }

  // ---------- 绘制 ----------

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

  /** 计算节点当前动画位置（无动画则返回目标位置） */
  private animRect(n: FlatNode): { x: number; y: number; w: number; h: number; alpha: number } {
    const a = this.anim.get(n.id);
    if (!a) return { x: n.x, y: n.y, w: n.w, h: n.h, alpha: 1 };
    const t = Math.min(1, (performance.now() - a.start) / ANIM_MS);
    // easeOutCubic
    const e = 1 - Math.pow(1 - t, 3);
    return {
      x: a.from.x + (n.x - a.from.x) * e,
      y: a.from.y + (n.y - a.from.y) * e,
      w: a.from.w + (n.w - a.from.w) * e,
      h: a.from.h + (n.h - a.from.h) * e,
      alpha: (a.from.alpha ?? 1) + (1 - (a.from.alpha ?? 1)) * e,
    };
  }

  private draw(): void {
    const ctx = this.ctx;
    // dpr = 画布物理像素 / 逻辑像素。导出画布上 offset/scale 已按像素给出，
    // 用固定 1；主画布按 devicePixelRatio。
    const dpr = this.canvas === this.mainCanvas ? window.devicePixelRatio || 1 : 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.theme.canvasBg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // 动画期间节点可能从视口外滑入：按动画最大位移扩大裁剪框，而不是放弃裁剪
    let extra = 0;
    if (this.anim.size > 0) {
      for (const n of this.nodes) {
        const a = this.anim.get(n.id);
        if (!a) continue;
        extra = Math.max(extra, Math.abs(a.from.x - n.x), Math.abs(a.from.y - n.y));
      }
    }
    const rect = visibleWorldRect(this.vp, this.cssW, this.cssH, 120 + extra);
    const visible: FlatNode[] = [];
    const visibleParentIds = new Set<string>();
    for (const n of this.nodes) {
      if (!(
        n.x + n.w < rect.x0 || n.x > rect.x1 || n.y + n.h < rect.y0 || n.y > rect.y1
      )) {
        visible.push(n);
        if (n.parentId) visibleParentIds.add(n.parentId);
      }
    }

    for (const n of visible) {
      if (!n.parentId) continue;
      const p = this.byId.get(n.parentId);
      if (p) this.drawLink(p, n);
    }
    for (const n of visible) this.drawNode(n, visibleParentIds);

    // marquee
    if (this.marquee && this.dragMoved) {
      const m = this.marquee;
      const x = Math.min(m.x0, m.x1);
      const y = Math.min(m.y0, m.y1);
      const w = Math.abs(m.x1 - m.x0);
      const h = Math.abs(m.y1 - m.y0);
      ctx.fillStyle = this.theme.marqueeFill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this.theme.marqueeStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  private branchColor(n: FlatNode): string {
    if (n.depth === 0) return this.theme.rootFill;
    // 样式面板覆盖色优先
    const override = (n.props as { color?: string }).color;
    if (override) return override;
    const pal = this.theme.branchPalette;
    return pal[(n.branch ?? 0) % pal.length]!;
  }

  private drawLink(p: FlatNode, n: FlatNode): void {
    const ctx = this.ctx;
    const s = this.vp.scale;
    // 左侧子树的连线从父节点左缘出发（否则会横穿父节点框）
    const x1 = n.side === 'left' ? p.x : p.x + p.w;
    const y1 = p.y + p.h / 2;
    const x2 = n.x;
    const y2 = n.y + n.h / 2;
    const mx = (x1 + x2) / 2;
    const color = this.branchColor(n);
    const width = Math.max(1, (this.theme.linkBaseWidth - Math.min(n.depth - 1, 3) * 0.9) * s);
    ctx.strokeStyle = withAlpha(color, Math.max(0.2, 0.55 - Math.min(n.depth - 1, 4) * 0.07));
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1 * s + this.vp.offsetX, y1 * s + this.vp.offsetY);
    ctx.bezierCurveTo(
      mx * s + this.vp.offsetX, y1 * s + this.vp.offsetY,
      mx * s + this.vp.offsetX, y2 * s + this.vp.offsetY,
      x2 * s + this.vp.offsetX, y2 * s + this.vp.offsetY,
    );
    ctx.stroke();
  }

  private drawNode(n: FlatNode, visibleParentIds: Set<string>): void {
    const ctx = this.ctx;
    const s = this.vp.scale;
    const r = this.animRect(n);
    const p0 = worldToScreen(this.vp, r.x, r.y);
    const w = r.w * s;
    const h = r.h * s;
    const isRoot = n.depth === 0;
    const isSel = n.id === this.selectedId;
    const isMulti = this.multiSelected.has(n.id);
    const isHov = n.id === this.hoveredId;
    const isDrop = this.dropTargetId === n.id;
    const color = this.branchColor(n);
    const radius = isRoot ? 10 : n.depth === 1 ? 8 : 6;

    ctx.save();
    ctx.globalAlpha = r.alpha;

    // 框
    ctx.beginPath();
    ctx.roundRect(p0.x, p0.y, w, h, radius);
    if (isRoot) {
      ctx.fillStyle = this.theme.rootFill;
      ctx.fill();
    } else {
      ctx.fillStyle = this.theme.leafFill;
      ctx.fill();
      if (n.depth === 1) {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = color;
        if (n.side === 'left') ctx.fillRect(p0.x + w - 5 * s, p0.y, 5 * s, h);
        else ctx.fillRect(p0.x, p0.y, 5 * s, h);
        ctx.restore();
      }
      ctx.strokeStyle = isSel || isMulti
        ? this.theme.selectionColor
        : n.depth === 1
          ? withAlpha(color, 0.35)
          : this.theme.leafStroke;
      ctx.lineWidth = isSel || isMulti ? 2 : 1;
      ctx.stroke();
    }

    if (isHov && !isSel) {
      ctx.fillStyle = this.theme.hoverOverlay;
      ctx.beginPath();
      ctx.roundRect(p0.x, p0.y, w, h, radius);
      ctx.fill();
    }

    // 搜索命中：淡色填充；当前定位项加琥珀描边
    if (this.searchHits?.has(n.id)) {
      const isCur = n.id === this.currentHitId;
      ctx.beginPath();
      ctx.roundRect(p0.x, p0.y, w, h, radius);
      ctx.fillStyle = isCur ? 'rgba(245, 158, 11, 0.18)' : 'rgba(245, 158, 11, 0.08)';
      ctx.fill();
      if (isCur) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.strokeStyle = isSel || isMulti
          ? this.theme.selectionColor
          : n.depth === 1
            ? withAlpha(color, 0.35)
            : this.theme.leafStroke;
      }
    }

    // 文本（多行，左枝右对齐）；有类型图标时文本缩进一个图标位
    ctx.fillStyle = isRoot ? this.theme.rootText : this.theme.leafText;
    const fs = Math.max(8, 14 * s);
    ctx.font = `${isRoot ? '600 ' : ''}${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'middle';
    const lineH = 22 * s;
    const iconOffset = n.icon ? 20 * s : 0;
    const firstY = p0.y + (h - n.lines!.length * lineH) / 2 + lineH / 2;
    if (n.icon) {
      const iconColor = color === this.theme.rootFill ? this.theme.rootText : color;
      const iconCy = n.lines!.length > 1 ? firstY : p0.y + h / 2;
      const iconCx = p0.x + 8 * s + 5 * s; // 图标中心 x（16px 位内）
      const r = 4 * s;
      if (n.icon === 'dot') {
        // 实心圆点（叶子项，如测试用例）
        ctx.beginPath();
        ctx.arc(iconCx, iconCy, r, 0, Math.PI * 2);
        ctx.fillStyle = iconColor;
        ctx.fill();
      } else if (n.icon === 'square') {
        // 空心方框（容器，如模块路径）
        ctx.beginPath();
        ctx.roundRect(iconCx - r, iconCy - r, r * 2, r * 2, 1.5 * s);
        ctx.strokeStyle = iconColor;
        ctx.lineWidth = 1.5 * s;
        ctx.stroke();
      } else {
        // 自定义单字符（emoji/符号）：按文本绘制
        ctx.font = `${Math.max(9, 13 * s)}px -apple-system, "Apple Color Emoji", "PingFang SC", sans-serif`;
        ctx.fillText(n.icon, p0.x + 8 * s, iconCy);
      }
    }
    ctx.font = `${isRoot ? '600 ' : ''}${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    n.lines!.forEach((line, i) => {
      if (n.side === 'left') {
        ctx.fillText(line, p0.x + w - 8 * s - textWOf(line, fs) - iconOffset, firstY + i * lineH);
      } else {
        ctx.fillText(line, p0.x + 8 * s + iconOffset, firstY + i * lineH);
      }
    });

    // 优先级徽标
    const pr = (n.props as { priority?: string }).priority;
    if (pr && n.depth > 0) {
      const bw = 24 * s;
      const bx = n.side === 'left' ? p0.x + 6 * s : p0.x + w - 6 * s - bw;
      ctx.beginPath();
      ctx.roundRect(bx, p0.y + h / 2 - 9 * s, bw, 18 * s, 4 * s);
      ctx.fillStyle = this.theme.badgeColors[pr] ?? '#94a3b8';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(8, 10 * s)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(pr, bx + bw / 2, p0.y + h / 2 + 0.5);
      ctx.textAlign = 'left';
    }

    // 批注角标
    const ann = this.openAnnCounts.get(n.id) ?? 0;
    if (ann > 0) {
      const rr = 8 * s;
      const cx = n.side === 'left' ? p0.x - rr + 2 : p0.x + w - rr - 2;
      const cy = p0.y + 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.annBadgeFill;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(8, 10 * s)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(ann > 9 ? '9+' : String(ann), cx, cy + 0.5);
      ctx.textAlign = 'left';
    }

    // 折叠指示
    if (n.childCount > 0 && !visibleParentIds.has(n.id)) {
      const label = String(n.childCount);
      ctx.font = `500 ${Math.max(8, 11 * s)}px -apple-system, sans-serif`;
      const labelW = ctx.measureText(label).width;
      const cx = n.side === 'left' ? p0.x - 15 * s : p0.x + w + 15 * s;
      const cy = p0.y + h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 11 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.55);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#64748b';
      ctx.fillText(label, n.side === 'left' ? cx - 15 * s - labelW : cx + 15 * s, p0.y + h / 2);
    }

    // 拖放指示
    if (isDrop) {
      if (this.dropPosition === 'child') {
        ctx.strokeStyle = this.theme.selectionColor;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(p0.x - 3, p0.y - 3, w + 6, h + 6);
        ctx.setLineDash([]);
      } else {
        // 插入线（before: 顶缘；after: 底缘）
        const iy = this.dropPosition === 'before' ? p0.y - 2 : p0.y + h + 2;
        ctx.strokeStyle = this.theme.insertLine;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(p0.x - 6, iy);
        ctx.lineTo(p0.x + w + 6, iy);
        ctx.stroke();
        // 两端小三角
        ctx.fillStyle = this.theme.insertLine;
        ctx.beginPath();
        ctx.moveTo(p0.x - 6, iy);
        ctx.lineTo(p0.x - 1, iy - 4);
        ctx.lineTo(p0.x - 1, iy + 4);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(p0.x + w + 6, iy);
        ctx.lineTo(p0.x + w + 1, iy - 4);
        ctx.lineTo(p0.x + w + 1, iy + 4);
        ctx.fill();
      }
    }
    ctx.restore();
  }

}

function textWOf(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) w += (ch.charCodeAt(0) > 0x2e7f ? 15 : 8) * (fs / 14);
  return w;
}

