/**
 * @file PromptBuilder.test.ts
 * system prompt 注入顺序与段落省略规则测试。
 */

import { describe, it, expect, vi } from "vitest";
import type {
  ICharacterProfile,
  ILoreEntry,
  IMemory,
  IPromptTemplate,
} from "@wechat-rp/shared-types";
import {
  buildPrompt,
  buildReplyStylePrompt,
  buildSystemPromptPreview,
} from "../llm/PromptBuilder";
import type { IPresenceDecision } from "../PresenceManager";

const NOW = 1_700_000_000_000;

const profile: ICharacterProfile = {
  id: "char-1",
  displayName: "苏晚晴",
  bio: "温柔邻家姐姐",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: false,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.5,
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "tpl-1",
};

const template: IPromptTemplate = {
  id: "tpl-1",
  name: "测试模板",
  worldSetting: "现代都市",
  worldPlot: "两人刚重逢",
};

const memory: IMemory = {
  id: "mem-1",
  characterId: "char-1",
  kind: "preference",
  content: "用户喜欢猫",
  keywords: ["猫"],
  importance: 4,
  pinned: false,
  createdAt: NOW,
  updatedAt: NOW,
  sourceMessageIds: [],
};

describe("buildReplyStylePrompt", () => {
  it("不传风格时用默认：简短 + 禁止旁白", () => {
    const text = buildReplyStylePrompt();
    expect(text).toContain("【回复风格】");
    expect(text).toContain("简短");
    expect(text).toContain("不要写动作");
  });

  it("四个长度档位给出不同要求", () => {
    expect(
      buildReplyStylePrompt({ length: "terse", allowActions: false }),
    ).toContain("极简");
    expect(
      buildReplyStylePrompt({ length: "medium", allowActions: false }),
    ).toContain("适中");
    expect(
      buildReplyStylePrompt({ length: "detailed", allowActions: false }),
    ).toContain("详细");
  });

  it("允许旁白时换成放行说法（而不是两句话并存）", () => {
    const text = buildReplyStylePrompt({
      length: "short",
      allowActions: true,
    });
    expect(text).toContain("可以少量穿插动作");
    expect(text).not.toContain("不要写动作");
  });
});

describe("buildSystemPromptPreview", () => {
  it("把稳定前缀拼全：角色卡 + 模板 + 关于你 + 风格 + 情绪标记 + 引用规则", () => {
    const preview = buildSystemPromptPreview(profile, template, {
      displayName: "小满",
      bio: "程序员，养猫",
    });

    expect(preview).toContain("你是苏晚晴");
    expect(preview).toContain("现代都市"); // 模板里的 worldSetting
    expect(preview).toContain("【关于对方】");
    expect(preview).toContain("小满");
    expect(preview).toContain("【回复风格】");
    expect(preview).toContain("【情绪标记】");
    expect(preview).toContain("【引用对方的话】");
  });

  it("没绑模板 / 没填关于你时那两段自然省略", () => {
    const preview = buildSystemPromptPreview(profile, null, null);

    expect(preview).toContain("你是苏晚晴");
    expect(preview).not.toContain("【关于对方】");
    expect(preview).toContain("【回复风格】");
  });

  it("预览必须与真实请求一致（是开头 system 的前缀）", () => {
    const userProfile = { displayName: "小满", bio: "程序员，养猫" };
    const preview = buildSystemPromptPreview(profile, template, userProfile);
    const real = buildPrompt(profile, [], "在吗", undefined, {
      promptTemplate: template,
      userProfile,
    }).messages[0]!.content;

    // 动态段（睡眠/忙碌/心情）接在后面，所以预览一定是真实内容的前缀
    expect(real.startsWith(preview)).toBe(true);
  });
});

describe("buildPrompt", () => {
  it("角色卡与模板在开头 system，记忆与剧情在末尾 system 紧贴当前提问", () => {
    const result = buildPrompt(
      profile,
      [{ role: "user", content: "历史消息" }],
      "你好",
      undefined,
      {
        promptTemplate: template,
        memories: [memory],
        plotSummary: "【当前剧情】\n章节：第一章",
      },
    );

    // 结构：[人设 system][历史…][动态 system][当前 user]
    expect(result.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "system",
      "user",
    ]);

    const head = result.messages[0]!.content;
    expect(head).toContain("你是苏晚晴");
    expect(head).toContain("现代都市");
    // 动态内容不能混进开头人设，否则前缀缓存每轮都会失效
    expect(head).not.toContain("【你记得的事】");
    expect(head).not.toContain("【当前剧情】");

    const tail = result.messages[2]!.content;
    expect(tail).toContain("【你记得的事】");
    expect(tail).toContain("【当前剧情】");
    // 记忆在前、剧情在后（剧情离提问更近）
    expect(tail.indexOf("【你记得的事】")).toBeLessThan(
      tail.indexOf("【当前剧情】"),
    );

    // 历史与当前消息位置不变
    expect(result.messages[1]!.content).toBe("历史消息");
    expect(result.messages[3]!.content).toBe("你好");
  });

  it("世界书命中时排在最前，顺序为 设定 → 记忆 → 剧情", () => {
    const lore: ReadonlyArray<ILoreEntry> = [
      {
        id: "lore-1",
        keys: ["唱片"],
        secondaryKeys: [],
        content: "店里收藏了三千张黑胶。",
        enabled: true,
        order: 0,
        caseSensitive: false,
        constant: false,
        selective: false,
      },
    ];
    const result = buildPrompt(
      profile,
      [{ role: "user", content: "历史消息" }],
      "你店里的唱片是哪来的",
      undefined,
      {
        memories: [memory],
        lore,
        plotSummary: "【当前剧情】\n章节：第一章",
      },
    );

    const tail = result.messages[result.messages.length - 2]!.content;
    expect(tail).toContain("【世界设定】");
    expect(tail).toContain("三千张黑胶");
    // 设定是背景铺垫，记忆次之，剧情离提问最近
    expect(tail.indexOf("【世界设定】")).toBeLessThan(
      tail.indexOf("【你记得的事】"),
    );
    expect(tail.indexOf("【你记得的事】")).toBeLessThan(
      tail.indexOf("【当前剧情】"),
    );
  });

  it("没有世界书命中时不产生【世界设定】段落", () => {
    const result = buildPrompt(profile, [], "你好", undefined, { lore: [] });
    const joined = result.messages.map((m) => m.content).join("\n");
    expect(joined).not.toContain("【世界设定】");
    // 也就不会多出末尾那条动态 system
    expect(result.messages).toHaveLength(2);
  });

  it("把角色自己的回复风格写进开头 system（人设的一部分）", () => {
    const styled: ICharacterProfile = {
      ...profile,
      replyStyle: { length: "terse", allowActions: true },
    };
    const result = buildPrompt(styled, [], "你好");
    const head = result.messages[0]!.content;

    expect(head).toContain("【回复风格】");
    expect(head).toContain("极简");
    expect(head).toContain("可以少量穿插动作");
  });

  it("开头 system 里带上「引用对方的话」的格式说明", () => {
    const result = buildPrompt(profile, [], "你好");
    const head = result.messages[0]!.content;

    expect(head).toContain("【引用对方的话】");
    // 格式要点：自定界的方括号 + 长度上限 + "最多一处"
    expect(head).toContain("【引用：");
    expect(head).toContain("20 字");
    expect(head).toContain("最多一处");
  });

  it("也教模型「怎么读」对方发来的引用块（别否认自己说过）", () => {
    const head = buildPrompt(profile, [], "你好").messages[0]!.content;

    expect(head).toContain("【对方引用的话】");
    // 引用块长什么样，得让它认得出来
    expect(head).toContain("（引用消息 · 名字：「原话」）");
    // 核心要求：那确实是自己说过的，别否认
    expect(head).toContain("不要否认自己说过");
    // 而且不能把球踢回给对方
    expect(head).toContain("别把话题推回给对方");
  });

  it("带上「说人话」的腔调约束（压列表化与客服腔，但仍然允许给建议）", () => {
    const head = buildPrompt(profile, [], "你好").messages[0]!.content;

    expect(head).toContain("【说人话】");
    // 三类典型 AI 腔
    expect(head).toContain("不要分点列举");
    expect(head).toContain("客服腔");
    expect(head).toContain("不要用书面语连接词");
    // 不是"不许给建议"——真人也会给，只是别写教程
    expect(head).toContain("别写教程");
  });

  it("填了「关于你」就注入关于对方的段落（跟着人设走，稳定前缀）", () => {
    const result = buildPrompt(profile, [], "你好", undefined, {
      userProfile: { displayName: "小满", bio: "25 岁，程序员，养了一只猫" },
    });
    const head = result.messages[0]!.content;

    expect(head).toContain("【关于对方】");
    expect(head).toContain("小满");
    expect(head).toContain("25 岁，程序员，养了一只猫");
    // 别让模型每条都喊名字
    expect(head).toContain("偶尔叫名字反而更亲近");
    // 属于人设那一段（开头 system），不是末尾的动态注入
    expect(result.messages[0]!.content).toContain("你是苏晚晴");
  });

  it("没填「关于你」时不产生这一段（默认值不占 Prompt）", () => {
    expect(
      buildPrompt(profile, [], "你好").messages[0]!.content,
    ).not.toContain("【关于对方】");
    // 只填背景、没填称呼：也该出现（用"你"称呼）
    const bioOnly = buildPrompt(profile, [], "你好", undefined, {
      userProfile: { displayName: "我", bio: "刚搬到这个城市" },
    });
    expect(bioOnly.messages[0]!.content).toContain("【关于对方】");
    expect(bioOnly.messages[0]!.content).toContain("刚搬到这个城市");
  });

  it("心情值得注入时写进开头 system（跟角色状态在一起）", () => {
    const result = buildPrompt(profile, [], "你好", undefined, {
      mood: { emotion: "angry", intensity: 4, sourceCount: 2 },
    });
    const head = result.messages[0]!.content;

    expect(head).toContain("【你此刻的心情】");
    expect(head).toContain("生气");
  });

  it("没有心情（平静）时不产生这一段", () => {
    const result = buildPrompt(profile, [], "你好");
    expect(result.messages[0]!.content).not.toContain("【你此刻的心情】");

    const calm = buildPrompt(profile, [], "你好", undefined, {
      mood: { emotion: "neutral", intensity: 5, sourceCount: 3 },
    });
    expect(calm.messages[0]!.content).not.toContain("【你此刻的心情】");
  });

  it("忙碌时注入「你现在在忙」，并要求短回复", () => {
    const busy: IPresenceDecision = {
      isSleeping: false,
      msUntilWake: 0,
      policy: "next-day-queue",
      displayText: "在上课",
      presence: "away",
      isBusy: true,
      busyLabel: "在上课",
    };
    const result = buildPrompt(profile, [], "在吗", busy);
    const head = result.messages[0]!.content;

    expect(head).toContain("【当前状态】");
    expect(head).toContain("在上课");
    expect(head).toContain("很短");
    // 忙碌不该被写成"睡着了"
    expect(head).not.toContain("半梦半醒");
  });

  it("不忙时不产生忙碌段（在线状态照旧）", () => {
    const online: IPresenceDecision = {
      isSleeping: false,
      msUntilWake: 0,
      policy: "next-day-queue",
      displayText: "在线",
      presence: "online",
      isBusy: false,
      busyLabel: null,
    };
    const result = buildPrompt(profile, [], "在吗", online);
    const head = result.messages[0]!.content;

    expect(head).not.toContain("【当前状态】你正在");
    expect(head).not.toContain("很短");
  });

  it("无记忆 / 无剧情时不产生末尾 system 消息", () => {
    const result = buildPrompt(profile, [], "你好");
    const system = result.messages[0]!.content;
    expect(system).not.toContain("【你记得的事】");
    expect(system).not.toContain("【当前剧情】");
    // 只有两条：人设 + 当前消息
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("返回上下文占用快照：分项字数、消息条数与 token 估算", () => {
    const result = buildPrompt(
      profile,
      [{ role: "user", content: "历史消息" }],
      "你好",
      undefined,
      {
        promptTemplate: template,
        memories: [memory],
        plotSummary: "【当前剧情】\n章节：第一章",
      },
    );
    const { usage } = result;

    expect(usage.chars.template).toBeGreaterThan(0);
    expect(usage.chars.memory).toBeGreaterThan(0);
    expect(usage.chars.plot).toBe("【当前剧情】\n章节：第一章".length);
    expect(usage.chars.history).toBe("历史消息".length);
    // 角色卡那一项不能把模板也算进去（否则模板被统计两次）
    expect(usage.chars.system).toBeGreaterThan(0);
    expect(usage.chars.system).toBeLessThan(result.messages[0]!.content.length);
    expect(usage.messageCount).toBe(result.messages.length);
    expect(usage.estimatedTokens).toBeGreaterThan(0);
    expect(usage.trimmed).toBe(false);
    expect(usage.removedChars).toBe(0);
  });

  it("没绑模板/没有记忆时，对应分项为 0（界面上不该显示空行）", () => {
    const result = buildPrompt(profile, [], "你好");
    expect(result.usage.chars.template).toBe(0);
    expect(result.usage.chars.memory).toBe(0);
    expect(result.usage.chars.plot).toBe(0);
    expect(result.usage.chars.history).toBe(0);
  });

  it("模板带示例对话时单独成段，并注明「不要照抄」", () => {
    const withExamples: IPromptTemplate = {
      ...template,
      speechExamples: "用户：在吗\n角色：在呢",
    };
    const result = buildPrompt(profile, [], "你好", undefined, {
      promptTemplate: withExamples,
    });
    const head = result.messages[0]!.content;

    expect(head).toContain("【说话示例】");
    expect(head).toContain("用户：在吗");
    expect(head).toContain("不要照抄");
    // 示例不该混进"字段: 值"的列表里
    expect(head).not.toContain("- 示例对话:");
  });

  it("没有示例对话时不产生空段落", () => {
    const result = buildPrompt(profile, [], "你好", undefined, {
      promptTemplate: template,
    });
    expect(result.messages[0]!.content).not.toContain("【说话示例】");
  });

  it("记忆段落包含类别标签，且最重要的排在最后（离提问最近）", () => {
    const low: IMemory = { ...memory, id: "mem-low", content: "次要的事", importance: 1 };
    const mid: IMemory = { ...memory, id: "mem-mid", content: "一般重要", importance: 3 };
    const high: IMemory = { ...memory, id: "mem-high", content: "最要命的事", importance: 5 };

    const result = buildPrompt(profile, [], "你好", undefined, {
      // 故意乱序传入，验证渲染时会自己排
      memories: [high, low, mid, memory],
    });
    const tail = result.messages[result.messages.length - 2]!.content;

    expect(tail).toContain("- [偏好] 用户喜欢猫");
    const lowIdx = tail.indexOf("次要的事");
    const midIdx = tail.indexOf("一般重要");
    const baseIdx = tail.indexOf("用户喜欢猫");
    const highIdx = tail.indexOf("最要命的事");
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(lowIdx);
    expect(baseIdx).toBeGreaterThan(midIdx);
    expect(highIdx).toBeGreaterThan(baseIdx);
  });

  it("长对话被裁剪时给出前情提要（模型该知道历史被截过，而不是一口咬定你没说）", () => {
    // 微信式短消息攒到 300 条：总量远超 softLimit，但保留窗口很小
    const history = Array.from({ length: 300 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `第 ${i} 条：今天食堂的糖醋排骨还不错，就是排队有点久`,
    }));

    const result = buildPrompt(profile, history, "你还记得吗？", undefined, {
      memories: [{ ...memory, content: "用户养了一只叫团团的猫" }],
    });

    const recap = result.messages.find(
      (m) => m.role === "system" && m.content.startsWith("【前情提要】"),
    );
    expect(recap).toBeDefined();
    // 明确写出"更早的 N 条已省略"，模型才不会以为用户从没说过
    expect(recap!.content).toContain("已省略");
    // 记忆照旧在尾部注入（它才是长对话里记得住的主力）
    expect(
      result.messages.some((m) => m.content.includes("【你记得的事】")),
    ).toBe(true);
  });

  it("每轮都带上【现在】：按角色时区写清年月日与钟点", () => {
    // 2026-09-13 12:41 UTC = 上海 20:41（周日）
    const noon = Date.UTC(2026, 8, 13, 12, 41);
    const result = buildPrompt(profile, [], "在吗", undefined, { now: noon });
    const head = result.messages[0]!.content;

    // profile 的时区是 Asia/Shanghai
    expect(head).toContain("【现在】2026年9月13日 星期日 20:41。");
    // 属于开头 system（角色此刻的外部事实），不是末尾动态注入
    expect(result.messages).toHaveLength(2);
  });

  it("隔得久才写【上一句】，并给出上一条的具体时间", () => {
    const noon = Date.UTC(2026, 8, 13, 12, 41);
    const day = 24 * 60 * 60 * 1000;

    const longGap = buildPrompt(profile, [], "在吗", undefined, {
      now: noon,
      lastMessageAt: noon - 3 * day,
    });
    expect(longGap.messages[0]!.content).toContain(
      "【上一句】你们上一次说话是 3 天前（9月10日 20:41）。",
    );

    // 五分钟前刚聊过：属于连续对话，不写这一段
    const shortGap = buildPrompt(profile, [], "在吗", undefined, {
      now: noon,
      lastMessageAt: noon - 5 * 60 * 1000,
    });
    expect(shortGap.messages[0]!.content).not.toContain("【上一句】");
  });

  it("不传 now 时取当前时间（调用方不用自己算）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 13, 12, 41)));
      const head = buildPrompt(profile, [], "在吗").messages[0]!.content;
      // 时区来自角色卡：UTC 12:41 在上海是 20:41
      expect(head).toContain("20:41");
    } finally {
      vi.useRealTimers();
    }
  });

  it("接着聊时带上【别重复】，且它排在动态段最后（贴着当前提问）", () => {
    const history: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "今天好累" },
      { role: "assistant", content: "是嘛，辛苦啦。" },
      { role: "assistant", content: "晚上早点休息，别熬夜。" },
      { role: "user", content: "嗯" },
      { role: "assistant", content: "那你早点休息呀。" },
    ];

    const result = buildPrompt(profile, history, "还在忙吗", undefined, {
      memories: [{ ...memory, content: "用户养了一只叫团团的猫" }],
      plotSummary: "【当前剧情】\n章节：第一章",
    });

    const dynamic = result.messages[result.messages.length - 2]!;
    expect(dynamic.role).toBe("system");
    expect(dynamic.content).toContain("【别重复】");
    expect(dynamic.content).toContain("- 那你早点休息呀");
    // 顺序：记忆 → 剧情 → 别重复（约束贴在最尾部）
    expect(dynamic.content.indexOf("【你记得的事】")).toBeLessThan(
      dynamic.content.indexOf("【当前剧情】"),
    );
    expect(dynamic.content.indexOf("【当前剧情】")).toBeLessThan(
      dynamic.content.indexOf("【别重复】"),
    );

    // 占用快照里单独一行，界面才知道这段花了多少
    expect(result.usage.chars.antiRepeat).toBeGreaterThan(0);
  });

  it("首轮（角色还没说过话）不产生【别重复】，也不多出末尾 system", () => {
    const result = buildPrompt(profile, [{ role: "user", content: "你好" }], "在吗");

    expect(result.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(result.messages[0]!.content).not.toContain("【别重复】");
    expect(result.usage.chars.antiRepeat).toBe(0);
  });
});
