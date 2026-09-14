/**
 * @file TranscriptExport.ts
 * 把单个会话导出成**给人读**的 Markdown 聊天记录。
 *
 * 与「数据备份」的分工：
 * - 备份是 JSON，给机器恢复用（含全部字段，不可读）；
 * - 这个导出是给人看的：存档、回顾、发给朋友都能直接读。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { IMessage } from "@wechat-rp/shared-types";

export interface ITranscriptOptions {
  /** 角色显示名（标题用）。 */
  readonly characterName: string;
  /** 用户署名（默认"我"）。 */
  readonly userName?: string;
  /** 导出时间（测试可注入）。 */
  readonly now?: number;
}

/** 补零到两位。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地日期（YYYY/M/D）。 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 本地时间（HH:MM）。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 取一条消息的可读正文；系统消息与撤回提示返回 null（不导出噪声）。
 */
function messageBody(message: IMessage): string | null {
  switch (message.type) {
    case "text":
      return message.text.trim() || null;
    case "sticker":
      return message.fallbackText.trim() || "[贴图]";
    case "voice":
      return message.transcript?.trim() || `[语音 ${Math.round(message.durationSec)} 秒]`;
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
 * 生成 Markdown 聊天记录。
 *
 * 规则：
 * - 只导出有内容的对话（系统消息、撤回提示会跳过）；
 * - 每条消息带署名与时间；
 * - 跨天时插入日期标题；
 * - 带引用的消息把引用单独渲染成 blockquote，便于人读。
 *
 * @param messages 会话消息（任意顺序，内部按时间排序）
 */
export function buildTranscript(
  messages: ReadonlyArray<IMessage>,
  options: ITranscriptOptions,
): string {
  const userName = options.userName?.trim() || "我";
  const now = options.now ?? Date.now();

  const sorted = [...messages]
    .filter((message) => messageBody(message) !== null)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.chunkSequence - b.chunkSequence;
    });

  const lines: string[] = [
    `# 与 ${options.characterName} 的聊天记录`,
    "",
    `> 导出时间：${formatDate(now)} ${formatTime(now)}　·　共 ${sorted.length} 条消息`,
    "",
  ];

  let currentDate = "";
  for (const message of sorted) {
    const date = formatDate(message.timestamp);
    if (date !== currentDate) {
      currentDate = date;
      lines.push(`## ${date}`, "");
    }

    const speaker = message.senderId === "user" ? userName : options.characterName;
    lines.push(`**${speaker}** ${formatTime(message.timestamp)}`, "");

    if (message.quote) {
      // 引用渲染成 blockquote：人读时一眼能看出"这句是回应哪句"
      lines.push(
        `> 引用 ${message.quote.senderName}：${message.quote.preview}`,
        "",
      );
    }

    lines.push(messageBody(message)!, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
