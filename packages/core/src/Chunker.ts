/**
 * @file Chunker.ts
 * Chunk 生成器：将已切分完成的文本片段包装为 MessageChunk。
 * 职责单一：只做包装，不做切分（切分由 SemanticBuffer 负责）。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

import type { MessageChunk } from "./types";

/**
 * 生成 chunk 唯一 ID 的策略。默认实现使用 `crypto.randomUUID()`，
 * 测试时可注入伪随机实现以保证可复现性。
 */
export type ChunkIdGenerator = (sessionId: string, sequence: number) => string;

const defaultIdGen: ChunkIdGenerator = (sessionId, sequence) => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Node < 19 或非安全上下文回退
  return `${sessionId}-chunk-${sequence}-${Date.now()}`;
};

export interface IChunkerOptions {
  readonly sessionId: string;
  readonly characterId: string;
  /** chunk ID 生成器（测试可注入）。 */
  readonly idGenerator?: ChunkIdGenerator;
}

export class Chunker {
  private readonly idGen: ChunkIdGenerator;
  private sequence = 0;
  private sourceCursor = 0;

  constructor(private readonly opts: IChunkerOptions) {
    this.idGen = opts.idGenerator ?? defaultIdGen;
  }

  /**
   * 包装一个文本片段为 MessageChunk。
   *
   * @param segment 已切分完毕的文本
   * @param emotion 情绪快照
   * @param isTerminal 是否为流末尾
   */
  public next(
    segment: string,
    emotion: CharacterEmotion,
    isTerminal: boolean,
  ): MessageChunk {
    const chunk: MessageChunk = {
      id: this.idGen(this.opts.sessionId, this.sequence),
      sourceOffset: this.sourceCursor,
      text: segment,
      chunkSequence: this.sequence,
      emotion,
      isTerminal,
    };
    this.sourceCursor += segment.length;
    this.sequence += 1;
    return chunk;
  }

  /** 重置游标，供下一次流使用。 */
  public reset(): void {
    this.sequence = 0;
    this.sourceCursor = 0;
  }

  /** 已生成 chunk 数量。 */
  public get count(): number {
    return this.sequence;
  }
}
