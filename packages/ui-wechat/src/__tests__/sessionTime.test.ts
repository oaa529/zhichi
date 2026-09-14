/**
 * @file sessionTime.test.ts
 * 会话列表时间格式测试（今天 / 昨天 / 一周内 / 更早 / 跨年）。
 */

import { describe, it, expect } from "vitest";
import { formatSessionTime } from "../utils/sessionTime";

/** 2026-09-12 是星期六。 */
const NOW = new Date(2026, 8, 12, 20, 0, 0).getTime();

function at(y: number, m: number, d: number, hh = 12, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

describe("formatSessionTime", () => {
  it("空时间戳返回空字符串", () => {
    expect(formatSessionTime(0, NOW)).toBe("");
  });

  it("今天显示 HH:mm", () => {
    expect(formatSessionTime(at(2026, 9, 12, 9, 5), NOW)).toBe("09:05");
  });

  it("昨天显示「昨天」", () => {
    expect(formatSessionTime(at(2026, 9, 11, 23, 30), NOW)).toBe("昨天");
  });

  it("一周内显示星期", () => {
    // 9/8 是星期二
    expect(formatSessionTime(at(2026, 9, 8), NOW)).toBe("星期二");
    // 9/7 是星期一（5 天前）
    expect(formatSessionTime(at(2026, 9, 7), NOW)).toBe("星期一");
  });

  it("更早显示 M/D", () => {
    expect(formatSessionTime(at(2026, 8, 3), NOW)).toBe("8/3");
  });

  it("跨年显示 YYYY/M/D", () => {
    expect(formatSessionTime(at(2025, 12, 31), NOW)).toBe("2025/12/31");
  });
});
