/**
 * @file Chunker.test.ts
 * Chunker 单元测试：ID 生成、游标、sequence 连续性。
 */

import { describe, it, expect } from "vitest";
import { Chunker } from "../Chunker";
import type { ChunkIdGenerator } from "../Chunker";

describe("Chunker", () => {
  it("next() 返回正确的 MessageChunk 结构", () => {
    const chunker = new Chunker({
      sessionId: "sess-1",
      characterId: "char-1",
    });
    const chunk = chunker.next("你好。", "happy", false);

    expect(chunk.text).toBe("你好。");
    expect(chunk.emotion).toBe("happy");
    expect(chunk.isTerminal).toBe(false);
    expect(chunk.chunkSequence).toBe(0);
    expect(chunk.sourceOffset).toBe(0);
    expect(chunk.id).toBeDefined();
  });

  it("多次 next() sequence 和 sourceOffset 单调递增", () => {
    const chunker = new Chunker({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const c1 = chunker.next("hello，", "neutral", false);
    const c2 = chunker.next("world。", "happy", false);
    const c3 = chunker.next("结束", "neutral", true);

    expect(c1.chunkSequence).toBe(0);
    expect(c2.chunkSequence).toBe(1);
    expect(c3.chunkSequence).toBe(2);

    expect(c1.sourceOffset).toBe(0);
    expect(c2.sourceOffset).toBe(6); // "hello，" 长度
    expect(c3.sourceOffset).toBe(12); // "hello，" + "world。"
  });

  it("count 属性返回已生成 chunk 数", () => {
    const chunker = new Chunker({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    expect(chunker.count).toBe(0);
    chunker.next("a", "neutral", false);
    expect(chunker.count).toBe(1);
    chunker.next("b", "neutral", false);
    chunker.next("c", "neutral", true);
    expect(chunker.count).toBe(3);
  });

  it("reset() 后 sequence 和 sourceOffset 归零", () => {
    const chunker = new Chunker({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    chunker.next("abc", "neutral", false);
    chunker.next("def", "neutral", false);
    expect(chunker.count).toBe(2);

    chunker.reset();
    expect(chunker.count).toBe(0);

    const chunk = chunker.next("xyz", "happy", true);
    expect(chunk.chunkSequence).toBe(0);
    expect(chunk.sourceOffset).toBe(0);
  });

  it("注入 idGenerator 时使用自定义 ID 生成逻辑", () => {
    const customGen: ChunkIdGenerator = (sessionId, sequence) =>
      `${sessionId}-custom-${sequence}`;

    const chunker = new Chunker({
      sessionId: "sess-test",
      characterId: "char-1",
      idGenerator: customGen,
    });

    const c1 = chunker.next("hi", "neutral", false);
    const c2 = chunker.next("there", "neutral", false);

    expect(c1.id).toBe("sess-test-custom-0");
    expect(c2.id).toBe("sess-test-custom-1");
  });

  it("isTerminal 标记正确传递", () => {
    const chunker = new Chunker({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const nonTerminal = chunker.next("中间片段", "neutral", false);
    const terminal = chunker.next("最后片段", "neutral", true);

    expect(nonTerminal.isTerminal).toBe(false);
    expect(terminal.isTerminal).toBe(true);
  });
});
