/**
 * @file spritePosition.ts
 * 固定立绘的位置计算（纯函数，可单测）。
 *
 * 坐标约定与 CSS 一致：`x` 是距窗口左边缘的像素，`y` 是距窗口**下边缘**的像素
 * （所以默认值是 `{ x: 16, y: 60 }`，对应 `left:16px; bottom:60px`）。
 */

/** 立绘在屏幕上的位置（距左 / 距下）。 */
export interface ISpritePosition {
  readonly x: number;
  readonly y: number;
}

/** 默认位置：左下角偏内，和原来的 CSS 一致。 */
export const DEFAULT_SPRITE_POSITION: ISpritePosition = { x: 16, y: 60 };

/** 屏幕边缘至少留出的空隙。 */
const EDGE_MARGIN = 8;

/**
 * 把位置钳制到"立绘完整可见"的范围内。
 *
 * 窗口变小、或在旧机器上存过一个大坐标时，立绘不该跑到屏幕外找不回来；
 * 同时保证最小边距，避免贴着边缘甚至被裁掉一半。
 */
export function clampSpritePosition(
  position: ISpritePosition,
  spriteSize: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): ISpritePosition {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - spriteSize.width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, viewport.height - spriteSize.height - EDGE_MARGIN);

  const x = Number.isFinite(position.x) ? position.x : DEFAULT_SPRITE_POSITION.x;
  const y = Number.isFinite(position.y) ? position.y : DEFAULT_SPRITE_POSITION.y;

  return {
    x: Math.min(Math.max(EDGE_MARGIN, x), maxX),
    y: Math.min(Math.max(EDGE_MARGIN, y), maxY),
  };
}

/**
 * 把一次拖拽位移换算成新位置。
 *
 * 屏幕坐标里 y 向下增大，而立绘位置用的是"距下边缘"，所以要取反。
 */
export function applyDragDelta(
  start: ISpritePosition,
  delta: { readonly dx: number; readonly dy: number },
): ISpritePosition {
  return { x: start.x + delta.dx, y: start.y - delta.dy };
}
