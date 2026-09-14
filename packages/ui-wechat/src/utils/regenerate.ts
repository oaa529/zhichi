/**
 * @file regenerate.ts
 * 「重新生成」与「编辑重发」的轮次定位（纯函数，可单测）。
 *
 * 引擎把一次回复拆成多条气泡，所以"重新生成"要撤掉的是**整轮**，
 * 而不只是最后一条；同时还得找回当初触发这一轮的那句用户消息，
 * 才能原样重发一次。
 *
 * 编辑重发则是反过来的方向：改掉自己刚说的那句，把它之后的回复一并撤回。
 */

import type { IMessageQuote } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";

/** 一次可重新生成的 AI 回复轮次。 */
export interface IRegenerateTarget {
  /** 这一轮 AI 回复的第一条消息 ID（从这里开始截断）。 */
  readonly fromMessageId: string;
  /** 当初触发这一轮回复的用户消息文本。 */
  readonly userText: string;
  /** 原消息带引用时一并带回：重发不能让引用凭空消失。 */
  readonly quote?: IMessageQuote;
}

/** 取出用户消息里可用于重发的文本（文本优先，贴图用它的内联文案）。 */
function userTextOf(runtime: IMessageRuntime): string | null {
  const message = runtime.message;
  if (message.type === "text") return message.text.trim() || null;
  if (message.type === "sticker") return message.fallbackText.trim() || null;
  if (message.type === "voice") return message.transcript?.trim() || null;
  return null;
}

/** 一条可编辑重发的用户消息。 */
export interface IEditableUserMessage {
  readonly messageId: string;
  readonly text: string;
  /** 这条消息带引用时一并带回（编辑重发时引用仍然有效）。 */
  readonly quote?: IMessageQuote;
}

/**
 * 找出可以「编辑后重发」的那条消息——会话里**最后一条用户消息**。
 *
 * 只允许改最后一条：改中间某条会让它之后的所有对话失去前提，
 * 与其留下自相矛盾的上下文，不如让用户重新生成最后那一轮。
 * 编辑时会连带撤回这条之后的全部内容（含 AI 回复），再按新文本重发。
 *
 * @param messages 当前会话消息（显示顺序，末尾最新）
 */
export function findLastEditableUserMessage(
  messages: ReadonlyArray<IMessageRuntime>,
): IEditableUserMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || candidate.message.senderId !== "user") continue;
    // 末尾往前遇到的第一条用户消息就是"最后一条"
    const text = userTextOf(candidate);
    return text
      ? {
          messageId: candidate.message.id,
          text,
          ...(candidate.message.quote ? { quote: candidate.message.quote } : {}),
        }
      : null;
  }
  return null;
}

/**
 * 找出最后一条 AI 回复所属的轮次。
 *
 * 规则：
 * 1. 末尾必须是该角色发的消息（否则没有可重新生成的回复）；
 * 2. 往前吃掉连续的同角色消息——它们属于同一次生成；
 * 3. 紧邻这一轮之前的必须是一条用户消息（时间分割线之类的系统消息可以跳过）。
 *    如果前面还是角色消息，说明这一轮是**角色主动发的**，压根没有"重发内容"，
 *    这时返回 null——否则会拿更早那句不相干的用户消息去重发，答非所问。
 * 4. 用户消息是图片这种没有文本的，也返回 null，让用户自己重打。
 *
 * @param messages 当前会话消息（显示顺序，末尾最新）
 * @param characterId 角色 ID
 */
export function findLastReplyTurn(
  messages: ReadonlyArray<IMessageRuntime>,
  characterId: string,
): IRegenerateTarget | null {
  if (messages.length === 0) return null;

  const last = messages[messages.length - 1];
  if (!last || last.message.senderId !== characterId) return null;

  let start = messages.length - 1;
  while (start > 0 && messages[start - 1]?.message.senderId === characterId) {
    start -= 1;
  }
  const first = messages[start];
  if (!first) return null;

  // 跳过系统/撤回这类"噪声"消息，找到紧邻这一轮的那条消息
  let index = start - 1;
  while (index >= 0) {
    const type = messages[index]?.message.type;
    if (type === "system" || type === "recall") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) return null;

  const candidate = messages[index];
  if (!candidate || candidate.message.senderId !== "user") return null;

  const text = userTextOf(candidate);
  const quote = candidate.message.quote;
  if (text) {
    return {
      fromMessageId: first.message.id,
      userText: text,
      ...(quote ? { quote } : {}),
    };
  }
  // 用户消息是语音且有转写时可以重发；图片这类没有文本的直接放弃
  if (
    candidate.message.type === "voice" &&
    candidate.message.transcript?.trim()
  ) {
    return {
      fromMessageId: first.message.id,
      userText: candidate.message.transcript.trim(),
      ...(quote ? { quote } : {}),
    };
  }
  return null;
}
