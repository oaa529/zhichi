/**
 * @file Recall.ts
 * 撤回相关的纯函数。
 *
 * 之前这个能力是"半截链"：消息契约里有 `IRecallMessage`、
 * Store 里有 `case "recall"` 的处理、气泡也会渲染"XX撤回了一条消息"，
 * 但**没有任何地方会发出撤回事件**——只能靠调试入口手工塞一条进去看渲染。
 * 这里把规则（两分钟窗口、提示文案、撤回后的消息形状）抽成共用纯函数，
 * 引擎侧（角色反悔撤回）与 UI 侧（用户撤回自己的消息）用同一套判断。
 */

import type { IMessage, IRecallMessage } from "@wechat-rp/shared-types";

/**
 * 撤回时限：微信是 2 分钟，这里保持一致。
 *
 * 超过这个时间只能"删除"（自己看不见，但对话内容仍在），
 * 项目里的 `deleteMessage` 就是那条路径。
 */
export const RECALL_WINDOW_MS = 120_000;

/** 用户撤回自己发的消息时的提示文案。 */
export const SELF_RECALL_NOTICE = "你撤回了一条消息";

/**
 * 能否撤回这条消息。
 *
 * 微信的规则：**只能撤回自己发的、两分钟内的**消息。
 * 系统提示（时间分割线）与已经是撤回提示的消息自然不可撤回。
 */
export function canRecall(
  message: IMessage,
  now: number = Date.now(),
): boolean {
  if (message.senderId !== "user") return false;
  if (message.type === "system" || message.type === "recall") return false;
  const elapsed = now - message.timestamp;
  // elapsed < 0 说明消息时间戳在未来（时钟回拨/导入数据），当作不可撤回
  return elapsed >= 0 && elapsed <= RECALL_WINDOW_MS;
}

/** 角色撤回自己刚说的话时的提示文案（微信里显示对方昵称）。 */
export function buildRecallNotice(senderName: string): string {
  return `${senderName}撤回了一条消息`;
}

/**
 * 把一条消息转成"撤回提示"。
 *
 * 关键点是**丢掉正文**：撤回之后原文不该继续留在内存与持久化里，
 * 否则刷新一下、翻一下 IndexedDB 还能把撤回去的话捞出来。
 * 只保留定位所需的公共字段（id / 会话 / 时间戳），
 * 让它在列表里的位置、排序、时间分割线都不变。
 */
export function toRecallMessage(
  message: IMessage,
  notice: string,
): IRecallMessage {
  return {
    id: message.id,
    type: "recall",
    senderId: message.senderId,
    recipientId: message.recipientId,
    sessionId: message.sessionId,
    timestamp: message.timestamp,
    chunkSequence: message.chunkSequence,
    emotion: message.emotion,
    targetMessageId: message.id,
    notice,
  };
}
