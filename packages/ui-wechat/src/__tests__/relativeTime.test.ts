/**
 * @file relativeTime.test.ts
 * 相对时间文案的边界测试。
 */

import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../utils/relativeTime";

const NOW = new Date(2026, 8, 12, 20, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("1 分钟内显示「刚刚」", () => {
    expect(formatRelativeTime(NOW - 30 * 1000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 59 * 1000, NOW)).toBe("刚刚");
  });

  it("未来时间按「刚刚」处理（时钟漂移）", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe("刚刚");
  });

  it("1 小时内显示分钟", () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe("1 分钟前");
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe("59 分钟前");
  });

  it("24 小时内显示小时", () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1 小时前");
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe("23 小时前");
  });

  it("24~48 小时显示「昨天」", () => {
    expect(formatRelativeTime(NOW - 25 * HOUR, NOW)).toBe("昨天");
  });

  it("30 天内显示天数", () => {
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe("3 天前");
    expect(formatRelativeTime(NOW - 29 * DAY, NOW)).toBe("29 天前");
  });

  it("超过 30 天显示日期", () => {
    expect(formatRelativeTime(NOW - 40 * DAY, NOW)).toBe("2026-08-03");
  });
});
