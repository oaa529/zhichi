/**
 * @file MemoryDigest.test.ts
 * 后台整理：Prompt 构造、JSON 容错解析、执行与记忆合并测试。
 */

import { describe, it, expect } from "vitest";
import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";
import type { ILLMAdapter, IConnectionTestResult } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import { LLMError } from "../llm/types";
import {
  buildDigestPrompt,
  mergeMemories,
  parseDigest,
  runDigest,
} from "../memory/MemoryDigest";
import type { IMemory, IPlotState } from "@wechat-rp/shared-types";

const NOW = 1_700_000_000_000;

/** 可控输出的假适配器。 */
class FakeAdapter implements ILLMAdapter {
  public lastRequest: ILLMRequest | null = null;

  constructor(
    private readonly output: string,
    private readonly mode: "complete" | "error" = "complete",
  ) {}

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.lastRequest = req;
    if (this.mode === "error") {
      handlers.onError(new LLMError("boom", "server-error", 500, false));
    } else {
      handlers.onComplete(this.output);
    }
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

const validJson = JSON.stringify({
  memories: [
    {
      kind: "preference",
      content: "用户喜欢猫",
      keywords: ["猫", "喜欢"],
      importance: 4,
    },
  ],
  events: [{ summary: "两人约好周末去看猫展", importance: 4 }],
  plot: {
    chapter: "第一章",
    scene: "咖啡馆",
    timeLabel: "周六下午",
    location: "街角咖啡馆",
    synopsis: "两人第一次见面",
    openThreads: ["周末的猫展"],
    relations: [{ characterId: "", label: "初次见面的朋友" }],
  },
});

describe("buildDigestPrompt", () => {
  it("包含角色 ID、角色名与对话记录", () => {
    const prompt = buildDigestPrompt(
      [
        { role: "user", content: "我最喜欢猫了" },
        { role: "assistant", content: "我也是！" },
      ],
      "苏晚晴",
      "char-1",
      "我",
    );
    expect(prompt.system).toContain("只输出一个 JSON 对象");
    expect(prompt.user).toContain("角色 ID：char-1");
    expect(prompt.user).toContain("苏晚晴：我也是！");
    expect(prompt.user).toContain("我：我最喜欢猫了");
  });

  it("传入已知记忆时，提示模型避免重复提炼", () => {
    const prompt = buildDigestPrompt(
      [{ role: "user", content: "我又养了一只狗" }],
      "苏晚晴",
      "char-1",
      "用户",
      ["用户名叫小明", "用户喜欢猫"],
    );
    expect(prompt.user).toContain("【已知的长期记忆】");
    expect(prompt.user).toContain("- 用户名叫小明");
    expect(prompt.user).toContain("不要重复输出");
  });

  it("传入当前状态卡时随请求下发，并要求「整卡维护」", () => {
    const card: IPlotState = {
      sessionId: "s1",
      chapter: "第二章",
      scene: "和好之后的周末",
      timeLabel: "周六下午",
      location: "市美术馆",
      relations: [{ characterId: "char-1", label: "关系缓和" }],
      openThreads: ["周六的展还没定下来", "说好要送的摄影集还没送出去"],
      synopsis: "两人和好，约了周六看展。",
      events: [],
      history: [],
      updatedAt: NOW,
    };

    const prompt = buildDigestPrompt(
      [{ role: "user", content: "展看完了，挺好看的" }],
      "苏晚晴",
      "char-1",
      "用户",
      [],
      card,
    );

    expect(prompt.user).toContain("【当前状态卡】");
    expect(prompt.user).toContain("周六的展还没定下来");
    expect(prompt.user).toContain("说好要送的摄影集还没送出去");
    // 没有状态卡时不出现这一段（免得给模型一块空白让它去"清空"）
    const without = buildDigestPrompt(
      [{ role: "user", content: "在吗" }],
      "苏晚晴",
      "char-1",
    );
    expect(without.user).not.toContain("【当前状态卡】");
  });

  it("整理指令说明状态卡是整卡维护：了结的删掉、没了的保留", () => {
    const prompt = buildDigestPrompt([{ role: "user", content: "在吗" }], "苏晚晴", "char-1");

    expect(prompt.system).toContain("整张状态卡的最新版本");
    expect(prompt.system).toContain("已经了结的未解线索要删掉");
    expect(prompt.system).toContain("仍未了结的必须原样保留");
  });

  it("整理指令要求模型在冲突时回填 supersedes", () => {
    const prompt = buildDigestPrompt(
      [{ role: "user", content: "我最近戒咖啡了，改喝茶" }],
      "苏晚晴",
      "char-1",
      "用户",
      ["用户喜欢喝咖啡"],
    );
    expect(prompt.system).toContain("supersedes");
    expect(prompt.system).toContain("推翻或取代");
    expect(prompt.user).toContain("- 用户喜欢喝咖啡");
  });
});

describe("parseDigest", () => {
  it("解析 supersedes 字段（冲突时模型回填被取代的旧记忆原文）", () => {
    const raw = JSON.stringify({
      memories: [
        {
          kind: "preference",
          content: "用户戒了咖啡改喝茶",
          keywords: ["咖啡", "茶"],
          importance: 4,
          supersedes: "用户喜欢喝咖啡",
        },
      ],
    });

    const digest = parseDigest(raw, "char-1");
    expect(digest?.memories[0]?.supersedes).toBe("用户喜欢喝咖啡");
  });

  it("supersedes 不是字符串时忽略该字段（不因脏数据失败）", () => {
    const raw = JSON.stringify({
      memories: [
        {
          kind: "fact",
          content: "用户住在上海",
          keywords: [],
          importance: 3,
          supersedes: { 嵌套: true },
        },
      ],
    });

    const digest = parseDigest(raw, "char-1");
    expect(digest).not.toBeNull();
    expect(digest?.memories[0]?.supersedes).toBeUndefined();
  });

  it("解析标准 JSON", () => {
    const digest = parseDigest(validJson, "char-1");
    expect(digest).not.toBeNull();
    expect(digest!.memories[0]!.content).toBe("用户喜欢猫");
    expect(digest!.events[0]!.summary).toContain("猫展");
    expect(digest!.plot.chapter).toBe("第一章");
    // relations 缺少 characterId 时回填
    expect(digest!.plot.relations![0]!.characterId).toBe("char-1");
  });

  it("容忍尾随逗号（真机遇到的写法，丢掉整段记忆不值得）", () => {
    const raw = [
      "{",
      '  "memories": [',
      '    {"kind":"fact","content":"用户下周要去杭州出差","keywords":["杭州"],"importance":3,},',
      "  ],",
      '  "events": [{"summary":"两人约好周六看展","importance":2},],',
      '  "plot": {"scene":"周末计划","openThreads":["看展","搬家"],},',
      "}",
    ].join("\n");

    const digest = parseDigest(raw, "char-1");

    expect(digest).not.toBeNull();
    expect(digest!.memories[0]!.content).toBe("用户下周要去杭州出差");
    expect(digest!.events[0]!.summary).toBe("两人约好周六看展");
    expect(digest!.plot.scene).toBe("周末计划");
    expect(digest!.plot.openThreads).toEqual(["看展", "搬家"]);
  });

  it("显式空数组的 openThreads / relations 要保留（那是在说「线索都了结了」）", () => {
    // 真机实录：展看完了，模型回 "openThreads": []
    const raw = JSON.stringify({
      memories: [],
      events: [],
      plot: { scene: "摄影展参观结束", openThreads: [], relations: [] },
    });

    const digest = parseDigest(raw, "char-1");

    expect(digest).not.toBeNull();
    // 改前这里是 undefined（空数组被丢弃）→ 合并时按"没提供"处理 → 旧线索永远挂着
    expect(digest!.plot.openThreads).toEqual([]);
    expect(digest!.plot.relations).toEqual([]);
  });

  it("字符串正文里的逗号一个都不动", () => {
    const raw = JSON.stringify({
      memories: [
        {
          kind: "event",
          content: "他说，好，然后就没再提这件事",
          keywords: ["约定"],
          importance: 2,
        },
      ],
    });

    const digest = parseDigest(raw, "char-1");
    expect(digest?.memories[0]?.content).toBe("他说，好，然后就没再提这件事");
  });

  it("尾巴被截断时保住已写完的记忆与事件（只丢半截 plot）", () => {
    // 真机实录：memories / events 都写完了，到 plot 那里断掉就收了围栏
    const raw = [
      "```json",
      '{"memories":[{"kind":"event","content":"两人约好周六看展","keywords":["展"],"importance":3},',
      '{"kind":"preference","content":"用户不喝咖啡","keywords":["咖啡"],"importance":2}],',
      '"events":[{"summary":"苏晚晴爽约引发争执后和解","importance":3}],',
      '"plot":{"scene":"周末","openThreads":["搬家"],',
      "```",
    ].join("\n");

    const digest = parseDigest(raw, "char-1");

    expect(digest).not.toBeNull();
    expect(digest!.memories).toHaveLength(2);
    expect(digest!.memories[0]!.content).toBe("两人约好周六看展");
    expect(digest!.events[0]!.summary).toBe("苏晚晴爽约引发争执后和解");
    // 半截的 plot 被丢掉，但整体结果可用
    expect(digest!.plot.scene).toBeUndefined();
  });

  it("结构错乱（括号对不上）时不硬猜，老老实实返回 null", () => {
    const raw = '{"memories":[{"kind":"fact","content":"用户住在北京"}}';

    expect(parseDigest(raw, "char-1")).toBeNull();
  });

  it("剥离 markdown 代码块围栏", () => {
    const digest = parseDigest("```json\n" + validJson + "\n```", "char-1");
    expect(digest).not.toBeNull();
  });

  it("前后夹杂说明文字也能解析", () => {
    const digest = parseDigest(
      `好的，以下是整理结果：\n${validJson}\n希望有帮助！`,
      "char-1",
    );
    expect(digest).not.toBeNull();
  });

  it("坏 JSON 返回 null", () => {
    expect(parseDigest("完全不是 JSON", "char-1")).toBeNull();
    expect(parseDigest("{坏的 JSON", "char-1")).toBeNull();
  });

  it("空结果返回 null", () => {
    expect(parseDigest(JSON.stringify({ memories: [], events: [], plot: {} }))).toBeNull();
  });

  it("非法 kind 回退为 other，importance 收敛到 1~5", () => {
    const digest = parseDigest(
      JSON.stringify({
        memories: [
          { kind: "unknown-kind", content: "测试", keywords: [], importance: 99 },
        ],
        events: [],
        plot: {},
      }),
      "char-1",
    );
    expect(digest!.memories[0]!.kind).toBe("other");
    expect(digest!.memories[0]!.importance).toBe(5);
  });
});

describe("runDigest", () => {
  it("成功时返回整理结果并携带整理指令", async () => {
    const adapter = new FakeAdapter(validJson);
    const digest = await runDigest({
      adapter,
      history: [{ role: "user", content: "我喜欢猫" }],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
    });
    expect(digest).not.toBeNull();
    expect(adapter.lastRequest!.messages[0]!.role).toBe("system");
    expect(adapter.lastRequest!.temperature).toBe(0.2);
  });

  it("失败时回调具体原因：空输出 / 不可解析 / 适配器报错", async () => {
    const history = [{ role: "user" as const, content: "聊两句" }];

    const emptyReasons: string[] = [];
    await runDigest({
      adapter: new FakeAdapter(""),
      history,
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
      onFailure: (reason) => emptyReasons.push(reason),
    });
    expect(emptyReasons).toEqual(["empty-output"]);

    const badReasons: string[] = [];
    await runDigest({
      adapter: new FakeAdapter("这不是 JSON"),
      history,
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
      onFailure: (reason) => badReasons.push(reason),
    });
    expect(badReasons).toEqual(["unparsable"]);

    const errorReasons: string[] = [];
    await runDigest({
      adapter: new FakeAdapter("", "error"),
      history,
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
      onFailure: (reason) => errorReasons.push(reason),
    });
    expect(errorReasons).toEqual(["adapter-error"]);
  });

  it("窗口内没有文本消息时回调 no-history；成功时不回调", async () => {
    const reasons: string[] = [];
    await runDigest({
      adapter: new FakeAdapter("{}"),
      history: [],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
      onFailure: (reason) => reasons.push(reason),
    });
    expect(reasons).toEqual(["no-history"]);

    const okReasons: string[] = [];
    const digest = await runDigest({
      adapter: new FakeAdapter(
        JSON.stringify({ memories: [{ kind: "fact", content: "用户养了猫", keywords: [], importance: 3 }] }),
      ),
      history: [{ role: "user" as const, content: "我养了只猫" }],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
      onFailure: (reason) => okReasons.push(reason),
    });
    expect(digest).not.toBeNull();
    expect(okReasons).toEqual([]);
  });

  it("适配器报错时返回 null", async () => {
    const adapter = new FakeAdapter("", "error");
    const digest = await runDigest({
      adapter,
      history: [{ role: "user", content: "测试" }],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
    });
    expect(digest).toBeNull();
  });

  it("输出无法解析时返回 null", async () => {
    const adapter = new FakeAdapter("抱歉，我做不到");
    const digest = await runDigest({
      adapter,
      history: [{ role: "user", content: "测试" }],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
    });
    expect(digest).toBeNull();
  });

  it("空历史直接返回 null", async () => {
    const adapter = new FakeAdapter(validJson);
    const digest = await runDigest({
      adapter,
      history: [],
      characterName: "苏晚晴",
      characterId: "char-1",
      model: "test-model",
    });
    expect(digest).toBeNull();
  });
});

describe("mergeMemories", () => {
  const existing: IMemory = {
    id: "mem-existing",
    characterId: "char-1",
    kind: "preference",
    content: "用户喜欢猫咪",
    keywords: ["猫"],
    importance: 3,
    pinned: false,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    sourceMessageIds: ["old-msg"],
  };

  it("相似记忆合并：重要度取高、关键词合并、更新时间刷新", () => {
    const merged = mergeMemories({
      characterId: "char-1",
      existing: [existing],
      drafts: [
        {
          kind: "preference",
          content: "用户喜欢猫咪和狗",
          keywords: ["狗"],
          importance: 5,
        },
      ],
      sourceMessageIds: ["new-msg"],
      now: NOW,
      idFactory: () => "mem-new",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("mem-existing");
    expect(merged[0]!.importance).toBe(5);
    expect(merged[0]!.keywords).toEqual(["猫", "狗"]);
    expect(merged[0]!.updatedAt).toBe(NOW);
    expect(merged[0]!.sourceMessageIds).toEqual(["old-msg", "new-msg"]);
  });

  it("supersedes：新记忆上会留下「替掉了什么」的记录", () => {
    const coffee: IMemory = {
      ...existing,
      id: "mem-coffee",
      content: "用户喜欢喝咖啡",
      keywords: ["咖啡"],
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [coffee],
      drafts: [
        {
          kind: "preference",
          content: "用户戒了咖啡改喝茶",
          keywords: ["咖啡", "茶"],
          importance: 4,
          supersedes: "用户喜欢喝咖啡",
        },
      ],
      now: NOW,
      idFactory: () => "mem-tea",
    });

    expect(merged[0]!.supersedesContent).toBe("用户喜欢喝咖啡");
    expect(merged[0]!.supersededAt).toBe(NOW);
  });

  it("没发生取代时不写这两个字段（界面不显示空记录）", () => {
    const merged = mergeMemories({
      characterId: "char-1",
      existing: [],
      drafts: [
        {
          kind: "fact",
          content: "用户养了一只猫",
          keywords: ["猫"],
          importance: 3,
        },
      ],
      now: NOW,
      idFactory: () => "mem-cat",
    });

    expect(merged[0]!.supersedesContent).toBeUndefined();
    expect(merged[0]!.supersededAt).toBeUndefined();
  });

  it("supersedes：被推翻的旧记忆被移除，只留下更新后的那条", () => {
    const coffee: IMemory = {
      ...existing,
      id: "mem-coffee",
      content: "用户喜欢喝咖啡",
      keywords: ["咖啡"],
    };
    const city: IMemory = {
      ...existing,
      id: "mem-city",
      content: "用户住在北京",
      keywords: ["北京"],
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [coffee, city],
      drafts: [
        {
          kind: "preference",
          content: "用户最近戒了咖啡，改喝茶",
          keywords: ["咖啡", "茶"],
          importance: 4,
          supersedes: "用户喜欢喝咖啡",
        },
      ],
      now: NOW,
      idFactory: () => "mem-tea",
    });

    // 旧的那条被摘掉、新的补进来，无关的"住在北京"不受影响
    expect(merged.map((m) => m.id)).toEqual(["mem-city", "mem-tea"]);
    expect(merged.some((m) => m.content === "用户喜欢喝咖啡")).toBe(false);
  });

  it("supersedes：模型抄得略有出入（多一个句号）仍能命中旧记忆", () => {
    const coffee: IMemory = {
      ...existing,
      id: "mem-coffee",
      content: "用户喜欢喝咖啡",
      keywords: ["咖啡"],
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [coffee],
      drafts: [
        {
          kind: "preference",
          content: "用户戒了咖啡改喝茶",
          keywords: ["咖啡", "茶"],
          importance: 4,
          supersedes: "用户喜欢喝咖啡。",
        },
      ],
      now: NOW,
      idFactory: () => "mem-tea",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("mem-tea");
  });

  it("单次整理最多取代 3 条，模型乱标也炸不掉整个记忆库", () => {
    const memories: IMemory[] = Array.from({ length: 6 }, (_, i) => ({
      ...existing,
      id: `mem-${i}`,
      content: `旧记忆${i}`,
      keywords: [],
    }));

    const merged = mergeMemories({
      characterId: "char-1",
      existing: memories,
      // 模型把 5 条旧记忆都标成被取代
      drafts: Array.from({ length: 5 }, (_, i) => ({
        kind: "fact" as const,
        content: `新信息${i}`,
        keywords: [],
        importance: 3 as const,
        supersedes: `旧记忆${i}`,
      })),
      now: NOW,
      idFactory: (() => {
        let n = 0;
        return () => `mem-new-${n++}`;
      })(),
    });

    // 只允许删掉 3 条旧记忆，其余保留，5 条新信息都写进去
    expect(merged.filter((m) => m.id.startsWith("mem-") && !m.id.includes("new"))).toHaveLength(3);
    expect(merged.filter((m) => m.id.includes("new"))).toHaveLength(5);
  });

  it("supersedes 不动置顶记忆（用户显式标了'永远记住'）", () => {
    const pinnedAllergy: IMemory = {
      ...existing,
      id: "mem-pinned",
      content: "用户对花生严重过敏",
      keywords: ["花生", "过敏"],
      importance: 5,
      pinned: true,
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [pinnedAllergy],
      drafts: [
        {
          kind: "fact",
          content: "用户已经不过敏了",
          keywords: ["过敏"],
          importance: 4,
          supersedes: "用户对花生严重过敏",
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });

    // 置顶那条原样保留，新信息并存——交给用户在面板里判断
    expect(merged.map((m) => m.id)).toEqual(["mem-pinned", "mem-new"]);
    expect(merged[0]!.pinned).toBe(true);
    // 并存的两条要在界面上能看出"这是冲突"，而不是让用户自己去比对
    expect(merged[1]!.conflictsWith).toBe("用户对花生严重过敏");
  });

  it("supersedes：指向不存在或无关的内容时，绝不误删记忆", () => {
    const city: IMemory = {
      ...existing,
      id: "mem-city",
      content: "用户住在北京",
      keywords: ["北京"],
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [city],
      drafts: [
        {
          kind: "fact",
          content: "用户养了一只叫团子的猫",
          keywords: ["猫"],
          importance: 3,
          supersedes: "用户喜欢喝咖啡",
        },
      ],
      now: NOW,
      idFactory: () => "mem-cat",
    });

    expect(merged.map((m) => m.id)).toEqual(["mem-city", "mem-cat"]);
  });

  it("全新记忆追加到列表", () => {
    const merged = mergeMemories({
      characterId: "char-1",
      existing: [existing],
      drafts: [
        {
          kind: "fact",
          content: "用户住在杭州",
          keywords: ["杭州"],
          importance: 3,
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });
    expect(merged).toHaveLength(2);
    expect(merged[1]!.id).toBe("mem-new");
    expect(merged[1]!.characterId).toBe("char-1");
  });

  it("包含式去重：把多个已有事实合并成的长句不重复累积", () => {
    const merged = mergeMemories({
      characterId: "char-1",
      existing: [
        {
          id: "mem-name",
          characterId: "char-1",
          kind: "fact",
          content: "用户名叫小明",
          keywords: ["小明"],
          importance: 5,
          pinned: false,
          createdAt: NOW,
          updatedAt: NOW,
          sourceMessageIds: [],
        },
      ],
      drafts: [
        {
          kind: "fact",
          content: "用户名叫小明，最喜欢喝冰美式。",
          keywords: ["小明", "冰美式"],
          importance: 5,
        },
      ],
      now: NOW,
    });

    // 应合并进已有条目，而不是新增一条语义重复的记忆
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("mem-name");
    expect(merged[0]!.content).toBe("用户名叫小明，最喜欢喝冰美式。");
  });

  // ---------- 用户手动维护的记忆受保护 ----------

  it("手动维护的记忆不会被自动整理改写（撞车时以用户的版本为准）", () => {
    const manual: IMemory = {
      ...existing,
      id: "mem-manual",
      content: "用户在准备考研",
      origin: "manual",
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [manual],
      drafts: [
        {
          kind: "fact",
          // 自动整理把同一条事实写得更长——正是过去会覆盖用户改动的形态
          content: "用户在准备考研，目标是本校",
          keywords: ["考研"],
          importance: 5,
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("mem-manual");
    expect(merged[0]!.content).toBe("用户在准备考研");
    expect(merged[0]!.updatedAt).toBe(NOW - 1000);
  });

  it("手动维护的记忆不会被 supersedes 删掉，新信息并存并标出冲突", () => {
    const manual: IMemory = {
      ...existing,
      id: "mem-manual",
      content: "用户对花生过敏",
      origin: "manual",
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [manual],
      drafts: [
        {
          kind: "fact",
          content: "用户现在对花生不过敏了",
          keywords: ["花生"],
          importance: 4,
          supersedes: "用户对花生过敏",
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });

    // 用户写的那条原样保留
    expect(merged).toHaveLength(2);
    expect(merged[0]!.id).toBe("mem-manual");
    expect(merged[0]!.content).toBe("用户对花生过敏");
    // 新信息并存，并带上"和谁冲突"——面板据此提示用户自己定
    expect(merged[1]!.content).toBe("用户现在对花生不过敏了");
    expect(merged[1]!.conflictsWith).toBe("用户对花生过敏");
  });

  it("置顶记忆同样不会被改写（此前只防删除、不防改写）", () => {
    const pinned: IMemory = {
      ...existing,
      id: "mem-pinned",
      content: "用户对花生过敏",
      pinned: true,
    };

    const merged = mergeMemories({
      characterId: "char-1",
      existing: [pinned],
      drafts: [
        {
          kind: "fact",
          content: "用户对花生过敏，而且对芒果也过敏，需要特别注意",
          keywords: ["花生", "芒果"],
          importance: 5,
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("用户对花生过敏");
  });

  it("自动整理出来的记忆照旧合并（保护只针对手动与置顶）", () => {
    const merged = mergeMemories({
      characterId: "char-1",
      existing: [{ ...existing, origin: "auto" }],
      drafts: [
        {
          kind: "preference",
          content: "用户喜欢猫咪和狗",
          keywords: ["狗"],
          importance: 5,
        },
      ],
      now: NOW,
      idFactory: () => "mem-new",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("用户喜欢猫咪和狗");
  });
});
