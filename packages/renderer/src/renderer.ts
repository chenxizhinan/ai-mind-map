/**
 * Canvas 渲染器（正式版）。
 *
 * - XMind 风格连线：宽度与透明度随深度衰减、按顶层分支着色
 * - 多行文本渲染（布局阶段已换行），左枝右对齐
 * - 悬浮/选中态、折叠胶囊、批注角标、优先级徽标、拖拽目标虚线
 * - 视口裁剪 + rAF 脏帧调度（静止零开销）
 * - 交互回调：选择 / 折叠 / 激活 / 右键 / 拖放
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
};

export interface RendererOptions {
  theme?: Partial<Theme>;
  onSelect?: (node: FlatNode | null) => void;
  onToggleCollapse?: (node: FlatNode) => void;
  onActivate?: (node: FlatNode) => void;
  onContextMenu?: (node: FlatNode, screen: { x: number; y: number }) => void;
  /** 拖放：把 node 子树挂到 target 下（target null = 顶层移动，应用层可拒绝） */
  onDrop?: (node: FlatNode, target: FlatNode | null) => void;
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
  }

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

  /** 运行时切换主题（合并到默认主题） */
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
    this.dirty = true;
    this.requestFrame();
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
      // 框内
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        return { node: n, zone: 'body' };
      }
      // 折叠胶囊（框外侧，随方向）
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

  // ---------- 交互状态 ----------
  private dragMode: 'pan' | 'node' | null = null;
  private panStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private dragNode: FlatNode | null = null;
  private dragMoved = false;
  private dropTargetId: string | null = null;

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
    this.dragMode = hit ? 'node' : 'pan';
    this.panStart = { x: e.clientX, y: e.clientY, ox: this.vp.offsetX, oy: this.vp.offsetY };
    this.dragNode = hit ? hit.node : null;
    this.dragMoved = false;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
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
        const changed = candidate?.id !== this.dropTargetId;
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
    if (this.dragMode === 'node' && this.dragNode) {
      if (this.dragMoved) {
        const targetId = this.dropTargetId;
        this.dropTargetId = null;
        const target = targetId ? this.byId.get(targetId) ?? null : null;
        this.opts.onDrop?.(this.dragNode, target);
      } else {
        const hit = this.hitTest(sx, sy);
        if (hit?.zone === 'toggle') {
          this.selectedId = hit.node.id;
          this.opts.onToggleCollapse?.(hit.node);
        } else {
          this.selectedId = this.dragNode.id;
          this.opts.onSelect?.(this.dragNode);
        }
      }
      this.dirty = true;
      this.requestFrame();
    } else if (this.dragMode === 'pan' && !this.dragMoved) {
      // 空白单击 = 取消选择
      this.selectedId = null;
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
    ctx.fillStyle = this.theme.canvasBg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const rect = visibleWorldRect(this.vp, this.cssW, this.cssH);
    const visible: FlatNode[] = [];
    for (const n of this.nodes) {
      if (n.x + n.w < rect.x0 || n.x > rect.x1 || n.y + n.h < rect.y0 || n.y > rect.y1) continue;
      visible.push(n);
    }

    for (const n of visible) {
      if (!n.parentId) continue;
      const p = this.byId.get(n.parentId);
      if (p) this.drawLink(p, n);
    }
    for (const n of visible) this.drawNode(n);
  }

  private branchColor(n: FlatNode): string {
    if (n.depth === 0) return this.theme.rootFill;
    const pal = this.theme.branchPalette;
    return pal[(n.branch ?? 0) % pal.length]!;
  }

  private drawLink(p: FlatNode, n: FlatNode): void {
    const ctx = this.ctx;
    const s = this.vp.scale;
    const x1 = p.x + p.w;
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

  private drawNode(n: FlatNode): void {
    const ctx = this.ctx;
    const s = this.vp.scale;
    const p0 = worldToScreen(this.vp, n.x, n.y);
    const w = n.w * s;
    const h = n.h * s;
    const isRoot = n.depth === 0;
    const isSel = n.id === this.selectedId;
    const isHov = n.id === this.hoveredId;
    const isDrop = this.dropTargetId === n.id;
    const color = this.branchColor(n);
    const radius = isRoot ? 10 : n.depth === 1 ? 8 : 6;

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
        // 左侧分支色条（左枝画在右缘）
        ctx.save();
        ctx.clip();
        ctx.fillStyle = color;
        if (n.side === 'left') ctx.fillRect(p0.x + w - 5 * s, p0.y, 5 * s, h);
        else ctx.fillRect(p0.x, p0.y, 5 * s, h);
        ctx.restore();
      }
      ctx.strokeStyle = isSel
        ? this.theme.selectionColor
        : n.depth === 1
          ? withAlpha(color, 0.35)
          : this.theme.leafStroke;
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.stroke();
    }

    if (isHov && !isSel) {
      ctx.fillStyle = this.theme.hoverOverlay;
      ctx.beginPath();
      ctx.roundRect(p0.x, p0.y, w, h, radius);
      ctx.fill();
    }

    // 文本（多行，左枝右对齐）
    ctx.fillStyle = isRoot ? this.theme.rootText : this.theme.leafText;
    const fs = Math.max(8, 14 * s);
    ctx.font = `${isRoot ? '600 ' : ''}${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'middle';
    const lineH = 22 * s;
    const firstY = p0.y + (h - n.lines!.length * lineH) / 2 + lineH / 2;
    n.lines!.forEach((line, i) => {
      if (n.side === 'left') {
        const lw = ctx.measureText(line).width;
        ctx.fillText(line, p0.x + w - 8 * s - textWOf(line, fs), firstY + i * lineH);
      } else {
        ctx.fillText(line, p0.x + 8 * s, firstY + i * lineH);
      }
    });

    // 优先级徽标（框内远端）
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

    // 批注角标（框外近上角）
    const ann = this.openAnnCounts.get(n.id) ?? 0;
    if (ann > 0) {
      const r = 8 * s;
      const cx = n.side === 'left' ? p0.x - r + 2 : p0.x + w - r - 2;
      const cy = p0.y + 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.annBadgeFill;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(8, 10 * s)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(ann > 9 ? '9+' : String(ann), cx, cy + 0.5);
      ctx.textAlign = 'left';
    }

    // 折叠指示（XMind 风格：白底圆点 + 内色点 + 侧边数字）
    if (n.childCount > 0 && !this.hasVisibleChildren(n)) {
      const label = String(n.childCount);
      ctx.font = `500 ${Math.max(8, 11 * s)}px -apple-system, sans-serif`;
      const labelW = ctx.measureText(label).width;
      const cx = n.side === 'left' ? p0.x - 15 * s : p0.x + w + 15 * s;
      const cy = p0.y + h / 2;
      // 圆底（白色，带分支色描边）
      ctx.beginPath();
      ctx.arc(cx, cy, 11 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.55);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 内色点
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      // 数量标签
      ctx.fillStyle = '#64748b';
      ctx.fillText(label, n.side === 'left' ? cx - 15 * s - labelW : cx + 15 * s, p0.y + h / 2);
    }

    if (isDrop) {
      ctx.strokeStyle = this.theme.selectionColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(p0.x - 3, p0.y - 3, w + 6, h + 6);
      ctx.setLineDash([]);
    }
  }

  private hasVisibleChildren(n: FlatNode): boolean {
    return this.nodes.some((m) => m.parentId === n.id);
  }
}

function textWOf(s: string, fs: number): number {
  // 与布局近似字宽一致的右对齐测量
  let w = 0;
  for (const ch of s) w += (ch.charCodeAt(0) > 0x2e7f ? 15 : 8) * (fs / 14);
  return w;
}
