/**
 * @file Clock.test.ts
 * 时区感知的"现在"：墙上时间、下一次钟点、"隔了多久"、Prompt 段落渲染。
 *
 * 断言全部基于**固定时刻 + 显式时区**，因此换一台机器（换本地时区）结果不变。
 */

import { describe, it, expect } from "vitest";
import {
  describeElapsed,
  minutesOfDayInZone,
  nextTimeOfDayInZone,
  renderTimeContext,
  wallClockInZone,
} from "../time/Clock";

/** 固定时刻：2026-09-13（周日）12:41 UTC。 */
const AT = Date.UTC(2026, 8, 13, 12, 41);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("wallClockInZone / minutesOfDayInZone", () => {
  it("同一个时刻在不同时区是不同的钟点", () => {
    // 12:41 UTC = 20:41 上海（UTC+8）= 21:41 东京（UTC+9）= 08:41 纽约（UTC-4，夏令时）
    expect(minutesOfDayInZone(AT, "UTC")).toBe(12 * 60 + 41);
    expect(minutesOfDayInZone(AT, "Asia/Shanghai")).toBe(20 * 60 + 41);
    expect(minutesOfDayInZone(AT, "Asia/Tokyo")).toBe(21 * 60 + 41);
    expect(minutesOfDayInZone(AT, "America/New_York")).toBe(8 * 60 + 41);
  });

  it("星期几与时区无关，按年月日算", () => {
    // 2026-09-13 是周日
    expect(wallClockInZone(AT, "Asia/Shanghai").weekday).toBe(0);
    expect(wallClockInZone(AT, "UTC").day).toBe(13);
    // 东京比 UTC 快 9 小时，但日期还没跨过去
    expect(wallClockInZone(AT, "Asia/Tokyo").day).toBe(13);
  });

  it("时区缺失或非法时退回宿主本地时间（绝不抛错）", () => {
    const local = new Date(AT);
    const expected = local.getHours() * 60 + local.getMinutes();

    expect(minutesOfDayInZone(AT)).toBe(expected);
    expect(minutesOfDayInZone(AT, null)).toBe(expected);
    expect(minutesOfDayInZone(AT, "   ")).toBe(expected);
    // 旧存档里可能存着写错的时区名
    expect(() => minutesOfDayInZone(AT, "Mars/Olympus")).not.toThrow();
    expect(minutesOfDayInZone(AT, "Mars/Olympus")).toBe(expected);
  });
});

describe("nextTimeOfDayInZone", () => {
  it("今天还没到就取今天，已经过了就取明天", () => {
    // UTC 12:41 → 今天 20:00 还没到
    const today = nextTimeOfDayInZone(20 * 60, AT, "UTC");
    expect(today).toBe(Date.UTC(2026, 8, 13, 20, 0));

    // UTC 12:41 → 今天 07:30 已经过了，取明天
    const tomorrow = nextTimeOfDayInZone(7 * 60 + 30, AT, "UTC");
    expect(tomorrow).toBe(Date.UTC(2026, 8, 14, 7, 30));
  });

  it("按角色时区算：同一时刻、同一钟点，两个时区差 8 小时", () => {
    // 上海此刻是 9/13 20:41 → 07:30 已过，取 9/14 07:30（= 9/13 23:30 UTC）
    expect(nextTimeOfDayInZone(7 * 60 + 30, AT, "Asia/Shanghai")).toBe(
      Date.UTC(2026, 8, 13, 23, 30),
    );
    // UTC 此刻是 9/13 12:41 → 07:30 已过，取 9/14 07:30（= 9/14 07:30 UTC）
    expect(nextTimeOfDayInZone(7 * 60 + 30, AT, "UTC")).toBe(
      Date.UTC(2026, 8, 14, 7, 30),
    );
  });

  it("跨午夜的睡眠窗口：23:30 入睡、07:30 醒来时，醒来时刻落在次日", () => {
    // 上海 9/14 02:00（= 9/13 18:00 UTC）时，下一次 07:30 是 9/14 07:30
    const at = Date.UTC(2026, 8, 13, 18, 0);
    expect(nextTimeOfDayInZone(7 * 60 + 30, at, "Asia/Shanghai")).toBe(
      Date.UTC(2026, 8, 13, 23, 30),
    );
  });
});

describe("describeElapsed", () => {
  it("按量级说成人话", () => {
    expect(describeElapsed(0)).toBe("刚刚");
    expect(describeElapsed(30_000)).toBe("刚刚");
    expect(describeElapsed(59_999)).toBe("刚刚");
    expect(describeElapsed(5 * MINUTE)).toBe("5 分钟前");
    expect(describeElapsed(3 * HOUR)).toBe("3 小时前");
    expect(describeElapsed(2 * DAY)).toBe("2 天前");
    expect(describeElapsed(40 * DAY)).toBe("1 个月前");
  });

  it("时钟往回跳（负数）也算刚刚", () => {
    expect(describeElapsed(-5000)).toBe("刚刚");
    expect(describeElapsed(Number.NaN)).toBe("刚刚");
  });
});

describe("renderTimeContext", () => {
  it("【现在】按角色时区渲染，并带上星期", () => {
    const text = renderTimeContext({ now: AT, timeZone: "Asia/Shanghai" });

    expect(text).toContain("【现在】2026年9月13日 星期日 20:41。");
    // 时区不同，钟点跟着变
    expect(renderTimeContext({ now: AT, timeZone: "Asia/Tokyo" })).toContain(
      "21:41",
    );
  });

  it("刚聊完不提【上一句】（一小时以内属于连续对话）", () => {
    const text = renderTimeContext({
      now: AT,
      timeZone: "Asia/Shanghai",
      lastMessageAt: AT - 5 * MINUTE,
    });

    expect(text).not.toContain("【上一句】");
  });

  it("隔了三天会说明隔了多久，并给出上一条的日期", () => {
    const text = renderTimeContext({
      now: AT,
      timeZone: "Asia/Shanghai",
      lastMessageAt: AT - 3 * DAY,
    });

    expect(text).toContain("【上一句】你们上一次说话是 3 天前（9月10日 20:41）。");
  });

  it("没有历史 / 时间戳不合法时不出现【上一句】", () => {
    expect(
      renderTimeContext({ now: AT, timeZone: "UTC", lastMessageAt: null }),
    ).not.toContain("【上一句】");
    expect(
      renderTimeContext({ now: AT, timeZone: "UTC", lastMessageAt: Number.NaN }),
    ).not.toContain("【上一句】");
    // 存档时间比"现在"还晚（时钟回调）不该算出负数天
    expect(
      renderTimeContext({
        now: AT,
        timeZone: "UTC",
        lastMessageAt: AT + DAY,
      }),
    ).not.toContain("【上一句】");
  });
});
