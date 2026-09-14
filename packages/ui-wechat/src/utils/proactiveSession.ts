/**
 * @file proactiveSession.ts
 * 实时 AI 主动消息的"下一个会话"选择。
 *
 * 此前定时器只服务当前打开的会话：切走之后另一个会话完全静默，
 * 于是"未读红点"永远没有触发源。现在改为跨会话轮转——
 * 每次心跳挑一个"最久没有消息"的会话主动发消息，
 * 非活跃会话由此积累未读，红点与未读数才会出现。
 */

import type { ISession } from "@wechat-rp/shared-types";

/**
 * 挑选下一个该主动发消息的会话：最近一条消息时间最早的优先。
 *
 * 调用方需预先过滤掉「角色正在睡眠」与「引擎正在流式输出」的会话。
 *
 * @param sessions 候选会话（顺序无关）
 * @returns 目标会话；候选为空时返回 null
 */
export function pickNextProactiveSession(
  sessions: ReadonlyArray<ISession>,
): ISession | null {
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => {
    if (a.lastMessageTime !== b.lastMessageTime) {
      return a.lastMessageTime - b.lastMessageTime;
    }
    // 时间戳相同时用创建时间兜底，保证顺序稳定
    return a.createdAt - b.createdAt;
  });
  return sorted[0] ?? null;
}
