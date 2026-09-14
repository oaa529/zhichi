/**
 * @file types.ts
 * 引擎内部数据结构（不暴露给 UI 层）。
 * 引擎对外只输出 `IRealismEngineOutput`，内部使用更细粒度的 `MessageChunk`。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

/**
 * 语义缓冲区切分出的最小可发送单元。
 * 一个 MessageChunk 最终会被包装为一条 `IMessage` 推送给 UI。
 */
export interface MessageChunk {
  /** chunk 唯一 ID（与最终消息 ID 一致）。 */
  readonly id: string;
  /** chunk 在原 LLM 输出中的起始字符偏移。 */
  readonly sourceOffset: number;
  /** chunk 文本内容（已切分完毕，不再增长）。 */
  readonly text: string;
  /** 该 chunk 在同批次中的序号，从 0 起。 */
  readonly chunkSequence: number;
  /** 该 chunk 对应的情绪快照（由 LLM 输出或 sentiment 推断）。 */
  readonly emotion: CharacterEmotion;
  /** 是否为该批次的最后一个 chunk。 */
  readonly isTerminal: boolean;
}

/**
 * 打字模拟器为单个 chunk 计算出的时序规划。
 */
export interface ITypingPlan {
  /** 该 chunk 距离上一条送达应延迟多少 ms。 */
  readonly preDeliveryDelayMs: number;
  /** chunk 内逐字揭示延迟（ms，长度等于 chunk 文本长度）。 */
  readonly revealDelays: ReadonlyArray<number>;
  /** 是否触发"对方正在输入..."指示器。 */
  readonly triggersTypingIndicator: boolean;
  /** 是否插入错别字。 */
  readonly containsTypo: boolean;
  /** 错别字纠正时间点（ms，从渲染起点计）。 */
  readonly typoCorrectAtMs: number | null;
}

/**
 * 引擎运行上下文。一次 `startStream()` 调用对应一个 RunContext。
 */
export interface IEngineRunContext {
  readonly sessionId: string;
  readonly characterId: string;
  /** 用户消息文本（用于上下文记忆与语义相关性判断）。 */
  readonly userMessage: string;
  /** 流开始时间戳。 */
  readonly startedAt: number;
  /** 单调递增的事件序列号。 */
  sequenceCounter: number;
}
