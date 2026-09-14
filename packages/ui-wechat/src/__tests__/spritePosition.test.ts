/**
 * @file spritePosition.test.ts
 * 固定立绘的位置计算与钳制。
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SPRITE_POSITION,
  applyDragDelta,
  clampSpritePosition,
} from "../utils/spritePosition";

const SPRITE = { width: 200, height: 320 };
const VIEWPORT = { width: 1280, height: 720 };

describe("clampSpritePosition", () => {
  it("正常范围内的位置原样保留", () => {
    expect(clampSpritePosition({ x: 300, y: 200 }, SPRITE, VIEWPORT)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it("负坐标被推回最小边距", () => {
    expect(clampSpritePosition({ x: -50, y: -50 }, SPRITE, VIEWPORT)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("超出右下会被钳制到「完整可见」的最大值", () => {
    expect(
      clampSpritePosition({ x: 5000, y: 5000 }, SPRITE, VIEWPORT),
    ).toEqual({
      x: VIEWPORT.width - SPRITE.width - 8,
      y: VIEWPORT.height - SPRITE.height - 8,
    });
  });

  it("窗口比立绘还小时退化为最小边距（不出现负值）", () => {
    const tiny = { width: 120, height: 200 };
    expect(
      clampSpritePosition({ x: 100, y: 100 }, SPRITE, tiny),
    ).toEqual({ x: 8, y: 8 });
  });

  it("非法数值退回默认位置", () => {
    expect(
      clampSpritePosition({ x: Number.NaN, y: Number.NaN }, SPRITE, VIEWPORT),
    ).toEqual(DEFAULT_SPRITE_POSITION);
  });
});

describe("applyDragDelta", () => {
  it("横向位移直接相加", () => {
    expect(applyDragDelta({ x: 100, y: 100 }, { dx: 40, dy: 0 }).x).toBe(140);
  });

  it("屏幕向下为正，而位置是「距下边缘」，所以纵向要取反", () => {
    // 往下拖 30px → 距下边缘应该减少 30
    expect(applyDragDelta({ x: 100, y: 100 }, { dx: 0, dy: 30 }).y).toBe(70);
  });
});
