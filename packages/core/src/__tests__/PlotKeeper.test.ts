/**
 * @file PlotKeeper.test.ts
 * 剧情状态卡应用、事件去重、回滚与摘要渲染测试。
 */

import { describe, it, expect } from "vitest";
import type {
  IBackgroundDigest,
  IPlotEvent,
  IPlotState,
} from "@wechat-rp/shared-types";
import {
  applyDigest,
  buildPlotAdvancePrompt,
  createEmptyPlotState,
  diffPlotCards,
  renderPlotSummary,
  rollbackPlotState,
} from "../plot/PlotKeeper";

const NOW = 1_700_000_000_000;

function makeDigest(overrides: Partial<IBackgroundDigest> = {}): IBackgroundDigest {
  return {
    memories: [],
    events: [{ summary: "两人在咖啡馆见面", importance: 4 }],
    plot: {
      chapter: "第一章",
      scene: "咖啡馆",
      synopsis: "两人重逢",
      openThreads: ["未送出的礼物"],
      relations: [{ characterId: "char-1", label: "青梅竹马" }],
    },
    ...overrides,
  };
}

describe("createEmptyPlotState", () => {
  it("创建空白状态卡", () => {
    const state = createEmptyPlotState("s1", NOW);
    expect(state.sessionId).toBe("s1");
    expect(state.events).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.updatedAt).toBe(NOW);
  });
});

describe("applyDigest", () => {
  it("首次整理创建状态卡并追加事件", () => {
    const state = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      sourceMessageIds: ["m1", "m2"],
      idFactory: () => "evt-1",
    });
    expect(state.chapter).toBe("第一章");
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.id).toBe("evt-1");
    expect(state.events[0]!.sourceMessageIds).toEqual(["m1", "m2"]);
    // 首次创建（空白卡）不产生快照
    expect(state.history).toHaveLength(0);
  });

  it("状态卡变化时压入历史快照", () => {
    const first = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      idFactory: () => "evt-1",
    });
    const second = applyDigest({
      sessionId: "s1",
      state: first,
      digest: makeDigest({
        plot: { chapter: "第二章", synopsis: "关系升温" },
        events: [],
      }),
      now: NOW + 1000,
      idFactory: () => "evt-2",
    });

    expect(second.chapter).toBe("第二章");
    expect(second.history).toHaveLength(1);
    expect(second.history[0]!.chapter).toBe("第一章");
    // 未提供的字段保持不变
    expect(second.scene).toBe("咖啡馆");
  });

  it("重复事件按摘要去重", () => {
    const first = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      idFactory: () => "evt-1",
    });
    const second = applyDigest({
      sessionId: "s1",
      state: first,
      digest: makeDigest({ plot: {} }),
      now: NOW + 1000,
      idFactory: () => "evt-2",
    });
    expect(second.events).toHaveLength(1);
  });

  it("时间线保留最近 N 条", () => {
    let state = createEmptyPlotState("s1", NOW);
    for (let i = 0; i < 5; i += 1) {
      state = applyDigest({
        sessionId: "s1",
        state,
        digest: makeDigest({
          plot: {},
          events: [{ summary: `事件 ${i}`, importance: 3 }],
        }),
        now: NOW + i,
        maxEvents: 3,
        idFactory: () => `evt-${i}`,
      });
    }
    expect(state.events).toHaveLength(3);
    expect(state.events[2]!.summary).toBe("事件 4");
  });

  it("时间线满时，**用户手动加的事件**不会被自动累积挤掉", () => {
    // 先手动记一条（真实场景：用户自己把"第一章·重逢"写进时间线）
    let state: IPlotState = {
      ...createEmptyPlotState("s1", NOW),
      events: [
        {
          id: "manual-1",
          summary: "第一章：两人在咖啡馆重逢",
          at: NOW,
          importance: 5,
          sourceMessageIds: [],
          manual: true,
        },
      ],
    };

    // 之后自动整理一路累积，远超上限
    for (let i = 0; i < 5; i += 1) {
      state = applyDigest({
        sessionId: "s1",
        state,
        digest: makeDigest({
          plot: {},
          events: [{ summary: `自动事件 ${i}`, importance: 3 }],
        }),
        now: NOW + i + 1,
        maxEvents: 3,
        idFactory: () => `auto-${i}`,
      });
    }

    expect(state.events).toHaveLength(3);
    // 手写的那条还在（改前是 slice(-3)，它第一个被挤掉）
    expect(state.events.map((event) => event.id)).toContain("manual-1");
    // 剩下的名额给最近的自动事件
    expect(state.events.map((event) => event.summary)).toEqual([
      "第一章：两人在咖啡馆重逢",
      "自动事件 3",
      "自动事件 4",
    ]);
  });

  it("显式空线索会清空卡上的未解线索，并把旧版本压进快照（可回滚）", () => {
    const withThreads: IPlotState = {
      ...createEmptyPlotState("s1", NOW),
      chapter: "摄影展之约",
      openThreads: ["周六摄影展实际参观情况"],
    };

    const next = applyDigest({
      sessionId: "s1",
      state: withThreads,
      digest: makeDigest({
        plot: { chapter: "摄影展之约·参观完成", openThreads: [], relations: [] },
        events: [],
      }),
      now: NOW + 1000,
    });

    // 改了状态卡字段 → 旧版本压进快照，用户点「← 回滚」能退回去
    expect(next.openThreads).toEqual([]);
    expect(next.history).toHaveLength(1);
    expect(next.history[0]!.openThreads).toEqual([
      "周六摄影展实际参观情况",
    ]);
  });

  it("手动事件自己就超上限时，按时间保最近的（别让数组无限长）", () => {
    const many: IPlotEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: `manual-${i}`,
      summary: `手写事件 ${i}`,
      at: NOW + i,
      importance: 3,
      sourceMessageIds: [],
      manual: true,
    }));
    const state: IPlotState = {
      ...createEmptyPlotState("s1", NOW),
      events: many,
    };

    const next = applyDigest({
      sessionId: "s1",
      state,
      digest: makeDigest({ plot: {}, events: [] }),
      now: NOW + 100,
      maxEvents: 3,
    });

    expect(next.events.map((event) => event.id)).toEqual([
      "manual-2",
      "manual-3",
      "manual-4",
    ]);
  });
});

describe("rollbackPlotState", () => {
  it("回滚恢复上一版状态卡并弹出快照", () => {
    const first = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      idFactory: () => "evt-1",
    });
    const second = applyDigest({
      sessionId: "s1",
      state: first,
      digest: makeDigest({ plot: { chapter: "第二章" }, events: [] }),
      now: NOW + 1000,
    });

    const rolled = rollbackPlotState(second, NOW + 2000);
    expect(rolled).not.toBeNull();
    expect(rolled!.chapter).toBe("第一章");
    expect(rolled!.history).toHaveLength(0);
    // 事件不回滚
    expect(rolled!.events).toHaveLength(1);
  });

  it("没有历史快照时返回 null", () => {
    expect(rollbackPlotState(createEmptyPlotState("s1", NOW))).toBeNull();
  });
});

describe("renderPlotSummary", () => {
  it("空白状态返回空字符串", () => {
    expect(renderPlotSummary(null)).toBe("");
    expect(renderPlotSummary(createEmptyPlotState("s1", NOW))).toBe("");
  });

  it("渲染章节 / 线索 / 概要", () => {
    const state = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      idFactory: () => "evt-1",
    });
    const summary = renderPlotSummary(state);
    expect(summary).toContain("【当前剧情】");
    expect(summary).toContain("章节：第一章");
    expect(summary).toContain("未解线索：1) 未送出的礼物");
    expect(summary).toContain("剧情概要：两人重逢");
  });
});

describe("buildPlotAdvancePrompt", () => {
  it("有状态卡时要求推进未解线索", () => {
    const state = applyDigest({
      sessionId: "s1",
      state: null,
      digest: makeDigest(),
      now: NOW,
      idFactory: () => "evt-1",
    });
    const prompt = buildPlotAdvancePrompt("苏晚晴", state);
    expect(prompt).toContain("推进");
    expect(prompt).toContain("未解线索");
  });

  it("无状态卡时退化为通用主动消息指令", () => {
    const prompt = buildPlotAdvancePrompt("苏晚晴", null);
    expect(prompt).toContain("主动给对方发一条消息");
  });
});

describe("diffPlotCards", () => {
  /** 一版"和好之后"的卡。 */
  const before = {
    chapter: "第二章",
    scene: "美术馆",
    timeLabel: "周六下午",
    location: "市美术馆",
    synopsis: "两人和好，约了周六看展。",
    openThreads: ["周六的展还没定下来", "说好要送的摄影集还没送出去"],
    relations: [{ characterId: "char-1", label: "关系缓和" }],
  };

  it("逐字对比文本字段，给出前后值", () => {
    const changes = diffPlotCards(before, {
      ...before,
      scene: "回家路上",
      synopsis: "两人看完展，一起走回家。",
    });

    expect(changes).toContainEqual({
      field: "场景",
      from: "美术馆",
      to: "回家路上",
    });
    expect(changes).toContainEqual({
      field: "概要",
      from: "两人和好，约了周六看展。",
      to: "两人看完展，一起走回家。",
    });
    // 没动的字段不出现
    expect(changes.some((change) => change.field === "章节")).toBe(false);
  });

  it("线索：新增与了结分开列", () => {
    const changes = diffPlotCards(before, {
      ...before,
      openThreads: ["说好要送的摄影集还没送出去", "下周三一起吃饭"],
    });

    expect(changes).toContainEqual({
      field: "了结线索",
      from: "周六的展还没定下来",
      to: null,
    });
    expect(changes).toContainEqual({
      field: "新增线索",
      from: null,
      to: "下周三一起吃饭",
    });
  });

  it("关系：新增、改写、移除都能看出来", () => {
    const changed = diffPlotCards(before, {
      ...before,
      relations: [{ characterId: "char-1", label: "开始有点心动" }],
    });
    expect(changed).toContainEqual({
      field: "关系",
      from: "关系缓和",
      to: "开始有点心动",
    });

    const added = diffPlotCards(before, {
      ...before,
      relations: [
        ...before.relations,
        { characterId: "char-2", label: "点头之交" },
      ],
    });
    expect(added).toContainEqual({
      field: "新增关系",
      from: null,
      to: "点头之交",
    });

    const removed = diffPlotCards(before, { ...before, relations: [] });
    expect(removed).toContainEqual({
      field: "移除关系",
      from: "关系缓和",
      to: null,
    });
  });

  it("没有变化时返回空数组（界面据此不显示这一块）", () => {
    expect(diffPlotCards(before, { ...before })).toEqual([]);
  });

  it("从空白卡到第一版：所有有值的字段都算变化", () => {
    const changes = diffPlotCards(null, before);

    expect(changes).toContainEqual({
      field: "章节",
      from: null,
      to: "第二章",
    });
    expect(changes.filter((change) => change.field === "新增线索")).toHaveLength(2);
    expect(changes.some((change) => change.field === "移除关系")).toBe(false);
  });
});
