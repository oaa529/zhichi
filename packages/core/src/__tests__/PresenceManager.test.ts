/**
 * @file PresenceManager.test.ts
 * PresenceManager 单元测试：跨午夜睡眠窗口、回复策略、emotion 解析。
 */

import { describe, it, expect } from "vitest";
import { PresenceManager } from "../PresenceManager";
import type { ICharacterProfile, ISimulationConfig } from "@wechat-rp/shared-types";

/**
 * 宿主机器的时区。
 *
 * 默认档案用它，测试才是"跟机器无关"的：`ts()` 造的是本地时刻，
 * 而角色卡里写别的时区就会按别的钟点判定（见文末的跨时区用例）。
 */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function createProfile(
  sleepTime: string,
  wakeTime: string,
  scheduleEnabled: boolean = true,
  sleepReplyPolicy: "next-day-queue" | "drowsy-burst" | "silent" = "next-day-queue",
  timezone: string = HOST_ZONE,
): ICharacterProfile {
  return {
    id: "char-1",
    displayName: "测试角色",
    bio: "测试",
    visualMetadata: {
      avatarUrl: "",
      sprites: [],
      supportsPinSprite: false,
      defaultSpriteAnchor: "left",
    },
    schedule: {
      wakeTime,
      sleepTime,
      scheduleEnabled,
      timezone,
      sleepReplyPolicy,
    },
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 1.0,
      fragmentationBias: 0.3,
      hesitationProbability: 0,
      typoRate: 0,
      stickerFrequency: 0,
    },
    promptTemplateId: "test",
  };
}

const baseConfig: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "normal",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: true,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 6000,
};

/** 构造指定时刻的时间戳（本地时区）。 */
function ts(hour: number, minute: number = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

describe("PresenceManager", () => {
  it("scheduleEnabled=false 时不判定睡眠", () => {
    const profile = createProfile("23:00", "07:00", false);
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.isSleeping).toBe(false);
    expect(decision.presence).toBe("online");
    expect(decision.displayText).toBe("在线");
  });

  it("scheduleAwarenessEnabled=false 时不判定睡眠", () => {
    const profile = createProfile("23:00", "07:00", true);
    const config = { ...baseConfig, scheduleAwarenessEnabled: false };
    const pm = new PresenceManager(profile, config);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.isSleeping).toBe(false);
  });

  it("白天时段判定为在线", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(14, 0));

    expect(decision.isSleeping).toBe(false);
    expect(decision.presence).toBe("online");
    expect(decision.displayText).toBe("在线");
  });

  it("跨午夜：凌晨 2 点在睡眠窗口内", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.isSleeping).toBe(true);
    expect(decision.presence).toBe("sleeping");
    expect(decision.displayText).toBe("已就寝");
  });

  it("跨午夜：午夜前（23:30）在睡眠窗口内", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(23, 30));

    expect(decision.isSleeping).toBe(true);
  });

  it("跨午夜：醒来时刻（07:00）不在睡眠窗口内", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(7, 0));

    expect(decision.isSleeping).toBe(false);
  });

  it("不跨午夜：13:00-14:00 睡眠窗口", () => {
    const profile = createProfile("13:00", "14:00");
    const pm = new PresenceManager(profile, baseConfig);

    expect(pm.evaluate(ts(13, 30)).isSleeping).toBe(true);
    expect(pm.evaluate(ts(12, 59)).isSleeping).toBe(false);
    expect(pm.evaluate(ts(14, 0)).isSleeping).toBe(false);
  });

  it("msUntilWake 为正数且合理", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.isSleeping).toBe(true);
    expect(decision.msUntilWake).toBeGreaterThan(0);
    // 2:00 → 7:00 = 5 小时 = 18000000 ms
    expect(decision.msUntilWake).toBeLessThanOrEqual(5 * 60 * 60 * 1000);
  });

  it("silent 策略正确返回", () => {
    const profile = createProfile("23:00", "07:00", true, "silent");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.policy).toBe("silent");
  });

  it("drowsy-burst 策略正确返回", () => {
    const profile = createProfile("23:00", "07:00", true, "drowsy-burst");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.policy).toBe("drowsy-burst");
  });

  it("next-day-queue 策略正确返回", () => {
    const profile = createProfile("23:00", "07:00", true, "next-day-queue");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(2, 0));

    expect(decision.policy).toBe("next-day-queue");
  });

  // ---------- 忙碌时段 ----------

  /** 给档案加忙碌时段（其余字段沿用 createProfile）。 */
  function withBusy(
    periods: ReadonlyArray<{ start: string; end: string; label: string }>,
    sleepTime: string = "23:00",
    wakeTime: string = "07:00",
  ): ICharacterProfile {
    const profile = createProfile(sleepTime, wakeTime);
    return {
      ...profile,
      schedule: { ...profile.schedule, busyPeriods: periods },
    };
  }

  it("忙碌时段内：状态是 away，展示的是角色自己在干什么", () => {
    const pm = new PresenceManager(
      withBusy([{ start: "09:00", end: "12:00", label: "在上课" }]),
      baseConfig,
    );

    const decision = pm.evaluate(ts(10, 0));

    expect(decision.isSleeping).toBe(false);
    expect(decision.isBusy).toBe(true);
    expect(decision.presence).toBe("away");
    expect(decision.displayText).toBe("在上课");
    expect(decision.busyLabel).toBe("在上课");
  });

  it("忙碌时段的边界：开始算、结束不算", () => {
    const pm = new PresenceManager(
      withBusy([{ start: "09:00", end: "12:00", label: "在上课" }]),
      baseConfig,
    );

    expect(pm.evaluate(ts(9, 0)).isBusy).toBe(true);
    expect(pm.evaluate(ts(11, 59)).isBusy).toBe(true);
    expect(pm.evaluate(ts(12, 0)).isBusy).toBe(false);
    expect(pm.evaluate(ts(8, 59)).isBusy).toBe(false);
  });

  it("跨午夜的忙碌时段（晚班 22:00–02:00）", () => {
    // 睡眠窗口挪到 03:00–11:00，免得"睡着了"把忙碌判定挡住
    const pm = new PresenceManager(
      withBusy([{ start: "22:00", end: "02:00", label: "在上夜班" }], "03:00", "11:00"),
      baseConfig,
    );

    expect(pm.evaluate(ts(23, 30)).isBusy).toBe(true);
    expect(pm.evaluate(ts(1, 0)).isBusy).toBe(true);
    expect(pm.evaluate(ts(3, 0)).isBusy).toBe(false);
    // 凌晨 4 点已经睡了，忙碌不再成立（睡眠优先）
    expect(pm.evaluate(ts(4, 0)).isBusy).toBe(false);
  });

  it("睡眠优先于忙碌：同一时刻两者重叠时按睡着算", () => {
    // 睡眠 23:00–07:00，忙碌 22:00–02:00（重叠）
    const pm = new PresenceManager(
      withBusy([{ start: "22:00", end: "02:00", label: "在上夜班" }]),
      baseConfig,
    );

    const decision = pm.evaluate(ts(0, 30));

    expect(decision.isSleeping).toBe(true);
    expect(decision.isBusy).toBe(false);
    expect(decision.presence).toBe("sleeping");
  });

  it("没配忙碌时段（老存档）时一切照旧", () => {
    const pm = new PresenceManager(createProfile("23:00", "07:00"), baseConfig);

    const decision = pm.evaluate(ts(10, 0));

    expect(decision.isBusy).toBe(false);
    expect(decision.busyLabel).toBeNull();
    expect(decision.presence).toBe("online");
  });

  it("作息感知总开关关闭时不判定忙碌", () => {
    const pm = new PresenceManager(
      withBusy([{ start: "09:00", end: "12:00", label: "在上课" }]),
      { ...baseConfig, scheduleAwarenessEnabled: false },
    );

    expect(pm.evaluate(ts(10, 0)).isBusy).toBe(false);
  });

  it("时段写坏了（非法时间）不影响其他时段，也不抛错", () => {
    const pm = new PresenceManager(
      withBusy([
        { start: "坏掉的时间", end: "12:00", label: "坏时段" },
        { start: "14:00", end: "18:00", label: "在上班" },
      ]),
      baseConfig,
    );

    expect(pm.evaluate(ts(10, 0)).isBusy).toBe(false);
    expect(pm.evaluate(ts(15, 0)).busyLabel).toBe("在上班");
  });

  it("resolveEmotion: 睡眠时强制 sleepy", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const emotion = pm.resolveEmotion("happy", ts(2, 0));

    expect(emotion).toBe("sleepy");
  });

  it("resolveEmotion: 非睡眠时保留传入值", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const emotion = pm.resolveEmotion("happy", ts(14, 0));

    expect(emotion).toBe("happy");
  });

  it("边界：入睡时刻（23:00）在睡眠窗口内", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(23, 0));

    expect(decision.isSleeping).toBe(true);
  });

  it("边界：醒来前一刻（06:59）在睡眠窗口内", () => {
    const profile = createProfile("23:00", "07:00");
    const pm = new PresenceManager(profile, baseConfig);

    const decision = pm.evaluate(ts(6, 59));

    expect(decision.isSleeping).toBe(true);
  });
});

/**
 * 角色卡里的 `timezone` 此前写进去从没被读过：作息一律按**宿主机器**的钟点判定。
 * 这些用例把"同一时刻、不同时区"摆在一起，跨时区角色才不会按错钟点睡觉。
 * 用的是显式时区与固定 UTC 时刻，因此换机器结果不变。
 */
describe("PresenceManager · 角色时区", () => {
  /** 固定时刻：2026-09-13 17:00 UTC = 上海 9/14 01:00 = 纽约 13:00。 */
  const AT = Date.UTC(2026, 8, 13, 17, 0);

  it("睡眠判定按角色时区：同一时刻，上海在睡、UTC 醒着", () => {
    const shanghai = new PresenceManager(
      createProfile("23:00", "07:00", true, "next-day-queue", "Asia/Shanghai"),
      baseConfig,
    );
    const utc = new PresenceManager(
      createProfile("23:00", "07:00", true, "next-day-queue", "UTC"),
      baseConfig,
    );

    expect(shanghai.evaluate(AT).isSleeping).toBe(true);
    expect(utc.evaluate(AT).isSleeping).toBe(false);
  });

  it("忙碌时段也按角色时区：纽约的 13:00 正在上班", () => {
    const profile = createProfile("23:00", "07:00", true, "next-day-queue", "America/New_York");
    const withBusy: ICharacterProfile = {
      ...profile,
      schedule: {
        ...profile.schedule,
        busyPeriods: [{ start: "09:00", end: "18:00", label: "在上班" }],
      },
    };

    const decision = new PresenceManager(withBusy, baseConfig).evaluate(AT);

    expect(decision.isBusy).toBe(true);
    expect(decision.busyLabel).toBe("在上班");
    // 同一时刻按上海钟点（凌晨 1 点）就不该是"在上班"
    const shanghai = { ...withBusy, schedule: { ...withBusy.schedule, timezone: "Asia/Shanghai" } };
    expect(new PresenceManager(shanghai, baseConfig).evaluate(AT).isBusy).toBe(false);
  });

  it("msUntilWake 按角色时区算：UTC 凌晨 2 点睡，距 07:30 还有 5.5 小时", () => {
    // 2026-09-13 02:00 UTC = 上海 10:00
    const at = Date.UTC(2026, 8, 13, 2, 0);
    const utc = new PresenceManager(
      createProfile("23:00", "07:30", true, "next-day-queue", "UTC"),
      baseConfig,
    );

    const decision = utc.evaluate(at);

    expect(decision.isSleeping).toBe(true);
    // 02:00 → 07:30 = 5.5 小时
    expect(decision.msUntilWake).toBe(5.5 * 60 * 60 * 1000);
    // 同一时刻按上海钟点（上午 10 点）压根不该在睡
    const shanghai = new PresenceManager(
      createProfile("23:00", "07:30", true, "next-day-queue", "Asia/Shanghai"),
      baseConfig,
    );
    expect(shanghai.evaluate(at).isSleeping).toBe(false);
  });

  it("时区写坏时退回宿主本地时间，不抛错", () => {
    const profile = createProfile("23:00", "07:00", true, "next-day-queue", "Mars/Olympus");
    const pm = new PresenceManager(profile, baseConfig);

    expect(() => pm.evaluate(ts(2, 0))).not.toThrow();
    expect(pm.evaluate(ts(2, 0)).isSleeping).toBe(true);
  });
});
