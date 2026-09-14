/**
 * @file ProactivePrompt.test.ts
 * 主动消息提示词：时段、间隔描述、上下文拼装与检索 query。
 */

import { describe, it, expect } from "vitest";
import {
  buildProactivePrompt,
  buildProactiveQuery,
  describeChatGap,
  describeTimeOfDay,
} from "../proactive/ProactivePrompt";

/** 造一个"当天某点"的时间戳（本地时区）。 */
function at(hour: number, minute = 0): number {
  return new Date(2026, 8, 12, hour, minute, 0, 0).getTime();
}

describe("describeTimeOfDay", () => {
  it("按小时切出六个时段", () => {
    expect(describeTimeOfDay(at(6))).toBe("早上");
    expect(describeTimeOfDay(at(10))).toBe("上午");
    expect(describeTimeOfDay(at(12))).toBe("中午");
    expect(describeTimeOfDay(at(15))).toBe("下午");
    expect(describeTimeOfDay(at(18))).toBe("傍晚");
    expect(describeTimeOfDay(at(21))).toBe("晚上");
  });

  it("深夜覆盖 23 点到次日 5 点", () => {
    expect(describeTimeOfDay(at(23))).toBe("深夜");
    expect(describeTimeOfDay(at(2))).toBe("深夜");
    expect(describeTimeOfDay(at(4, 59))).toBe("深夜");
    expect(describeTimeOfDay(at(5))).toBe("早上");
  });

  it("按角色时区切时段（同一时刻，两地早晚相反）", () => {
    // 2026-09-13 12:41 UTC：上海是晚上 20:41，纽约是早上 08:41
    const utcNoonish = Date.UTC(2026, 8, 13, 12, 41);

    expect(describeTimeOfDay(utcNoonish, "Asia/Shanghai")).toBe("晚上");
    expect(describeTimeOfDay(utcNoonish, "America/New_York")).toBe("早上");
    // 时区写坏时退回宿主本地时间，不抛错
    expect(() => describeTimeOfDay(utcNoonish, "Mars/Olympus")).not.toThrow();
  });
});

describe("describeChatGap", () => {
  it("没聊过 / 刚聊完 / 分钟 / 小时 / 天", () => {
    const now = at(20);
    expect(describeChatGap(0, now)).toBe("你们还没聊过");
    expect(describeChatGap(now - 60_000, now)).toBe("刚刚才聊过");
    expect(describeChatGap(now - 20 * 60_000, now)).toBe("距离上次聊天 20 分钟");
    expect(describeChatGap(now - 3 * 3600_000, now)).toBe("距离上次聊天 3 小时");
    // 25 小时 = 一天多一点，按"1 天"说；4 天以上直接报天数
    expect(describeChatGap(now - 25 * 3600_000, now)).toBe("距离上次聊天 1 天");
    expect(describeChatGap(now - 4 * 24 * 3600_000, now)).toBe(
      "距离上次聊天 4 天",
    );
  });

  it("时间戳在未来（时钟漂移）时不出现负数", () => {
    const now = at(20);
    expect(describeChatGap(now + 3600_000, now)).toBe("刚刚才聊过");
  });
});

describe("buildProactivePrompt", () => {
  const base = {
    characterName: "苏晚晴",
    now: at(21),
    lastMessageAt: at(21) - 3 * 3600_000,
    recentTexts: ["我周末想去看海", "那我陪你一起"],
  };

  it("带上了时段与间隔，并禁止空泛问候", () => {
    const prompt = buildProactivePrompt(base);
    expect(prompt).toContain("现在是晚上");
    expect(prompt).toContain("距离上次聊天 3 小时");
    expect(prompt).toContain("苏晚晴");
    expect(prompt).toContain('不要用"在吗"');
    // 明确要求不提系统提示
    expect(prompt).toContain("不要向对方提及");
  });

  it("给了「最近说过的话」就列成清单（只说一句不要重复没用）", () => {
    const prompt = buildProactivePrompt({
      ...base,
      recentSaid: ["你今天过得怎么样呀", "记得早点休息"],
    });

    expect(prompt).toContain("别再说一遍");
    expect(prompt).toContain("- 你今天过得怎么样呀");
    expect(prompt).toContain("- 记得早点休息");
    // 有了清单就不再保留那句空泛的旧措辞
    expect(prompt).not.toContain("不要重复你最近说过的话");
  });

  it("没有清单时退回旧措辞（不产生空的列表）", () => {
    const prompt = buildProactivePrompt({ ...base, recentSaid: [] });

    expect(prompt).not.toContain("别再说一遍");
    expect(prompt).toContain("不要重复你最近说过的话");
  });

  it("带上最近对话与未解线索，让主动消息能接上话题", () => {
    const prompt = buildProactivePrompt({
      ...base,
      openThreads: ["周末去看海", "还没定几点出发"],
      synopsis: "两人刚约好周末出门",
    });
    expect(prompt).toContain("我周末想去看海");
    expect(prompt).toContain("还没聊完的事：周末去看海、还没定几点出发");
    expect(prompt).toContain("当前剧情：两人刚约好周末出门");
  });

  it("没有线索和剧情时不产生空段落", () => {
    const prompt = buildProactivePrompt({ ...base, recentTexts: [] });
    expect(prompt).not.toContain("还没聊完的事");
    expect(prompt).not.toContain("当前剧情");
    expect(prompt).not.toContain("最近的对话");
  });

  it("过长的文本会被截断，避免提示词被撑爆", () => {
    const long = "啊".repeat(200);
    const prompt = buildProactivePrompt({ ...base, recentTexts: [long] });
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(600);
  });
});

describe("buildProactiveQuery", () => {
  it("拼接最近对话与未解线索（这才是该拿去检索的内容）", () => {
    const query = buildProactiveQuery({
      recentTexts: ["我周末想去看海"],
      openThreads: ["还没定几点出发"],
      synopsis: "刚约好周末出门",
    });
    expect(query).toContain("我周末想去看海");
    expect(query).toContain("还没定几点出发");
    expect(query).toContain("刚约好周末出门");
  });

  it("全空时返回空字符串（调用方据此跳过检索扩展）", () => {
    expect(buildProactiveQuery({ recentTexts: [] })).toBe("");
  });
});
