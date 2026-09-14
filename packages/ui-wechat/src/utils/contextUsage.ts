/**
 * @file contextUsage.ts
 * 上下文占用的展示工具（纯函数，可单测）。
 */

import type { IContextUsage } from "@wechat-rp/shared-types";

/** 明细行：标签 + 字符数。 */
export interface IContextUsageRow {
  readonly label: string;
  readonly chars: number;
}

/**
 * 把 token 数格式化成紧凑文本：1000 以上折算成 k，保留一位小数。
 * 例：820 → "820"，1436 → "1.4k"，12345 → "12.3k"
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  // 10k 以上不再显示小数，避免 "12.3k" 这种精度浪费位置
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/**
 * 构造明细行，**只保留真正有内容的部分**——
 * 没绑模板、没记忆时不该在界面上占一行显示 0。
 */
export function buildUsageRows(usage: IContextUsage): IContextUsageRow[] {
  const rows: IContextUsageRow[] = [
    { label: "角色卡", chars: usage.chars.system },
    { label: "人设模板", chars: usage.chars.template },
    { label: "世界设定", chars: usage.chars.lore ?? 0 },
    { label: "长期记忆", chars: usage.chars.memory },
    { label: "剧情摘要", chars: usage.chars.plot },
    { label: "防复读", chars: usage.chars.antiRepeat ?? 0 },
    { label: "对话历史", chars: usage.chars.history },
  ];
  return rows.filter((row) => row.chars > 0);
}

/** 上下文是否已经"不健康"（发生过裁剪），用于给指示器加警示色。 */
export function isContextTight(usage: IContextUsage | null | undefined): boolean {
  return Boolean(usage?.trimmed);
}
