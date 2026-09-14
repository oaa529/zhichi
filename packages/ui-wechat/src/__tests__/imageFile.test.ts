/**
 * @file imageFile.test.ts
 * 图片等比缩放（读写文件那部分依赖 canvas，在浏览器里验证）。
 */

import { describe, it, expect } from "vitest";
import { fitWithin } from "../utils/imageFile";

describe("fitWithin", () => {
  it("已经够小的图片不放大", () => {
    expect(fitWithin(100, 80, 256)).toEqual({ width: 100, height: 80 });
  });

  it("长边缩到上限，短边等比跟随", () => {
    expect(fitWithin(1024, 512, 256)).toEqual({ width: 256, height: 128 });
    expect(fitWithin(512, 1024, 256)).toEqual({ width: 128, height: 256 });
  });

  it("正方形缩放到上限", () => {
    expect(fitWithin(1000, 1000, 256)).toEqual({ width: 256, height: 256 });
  });

  it("极端长图短边至少保留 1 像素（不能缩成 0）", () => {
    expect(fitWithin(4000, 3, 512)).toEqual({ width: 512, height: 1 });
  });

  it("异常尺寸退化为正方形上限，不产出 NaN", () => {
    expect(fitWithin(0, 100, 256)).toEqual({ width: 256, height: 256 });
    expect(fitWithin(Number.NaN, 100, 256)).toEqual({ width: 256, height: 256 });
  });
});
