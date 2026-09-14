/**
 * @file toLLMHistory.ts
 * 会话消息 → LLM 消息历史转换。
 *
 * 规则：
 * - 文本消息取原文
 * - 贴图取 fallbackText（如 "[微笑]"）
 * - 语音取转录文本，无转录时降级为 "[语音 N 秒]"
 * - 图片取 "[图片]"
 * - 系统消息 / 撤回提示不进入历史（对模型无意义）
 * - senderId === "user" 视为 user 角色，其余视为 assistant
 * - 带引用的消息在正文前补一行「（引用 谁：「原话」）」，
 *   模型才能知道"你刚才说的那句"指的是哪句
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { IMessage } from "@wechat-rp/shared-types";
import type { ILLMMessage } from "./types";
import { formatQuotedText } from "./formatQuote";

/** 用户消息的保留 ID。 */
const USER_SENDER_ID = "user";

/**
 * 把单条消息转换为其"可读文本"；没有文本表示的消息（系统/撤回）返回 null。
 *
 * 同时用于两处：喂给模型的历史内容，以及引用回复的摘要文本。
 */
export function getMessagePlainText(message: IMessage): string | null {
  switch (message.type) {
    case "text":
      return message.text.trim() || null;
    case "sticker":
      return message.fallbackText.trim() || "[贴图]";
    case "voice":
      return message.transcript?.trim() || `[语音 ${message.durationSec} 秒]`;
    case "image":
      return "[图片]";
    case "system":
    case "recall":
      return null;
    default:
      return null;
  }
}

/**
 * 将会话消息列表转换为 LLM 消息历史。
 *
 * @param messages 会话消息（任意顺序，内部按 timestamp + chunkSequence 排序）
 * @returns 可直接喂给引擎 `setMessageHistory` 的历史数组
 */
export function toLLMHistory(
  messages: ReadonlyArray<IMessage>,
): ReadonlyArray<ILLMMessage> {
  const sorted = [...messages].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.chunkSequence - b.chunkSequence;
  });

  const history: ILLMMessage[] = [];
  for (const message of sorted) {
    const content = getMessagePlainText(message);
    if (content === null) continue;
    const text = message.quote
      ? formatQuotedText(content, message.quote)
      : content;
    history.push({
      role: message.senderId === USER_SENDER_ID ? "user" : "assistant",
      content: text,
    });
  }
  return history;
}
