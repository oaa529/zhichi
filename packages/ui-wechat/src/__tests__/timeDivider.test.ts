/**
 * @file timeDivider.test.ts
 * 时间分隔线格式化与判定测试。
 */

import { describe, it, expect } from "vitest";
import {
  TIME_DIVIDER_GAP_MS,
  formatDividerTime,
  shouldShowTimeDivider,
} from "../utils/timeDivider";

/** 构造本地时区时间戳。 */
function at(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

describe("formatDividerTime", () => {
  const now = at(2026, 9, 12, 20, 30);

  it("今天显示 HH:mm", () => {
    expect(formatDividerTime(at(2026, 9, 12, 9, 5), now)).toBe("09:05");
  });

  it("昨天显示「昨天 HH:mm」", () => {
    expect(formatDividerTime(at(2026, 9, 11, 23, 40), now)).toBe("昨天 23:40");
  });

  it("今年内更早显示「M月D日 HH:mm」", () => {
    expect(formatDividerTime(at(2026, 3, 2, 8, 0), now)).toBe("3月2日 08:00");
  });

  it("跨年显示完整日期", () => {
    expect(formatDividerTime(at(2025, 12, 31, 22, 15), now)).toBe(
      "2025年12月31日 22:15",
    );
  });
});

describe("shouldShowTimeDivider", () => {
  it("首条消息前显示", () => {
    expect(shouldShowTimeDivider(null, at(2026, 9, 12, 10, 0))).toBe(true);
  });

  it("间隔小于阈值不显示", () => {
    const base = at(2026, 9, 12, 10, 0);
    expect(shouldShowTimeDivider(base, base + TIME_DIVIDER_GAP_MS - 1)).toBe(
      false,
    );
  });

  it("间隔达到阈值显示", () => {
    const base = at(2026, 9, 12, 10, 0);
    expect(shouldShowTimeDivider(base, base + TIME_DIVIDER_GAP_MS)).toBe(true);
  });

  it("跨天（即使只隔几分钟）会因超过阈值而显示", () => {
    expect(
      shouldShowTimeDivider(at(2026, 9, 11, 23, 58), at(2026, 9, 12, 0, 3)),
    ).toBe(true);
  });
});
