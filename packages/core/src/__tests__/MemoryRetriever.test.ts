/**
 * @file MemoryRetriever.test.ts
 * 记忆关键词提取、打分与预算截断测试。
 */

import { describe, it, expect } from "vitest";
import type { IMemory } from "@wechat-rp/shared-types";
import {
  bigramSimilarity,
  extractKeywords,
  retrieveMemories,
  scoreMemory,
} from "../memory/MemoryRetriever";

const NOW = 1_700_000_000_000;

function makeMemory(overrides: Partial<IMemory>): IMemory {
  return {
    id: "mem-1",
    characterId: "char-1",
    kind: "fact",
    content: "用户喜欢猫",
    keywords: ["猫", "喜欢"],
    importance: 3,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
    ...overrides,
  };
}

describe("extractKeywords", () => {
  it("中文生成 2-gram 关键词", () => {
    const keywords = extractKeywords("我喜欢猫");
    expect(keywords).toContain("喜欢");
    expect(keywords).toContain("欢猫");
  });

  it("英文与数字整词提取（小写）", () => {
    const keywords = extractKeywords("I love Coffee 2024");
    expect(keywords).toContain("love");
    expect(keywords).toContain("coffee");
    expect(keywords).toContain("2024");
  });
});

describe("bigramSimilarity", () => {
  it("完全相同文本相似度为 1", () => {
    expect(bigramSimilarity("用户喜欢猫", "用户喜欢猫")).toBe(1);
  });

  it("无关文本相似度低", () => {
    expect(bigramSimilarity("用户喜欢猫", "明天要去公司开会")).toBeLessThan(0.2);
  });
});

describe("retrieveMemories", () => {
  it("相关记忆排在无关记忆之前", () => {
    const catMemory = makeMemory({ id: "mem-cat", content: "用户喜欢猫" });
    const workMemory = makeMemory({
      id: "mem-work",
      content: "用户在公司担任产品经理",
      keywords: ["公司", "产品经理"],
    });

    const result = retrieveMemories("我家猫今天很粘人", [workMemory, catMemory], {
      now: NOW,
    });
    expect(result[0]!.id).toBe("mem-cat");
  });

  it("置顶记忆优先于更相关的普通记忆", () => {
    const normal = makeMemory({ id: "mem-a", updatedAt: NOW });
    const pinned = makeMemory({ id: "mem-b", pinned: true, updatedAt: NOW });

    const result = retrieveMemories("喜欢", [normal, pinned], { now: NOW });
    expect(result[0]!.id).toBe("mem-b");
  });

  it("置顶记忆即使与本次输入毫不相关也必定注入（常驻条目语义）", () => {
    // 用户明确置顶"对花生过敏"，随后聊的是完全无关的话题
    const allergy = makeMemory({
      id: "mem-allergy",
      content: "用户对花生过敏",
      keywords: ["花生", "过敏"],
      importance: 5,
      pinned: true,
    });
    const others = Array.from({ length: 12 }, (_, i) =>
      makeMemory({
        id: `mem-${i}`,
        content: `无关记忆${i}`,
        keywords: ["猫", "喜欢", "公司"],
      }),
    );

    const result = retrieveMemories("今天天气不错", [allergy, ...others], {
      maxItems: 3,
      now: NOW,
    });
    expect(result.map((m) => m.id)).toContain("mem-allergy");
    // 置顶记忆排在最前，其余名额留给相关度最高的——
    // 而那些记忆跟"今天天气不错"毫无关系，所以一个都不该进来
    expect(result[0]!.id).toBe("mem-allergy");
    expect(result).toHaveLength(1);
  });

  it("置顶记忆之间按重要度排序，且不会挤爆条数预算", () => {
    const pinnedLow = makeMemory({ id: "p-low", pinned: true, importance: 1 });
    const pinnedHigh = makeMemory({ id: "p-high", pinned: true, importance: 5 });
    const normal = makeMemory({ id: "n-1" });

    const result = retrieveMemories("喜欢猫", [pinnedLow, pinnedHigh, normal], {
      maxItems: 2,
      now: NOW,
    });
    expect(result.map((m) => m.id)).toEqual(["p-high", "p-low"]);
  });

  it("遵守条数预算", () => {
    const memories = [
      makeMemory({ id: "m1", content: "用户养了一只猫", keywords: ["猫"] }),
      makeMemory({ id: "m2", content: "用户喜欢喝咖啡", keywords: ["咖啡"] }),
      makeMemory({ id: "m3", content: "用户下周去杭州", keywords: ["杭州"] }),
    ];
    const result = retrieveMemories("猫和咖啡都喜欢", memories, {
      maxItems: 2,
      now: NOW,
    });
    expect(result).toHaveLength(2);
  });

  it("遵守字数预算（至少保留一条）", () => {
    const long = makeMemory({
      id: "long",
      content: "用户非常喜欢猫".repeat(50),
      keywords: ["猫"],
    });
    const short = makeMemory({ id: "short", content: "短记忆", keywords: ["猫"] });

    const result = retrieveMemories("猫", [long, short], {
      maxChars: 50,
      now: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("long");
  });

  it("时间衰减降低旧记忆得分", () => {
    const fresh = makeMemory({ id: "fresh", updatedAt: NOW });
    const stale = makeMemory({
      id: "stale",
      updatedAt: NOW - 365 * 24 * 60 * 60 * 1000,
    });
    expect(scoreMemory(fresh, "喜欢猫", NOW)).toBeGreaterThan(
      scoreMemory(stale, "喜欢猫", NOW),
    );
  });
});
