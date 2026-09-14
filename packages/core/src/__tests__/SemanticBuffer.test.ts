/**
 * @file SemanticBuffer.test.ts
 * SemanticBuffer 切分边界测试。
 */

import { describe, it, expect } from "vitest";
import { SemanticBuffer } from "../SemanticBuffer";
import type { ISimulationConfig } from "@wechat-rp/shared-types";
import type { MessageChunk } from "../types";

const mockConfig: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "normal",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 6000,
};

function createBuffer(configOverride?: Partial<ISimulationConfig>) {
  return new SemanticBuffer({
    sessionId: "sess-1",
    characterId: "char-1",
    config: { ...mockConfig, ...configOverride },
  });
}

describe("SemanticBuffer", () => {
  it("push() 在命中句号时切分", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("你好。", (c) => chunks.push(c));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("你好。");
    expect(buffer.pendingLength).toBe(0);
  });

  it("push() 无标点时不切分，保留在 buffer 中", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("你好世界", (c) => chunks.push(c));

    expect(chunks).toHaveLength(0);
    expect(buffer.pendingLength).toBe(4);
  });

  it("push() 命中逗号时切分", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("今天天气不错，", (c) => chunks.push(c));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("今天天气不错，");
  });

  it("连续换行不产生空气泡（真实模型常见输出）", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    // 形如模型输出的 "…\n\n刚忙完呢，"
    buffer.push("刚忙完呢，\n\n", (c) => chunks.push(c));

    // 只应产出实际内容，换行片段被丢弃
    expect(chunks.map((c) => c.text)).toEqual(["刚忙完呢，"]);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("纯空白的结束残余不产生气泡", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("好。\n  \n", (c) => chunks.push(c));
    const flushed = buffer.complete((c) => chunks.push(c));

    expect(flushed).toHaveLength(0);
    expect(chunks.map((c) => c.text)).toEqual(["好。"]);
  });

  it("丢弃空白片段后 chunkSequence 仍然连续", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("一，\n\n二，\n三。", (c) => chunks.push(c));

    expect(chunks.map((c) => c.text)).toEqual(["一，", "二，", "三。"]);
    expect(chunks.map((c) => c.chunkSequence)).toEqual([0, 1, 2]);
  });

  it("纯结构性标点片段不产生气泡（真实模型的行尾句点/列表符号）", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("冰美式.\n.\n.\n挺常见的选择呢。", (c) => chunks.push(c));

    expect(chunks.map((c) => c.text)).toEqual(["冰美式.", "挺常见的选择呢。"]);
  });

  it("有表达力的标点（省略号/问号）单独成气泡时保留", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("…", (c) => chunks.push(c));

    expect(chunks.map((c) => c.text)).toEqual(["…"]);

    const buffer2 = createBuffer();
    const chunks2: MessageChunk[] = [];
    buffer2.push("？", (c) => chunks2.push(c));
    expect(chunks2.map((c) => c.text)).toEqual(["？"]);
  });

  it("push() 多次调用持续切分", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("你好。", (c) => chunks.push(c));
    buffer.push("今天天气不错。", (c) => chunks.push(c));
    buffer.push("你吃饭了吗？", (c) => chunks.push(c));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toBe("你好。");
    expect(chunks[1]!.text).toBe("今天天气不错。");
    expect(chunks[2]!.text).toBe("你吃饭了吗？");
  });

  it("complete() flush 残余 buffer 作为末端 chunk", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("这是一段没有标点结尾的文字", (c) => chunks.push(c));

    expect(chunks).toHaveLength(0);

    const finalChunks = buffer.complete((c) => chunks.push(c));
    expect(finalChunks).toHaveLength(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("这是一段没有标点结尾的文字");
    expect(chunks[0]!.isTerminal).toBe(true);
  });

  it("complete() 后 buffer 为空可复用", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];

    // 第一轮：push 命中标点→flush 1 chunk，complete 时 buffer 已空→flush 0 chunk
    buffer.push("第一句。", (c) => chunks.push(c));
    buffer.complete((c) => chunks.push(c));

    // 第二轮：复用
    buffer.push("第二句。", (c) => chunks.push(c));
    buffer.complete((c) => chunks.push(c));

    // push 命中标点 → 1 chunk + complete 空 buffer → 0 chunk = 2 chunk per round
    // 总计 2 chunks（每轮 push 各产出 1 个，complete 产出 0 个因为 buffer 已空）
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe("第一句。");
    expect(chunks[1]!.text).toBe("第二句。");
  });

  it("push() 在 complete() 后调用不报错（complete 重置了状态）", () => {
    const buffer = createBuffer();
    buffer.complete(() => {});

    expect(() => buffer.push("test", () => {})).not.toThrow();
  });

  it("超过 fragmentationThresholdChars 时强制切分", () => {
    const buffer = createBuffer({
      fragmentationThresholdChars: 10,
    });
    const chunks: MessageChunk[] = [];

    // 15 字符无标点，超过阈值 10
    buffer.push("一二三四五六七八九十一二三四五", (c) => chunks.push(c));

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // 切分后 buffer 中剩余字符应少于阈值
    expect(buffer.pendingLength).toBeLessThan(10);
  });

  it("中英文标点均可触发切分", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];

    buffer.push("Hello, world! How are you? I'm fine.", (c) => chunks.push(c));

    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("换行符触发切分", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];
    buffer.push("第一行\n第二行\n", (c) => chunks.push(c));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe("第一行\n");
    expect(chunks[1]!.text).toBe("第二行\n");
  });

  it("setEmotion() 更新后续 chunk 的情绪", () => {
    const buffer = createBuffer();
    const chunks: MessageChunk[] = [];

    buffer.push("开心的话。", (c) => chunks.push(c));
    buffer.setEmotion("happy");
    buffer.push("更开心的话。", (c) => chunks.push(c));

    expect(chunks[0]!.emotion).toBe("neutral");
    expect(chunks[1]!.emotion).toBe("happy");
  });

  it("pendingLength 返回当前未切分 buffer 长度", () => {
    const buffer = createBuffer();
    buffer.push("无标点文本", () => {}); // 5 个中文字符

    expect(buffer.pendingLength).toBe(5);
  });
});
