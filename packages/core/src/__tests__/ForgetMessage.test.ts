/**
 * @file ForgetMessage.test.ts
 * "删掉消息 = 让角色忘掉这一句" 的判定规则。
 *
 * 这里最怕两件事：漏删（角色照样记得）与错删（一句"嗯"带走半本记忆库）。
 * 每条用例都在往这两个方向上顶。
 */

import { describe, it, expect } from "vitest";
import type { IMemory, IPlotEvent } from "@wechat-rp/shared-types";
import {
  forgetEventsFromTexts,
  forgetMemoriesFromTexts,
  looksDerivedFrom,
} from "../memory/ForgetMessage";

function memory(id: string, content: string, sources: string[] = []): IMemory {
  return {
    id,
    characterId: "c1",
    kind: "fact",
    content,
    keywords: [],
    importance: 3,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    sourceMessageIds: sources,
  };
}

function event(id: string, summary: string): IPlotEvent {
  return {
    id,
    summary,
    at: 1,
    importance: 3,
    sourceMessageIds: [],
    manual: false,
  };
}

describe("looksDerivedFrom", () => {
  it("原样搬过去：算", () => {
    expect(
      looksDerivedFrom("我下周三要去拔智齿", "用户下周三要去拔智齿"),
    ).toBe(true);
  });

  it("模型改写了一两个字：也算", () => {
    expect(
      looksDerivedFrom(
        "我下周三要去拔智齿，有点紧张",
        "用户下周三要拔智齿，心里紧张",
      ),
    ).toBe(true);
  });

  it("标点与空格不参与比对", () => {
    expect(
      looksDerivedFrom("我 下周三 要去医院！", "用户下周三要去医院"),
    ).toBe(true);
  });

  it("只沾一点边的不算（宁可少删）", () => {
    expect(
      looksDerivedFrom("我下周三要去拔智齿", "用户最近很在意牙齿健康"),
    ).toBe(false);
  });

  it("短句从严：一句「嗯」不该带走别的记忆", () => {
    expect(looksDerivedFrom("嗯", "用户嗯了一声")).toBe(false);
    // 但整段就是这句的时候仍然要认
    expect(looksDerivedFrom("嗯嗯", "嗯嗯")).toBe(true);
    // "在吗"这类短句只认几乎一致的
    expect(looksDerivedFrom("在吗", "用户在问在不在")).toBe(false);
  });

  it("空文本一律不匹配", () => {
    expect(looksDerivedFrom("", "随便什么")).toBe(false);
    expect(looksDerivedFrom("有内容", "")).toBe(false);
  });
});

describe("forgetMemoriesFromTexts", () => {
  it("只删来自那句话的记忆，其余原样保留", () => {
    const memories = [
      memory("m1", "用户下周三要去拔智齿"),
      memory("m2", "用户养了一只叫团团的猫"),
      memory("m3", "用户喜欢喝冰美式"),
    ];

    const { kept, forgotten } = forgetMemoriesFromTexts(memories, [
      "我下周三要去拔智齿",
    ]);

    expect(forgotten.map((m) => m.id)).toEqual(["m1"]);
    expect(kept.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("保留下来的记忆会摘掉被删消息的 id（来源计数不该算上已删消息）", () => {
    const memories = [
      memory("m1", "用户养了一只叫团团的猫", ["msg-1", "msg-2"]),
      memory("m2", "用户喜欢喝冰美式", ["msg-2"]),
    ];

    const { kept } = forgetMemoriesFromTexts(
      memories,
      ["今天天气不错"],
      ["msg-1"],
    );

    expect(kept[0]!.sourceMessageIds).toEqual(["msg-2"]);
    // 没有这条 id 的条目保持原引用（不必要地复制整个数组）
    expect(kept[1]).toBe(memories[1]);
  });

  it("没有任何文本时不改动（调用方据此跳过）", () => {
    const memories = [memory("m1", "用户养了一只叫团团的猫")];
    const { kept, forgotten } = forgetMemoriesFromTexts(memories, []);

    expect(forgotten).toHaveLength(0);
    expect(kept[0]).toBe(memories[0]);
  });

  it("多条被删消息一起处理（删掉整段聊天时）", () => {
    const memories = [
      memory("m1", "用户下周三要去拔智齿"),
      memory("m2", "用户说自己这周末要去看那个新展"),
      memory("m3", "用户养了一只叫团团的猫"),
    ];

    const { forgotten } = forgetMemoriesFromTexts(memories, [
      "我下周三要去拔智齿",
      "这周末去看那个新展",
    ]);

    expect(forgotten.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("用户自己维护的记忆不动：置顶 / 手动新增（相似匹配是启发式的，别误伤）", () => {
    const memories = [
      memory("m1", "用户下周三要去拔智齿"),
      { ...memory("m2", "用户下周三要去拔智齿"), pinned: true },
      { ...memory("m3", "用户下周三要去拔智齿"), origin: "manual" as const },
    ];

    const { kept, forgotten } = forgetMemoriesFromTexts(memories, [
      "我下周三要去拔智齿",
    ]);

    expect(forgotten.map((m) => m.id)).toEqual(["m1"]);
    expect(kept.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("界限：被压缩得很厉害的改写认不出来（宁可少删，不可错删）", () => {
    // "这周末去看那个新展" → "用户周末要去看展"：相似度只有 0.27，
    // 硬套阈值就会开始误伤别的记忆，所以这里选择不删
    expect(
      looksDerivedFrom("这周末去看那个新展", "用户周末要去看展"),
    ).toBe(false);
  });
});

describe("forgetEventsFromTexts", () => {
  it("时间线里来自那句话的事件被摘掉", () => {
    const events = [
      event("e1", "用户说自己下周三要去拔智齿"),
      event("e2", "两人约好周六下午去看展"),
    ];

    const { kept, forgotten } = forgetEventsFromTexts(events, [
      "我下周三要去拔智齿",
    ]);

    expect(forgotten.map((e) => e.id)).toEqual(["e1"]);
    expect(kept.map((e) => e.id)).toEqual(["e2"]);
  });

  it("手动加的事件只要不是那句话的衍生，也保留", () => {
    const manual = { ...event("e1", "第一章：重逢"), manual: true };
    const { kept } = forgetEventsFromTexts([manual], ["我下周三要去拔智齿"]);

    expect(kept).toHaveLength(1);
  });

  it("手写的事件即使跟被删消息很像也不动（用户可以在时间线里自己删）", () => {
    const manual = { ...event("e1", "用户下周三要去拔智齿"), manual: true };
    const auto = event("e2", "用户下周三要去拔智齿");

    const { kept, forgotten } = forgetEventsFromTexts(
      [manual, auto],
      ["我下周三要去拔智齿"],
    );

    expect(forgotten.map((e) => e.id)).toEqual(["e2"]);
    expect(kept.map((e) => e.id)).toEqual(["e1"]);
  });
});
