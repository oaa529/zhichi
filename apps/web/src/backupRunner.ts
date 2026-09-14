/**
 * @file backupRunner.ts
 * 数据备份的组装层。
 *
 * 职责划分：
 * - core/backup/BackupFile.ts —— 纯函数：构造 / 解析 / 合并
 * - 本文件 —— 读写 store 快照、触发文件下载、把合并结果落库
 *
 * 安全：导出内容**不含 API Key**（它只驻留内存，从不落盘）。
 */

import type {
  BackupParseError,
  IBackupCounts,
  IBackupFile,
  IBackupPayload,
} from "@wechat-rp/shared-types";
import {
  buildBackup,
  mergeBackup,
  parseBackup,
  serializeBackup,
} from "@wechat-rp/core";
import { useChatStore, useSessionStore } from "@wechat-rp/ui-wechat";
import type { IMessageRuntime } from "@wechat-rp/ui-wechat";
import { downloadTextFile } from "./download";

/** 导入结果（用于界面提示）。 */
export interface IImportResult {
  readonly ok: boolean;
  readonly message: string;
  readonly counts?: IBackupCounts;
}

/** 解析失败原因 → 给用户看的中文提示。 */
const PARSE_ERROR_MESSAGES: Record<BackupParseError, string> = {
  empty: "文件是空的，没有可导入的内容。",
  "not-json": "这个文件不是合法的 JSON，可能已损坏。",
  "not-backup": "这不是「咫尺」导出的备份文件。",
  "version-too-new": "备份文件来自更新版本的应用，当前版本读不了。",
  "bad-payload": "备份文件缺少数据段，无法导入。",
};

/** 读取当前 store 的持久化快照（严格不含 apiKey）。 */
export function readLocalSnapshot(): IBackupPayload {
  const state = useSessionStore.getState();
  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    sessionRuntimes: state.sessionRuntimes,
    drafts: state.drafts,
    contacts: state.contacts,
    characters: state.characters,
    promptTemplates: state.promptTemplates,
    apiConfig: state.apiConfig,
    realtimeAIConfig: state.realtimeAIConfig,
    memories: state.memories,
    loreEntries: state.loreEntries,
    plotStates: state.plotStates,
    digestCursors: state.digestCursors,
    digestConfig: state.digestConfig,
    // 「关于你」是用户自己写的内容，必须跟着备份走（早先漏了，导出再导入就没了）
    userProfile: state.userProfile,
    digestReports: state.digestReports,
  };
}

/** 生成带时间戳的文件名（本地时间，方便肉眼排序）。 */
function backupFileName(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `zhichi-backup-${stamp}.json`;
}

/**
 * 读取当前 store 并构造备份对象（导出路径的唯一入口）。
 */
function currentBackup(now: number): IBackupFile {
  return buildBackup(readLocalSnapshot(), now);
}

/**
 * 生成备份 JSON 文本（不触发下载）。
 * DEV 调试入口与控制台手工备份使用。
 */
export function buildBackupText(now: number = Date.now()): string {
  return serializeBackup(currentBackup(now));
}

/**
 * 导出全部数据为 JSON 文件并触发浏览器下载。
 *
 * @returns 本次导出的统计信息（用于界面回执）
 */
export function exportBackupToFile(now: number = Date.now()): IBackupCounts {
  const file = currentBackup(now);
  downloadTextFile(serializeBackup(file), backupFileName(now));
  return file.counts;
}

/**
 * 归一化导入的消息：清掉"未揭示 / 占位中"的运行时状态。
 *
 * 备份里可能存着上次流式中断时的半成品消息（pending 或未揭示），
 * 原样恢复会让气泡永远停在半个或触发一次假的打字动画。
 */
function freezeMessages(
  messages: ReadonlyArray<unknown>,
): ReadonlyArray<IMessageRuntime> {
  const result: IMessageRuntime[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = (item as { message?: unknown }).message;
    if (!message) continue;
    result.push({
      message: message as IMessageRuntime["message"],
      revealed: true,
      pending: false,
    });
  }
  return result;
}

/** 把合并后的快照写回两个 store，并让界面停在可用的会话上。 */
function applySnapshot(snapshot: IBackupPayload): void {
  // 正在生成的回复先停掉，避免它继续往刚恢复的消息流里写
  useChatStore.getState().abortStream();

  // 注意：这里同时改了 sessionStore.activeSessionId 和 chatStore.messages，
  // 而 App 的"切换会话" effect 会在 activeSessionId 变化时把 chatStore 当前
  // 消息回写到**上一个**会话的运行时快照。二者若指向不同会话就会写串。
  // 之所以安全，是因为 mergeBackup 保证：本地活跃会话只要仍然存在就继续用它，
  // 只有在本地没有活跃会话时才改用备份指定的那个——那时 App 的 prevId 为空，
  // 不会触发回写。改动 mergeBackup 的这条规则时必须同步检查这里。

  // 所有会话的消息都统一"冻结"为已完成态
  const runtimes: IBackupPayload["sessionRuntimes"] = {};
  const frozenMessages: Record<string, ReadonlyArray<IMessageRuntime>> = {};
  for (const [sessionId, runtime] of Object.entries(snapshot.sessionRuntimes)) {
    const messages = freezeMessages(runtime.messages ?? []);
    frozenMessages[sessionId] = messages;
    runtimes[sessionId] = {
      ...runtime,
      messages,
    };
  }

  useSessionStore.setState({
    sessions: snapshot.sessions,
    activeSessionId: snapshot.activeSessionId,
    sessionRuntimes: runtimes,
    drafts: snapshot.drafts,
    contacts: snapshot.contacts,
    characters: snapshot.characters,
    promptTemplates: snapshot.promptTemplates,
    apiConfig: snapshot.apiConfig,
    realtimeAIConfig: snapshot.realtimeAIConfig,
    memories: snapshot.memories,
    plotStates: snapshot.plotStates,
    digestCursors: snapshot.digestCursors,
    digestConfig: snapshot.digestConfig,
    loreEntries: snapshot.loreEntries ?? {},
    // 老备份文件里没有这两项：用 ?? 兜底，别把本地已有的覆盖成 undefined
    userProfile: snapshot.userProfile ?? useSessionStore.getState().userProfile,
    digestReports:
      snapshot.digestReports ?? useSessionStore.getState().digestReports,
  });

  // 活跃会话的消息直接灌进 chatStore（它才是聊天视图的数据源）
  const activeId = snapshot.activeSessionId;
  const activeRuntime = activeId ? runtimes[activeId] : undefined;
  useChatStore.setState({
    messages: activeId ? frozenMessages[activeId] ?? [] : [],
    phase: "idle",
    presence: "online",
    presenceText: activeRuntime?.presenceText ?? "",
    typingIndicator: { active: false, estimatedRemainingMs: 0 },
    pendingCount: 0,
    queuedUserTexts: [],
    lastError: null,
  });
}

/**
 * 从用户选择的文件导入并合并（不删除任何本地数据）。
 *
 * 任何失败都只返回提示文本，不抛异常（界面据此显示红字）。
 */
export async function importBackupFromFile(file: File): Promise<IImportResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: "读取文件失败，请重试。" };
  }

  const parsed = parseBackup(text);
  if (!parsed.ok) {
    return { ok: false, message: PARSE_ERROR_MESSAGES[parsed.error] };
  }

  try {
    const merged = mergeBackup(readLocalSnapshot(), parsed.file.data);
    applySnapshot(merged);
    return {
      ok: true,
      message:
        `导入完成：${parsed.file.counts.sessions} 个会话 / ` +
        `${parsed.file.counts.messages} 条消息 / ` +
        `${parsed.file.counts.memories} 条记忆（已与本地数据合并）`,
      counts: parsed.file.counts,
    };
  } catch (error) {
    console.warn("[backup] 导入失败：", error);
    return { ok: false, message: "导入过程中出错，本地数据未被修改。" };
  }
}
