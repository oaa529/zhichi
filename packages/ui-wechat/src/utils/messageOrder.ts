/**
 * @file messageOrder.ts
 * 消息显示顺序计算。
 *
 * 背景：`chunkSequence` 只在**单轮流式回复内**单调递增，
 * 每轮 `Chunker.reset()` 后会从 0 重新开始；用户消息也固定为 0。
 * 因此它不能作为跨轮排序的主键，否则新消息会被排到上一轮的长回复之前。
 *
 * 正确顺序 = 消息时间戳升序；同一时间戳内（极少见）用 chunkSequence 兜底，
 * 排序保持稳定，插入顺序不变。
 */

import type { IMessageRuntime } from "../store/chatStore";

/**
 * 按显示顺序排序消息：timestamp 升序，同刻用 chunkSequence 兜底。
 *
 * @param messages 会话消息运行时数组
 * @returns 新数组（不修改入参）
 */
export function sortMessagesForDisplay(
  messages: ReadonlyArray<IMessageRuntime>,
): ReadonlyArray<IMessageRuntime> {
  return [...messages].sort(
    (a, b) =>
      a.message.timestamp - b.message.timestamp ||
      a.message.chunkSequence - b.message.chunkSequence,
  );
}
