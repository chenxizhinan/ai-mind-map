/**
 * 视口状态与坐标变换。
 *
 * 世界坐标（布局输出）↔ 屏幕坐标（canvas CSS 像素）。
 * screen = world * scale + offset；world = (screen - offset) / scale
 */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function worldToScreen(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: x * vp.scale + vp.offsetX, y: y * vp.scale + vp.offsetY };
}

export function screenToWorld(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - vp.offsetX) / vp.scale, y: (y - vp.offsetY) / vp.scale };
}

/** 以屏幕点 (sx, sy) 为锚点缩放，保持锚点下的世界坐标不动 */
export function zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = Math.min(8, Math.max(0.05, vp.scale * factor));
  const applied = scale / vp.scale;
  return {
    scale,
    offsetX: sx - (sx - vp.offsetX) * applied,
    offsetY: sy - (sy - vp.offsetY) * applied,
  };
}

/** 可视世界矩形（含 margin，用于裁剪） */
export function visibleWorldRect(
  vp: Viewport,
  cssW: number,
  cssH: number,
  margin = 120,
): { x0: number; y0: number; x1: number; y1: number } {
  const tl = screenToWorld(vp, -margin, -margin);
  const br = screenToWorld(vp, cssW + margin, cssH + margin);
  return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
}
