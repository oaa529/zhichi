/**
 * @file sanitize.test.ts
 * 持久化快照容错：坏条目被丢掉，好条目与其余字段原样保留。
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeRecord,
  sanitizeSessionSnapshot,
} from "../storage/sanitize";

describe("sanitizeRecord", () => {
  it("按谓词过滤，并报告被丢掉的 key", () => {
    const { kept, dropped } = sanitizeRecord<number>(
      { a: 1, b: "不是数字", c: 3, d: null },
      (item) => typeof item === "number",
    );
    expect(kept).toEqual({ a: 1, c: 3 });
    expect(dropped).toEqual(["b", "d"]);
  });

  it("传入非对象时返回空记录（不抛错）", () => {
    expect(sanitizeRecord(null, () => true).kept).toEqual({});
    expect(sanitizeRecord("字符串", () => true).kept).toEqual({});
  });
});

describe("sanitizeSessionSnapshot", () => {
  it("sessions 里的 null / 缺字段条目被丢掉，正常会话保留", () => {
    const { value, report } = sanitizeSessionSnapshot<{
      sessions: Record<string, unknown>;
    }>({
      sessions: {
        good: { id: "good", displayName: "苏晚晴", participantIds: ["char-1"] },
        badNull: null,
        badNoParts: { id: "x", displayName: "缺参与者" },
      },
    });

    expect(Object.keys(value!.sessions)).toEqual(["good"]);
    expect(report.dropped).toContain("sessions.badNull");
    expect(report.dropped).toContain("sessions.badNoParts");
  });

  it("activeSessionId 指向被丢掉的会话时归零（否则会停在空白会话）", () => {
    const { value } = sanitizeSessionSnapshot<{ activeSessionId: string | null }>({
      sessions: { bad: null },
      activeSessionId: "bad",
    });
    expect(value!.activeSessionId).toBeNull();
  });

  it("activeSessionId 正常时保留", () => {
    const { value } = sanitizeSessionSnapshot<{ activeSessionId: string | null }>({
      sessions: {
        good: { id: "good", displayName: "苏晚晴", participantIds: [] },
      },
      activeSessionId: "good",
    });
    expect(value!.activeSessionId).toBe("good");
  });

  it("运行时快照的 messages 不是数组就丢掉（渲染时会炸）", () => {
    const { value, report } = sanitizeSessionSnapshot<{
      sessionRuntimes: Record<string, unknown>;
    }>({
      sessionRuntimes: {
        ok: { messages: [] },
        broken: { messages: "不是数组" },
      },
    });
    expect(Object.keys(value!.sessionRuntimes)).toEqual(["ok"]);
    expect(report.dropped).toContain("sessionRuntimes.broken");
  });

  it("记忆、草稿、游标里的坏值被逐条丢掉", () => {
    const { value } = sanitizeSessionSnapshot<{
      memories: Record<string, unknown>;
      drafts: Record<string, string>;
      digestCursors: Record<string, number>;
    }>({
      memories: { c1: [{ id: "m1" }], c2: "不是数组" },
      drafts: { s1: "半句话", s2: 123 },
      digestCursors: { s1: 10, s2: Number.NaN, s3: "10" },
    });

    expect(Object.keys(value!.memories)).toEqual(["c1"]);
    expect(value!.drafts).toEqual({ s1: "半句话" });
    expect(value!.digestCursors).toEqual({ s1: 10 });
  });

  it("世界书：丢掉结构不对的条目，整本坏世界书也不拖垮数据", () => {
    const { value, report } = sanitizeSessionSnapshot<{
      loreEntries: Record<string, ReadonlyArray<unknown>>;
    }>({
      loreEntries: {
        c1: [
          { id: "lore-1", keys: ["唱片"], content: "设定一" },
          { id: "lore-2", keys: "不是数组", content: "坏条目" },
          { id: 3, keys: [], content: "坏 ID" },
          null,
        ],
        c2: "不是数组",
        c3: [{ id: "lore-3", keys: [], content: "只有一条好条目" }],
      },
    });

    expect(value!.loreEntries.c1).toHaveLength(1);
    expect(value!.loreEntries.c2).toBeUndefined();
    expect(value!.loreEntries.c3).toHaveLength(1);
    expect(report.dropped).toContain("loreEntries.c2");
  });

  it("非对象快照返回 null（等价于没有可用数据）", () => {
    expect(sanitizeSessionSnapshot(null).value).toBeNull();
    expect(sanitizeSessionSnapshot("坏数据").value).toBeNull();
  });

  it("累计用量：保留合法条目，丢掉结构不对的", () => {
    const { value, report } = sanitizeSessionSnapshot<{
      tokenUsageBySession: Record<string, unknown>;
    }>({
      tokenUsageBySession: {
        good: { requests: 3, tokens: 1500 },
        缺字段: { requests: 1 },
        不是对象: "1500",
        非数字: { requests: "1", tokens: 2 },
      },
    });

    expect(value!.tokenUsageBySession).toEqual({
      good: { requests: 3, tokens: 1500 },
    });
    expect(report.dropped).toContain("tokenUsageBySession.缺字段");
    expect(report.dropped).toContain("tokenUsageBySession.不是对象");
  });

  it("未识别的字段原样保留（避免清洗把新字段洗没了）", () => {
    const { value } = sanitizeSessionSnapshot<{ digestConfig: unknown }>({
      digestConfig: { enabled: true, threshold: 20 },
    });
    expect(value!.digestConfig).toEqual({ enabled: true, threshold: 20 });
  });
});
