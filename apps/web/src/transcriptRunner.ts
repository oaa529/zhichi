/**
 * @file transcriptRunner.ts
 * 导出单个会话为 Markdown 聊天记录。
 *
 * 纯逻辑（消息 → Markdown）在 core 的 TranscriptExport.ts；
 * 这里负责从正确的数据源取消息、拼文件名、触发下载。
 */

import type { IMessage } from "@wechat-rp/shared-types";
import { buildTranscript } from "@wechat-rp/core";
import { useChatStore, useSessionStore } from "@wechat-rp/ui-wechat";
import { downloadTextFile, sanitizeFileName } from "./download";

/** 导出结果（界面据此提示）。 */
export interface ITranscriptResult {
  readonly ok: boolean;
  readonly message: string;
}

/** 文件名里的日期（YYYYMMDD）。 */
function stamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * 导出某个会话的聊天记录。
 *
 * 消息来源分两种（与全应用一致）：活跃会话在 chatStore，
 * 其他会话在自己的运行时快照里。
 */
export function exportSessionTranscript(
  sessionId: string,
  now: number = Date.now(),
): ITranscriptResult {
  const state = useSessionStore.getState();
  const session = state.sessions[sessionId];
  if (!session) return { ok: false, message: "找不到这个会话。" };

  const characterId = session.participantIds.find((id) => id !== "user");
  const character = characterId ? state.characters[characterId] : undefined;
  const name = character?.displayName ?? session.displayName;

  const messages: ReadonlyArray<IMessage> =
    state.activeSessionId === sessionId
      ? useChatStore.getState().messages.map((runtime) => runtime.message)
      : ((state.sessionRuntimes[sessionId]?.messages ?? []) as ReadonlyArray<{
          message: IMessage;
        }>).map((runtime) => runtime.message);

  if (messages.length === 0) {
    return { ok: false, message: `与「${name}」的会话还没有消息。` };
  }

  try {
    // 用用户自己的称呼署名（设置里"关于你"填了就用它），否则退回"我"
    const userName = state.userProfile.displayName.trim() || "我";
    const text = buildTranscript(messages, {
      characterName: name,
      userName,
      now,
    });
    downloadTextFile(
      text,
      `zhichi-chat-${sanitizeFileName(name)}-${stamp(now)}.md`,
    );
  } catch (error) {
    console.warn("[transcript] 导出失败：", error);
    return { ok: false, message: "导出失败，请检查浏览器是否拦截了下载。" };
  }

  return {
    ok: true,
    message: `已导出与「${name}」的聊天记录（${messages.length} 条消息）`,
  };
}
