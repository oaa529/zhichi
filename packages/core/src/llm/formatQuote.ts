/**
 * @file formatQuote.ts
 * 「引用回复」的文本化工具。
 *
 * 引用对模型的价值是**锚定**：长对话里"你刚才说的那句"指的是哪句，
 * 只有把被引用的内容一起送进去，模型才不会答非所问。所以引用既有
 * 渲染用的摘要（IMessageQuote），也有这里给 Prompt 用的合成文本。
 *
 * 纯函数，无副作用。
 */

import type { IMessageQuote } from "@wechat-rp/shared-types";

/** 引用摘要的最大长度（超出截断，避免引用块拖垮 Prompt 预算）。 */
export const QUOTE_PREVIEW_MAX_CHARS = 80;

/**
 * 从消息正文生成引用摘要：压平换行、去掉多余空白、超长截断。
 */
export function buildQuotePreview(
  text: string,
  maxChars: number = QUOTE_PREVIEW_MAX_CHARS,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * 把引用信息与正文合成模型可读的一段文本。
 *
 * 格式经过真机对照（3 轮/组，见 work/agnes_quote_format_probe.mts）：
 * - `（引用 苏晚晴：「…」）`        2/3 命中，1/3 被模型当成"别人说的话"而否认
 * - `（引用苏晚晴说过的话：「…」）`  1/3 命中
 * - `（引用我（苏晚晴）之前说过的话…）` 3/3 命中，但只适用于"引用角色自己的话"
 * - `（引用消息 · 苏晚晴：「…」）`    3/3 命中，且对"引用用户自己的话"同样成立 ← 采用
 *
 * 输出示例：
 * ```
 * （引用消息 · 苏晚晴：「你今天怎么没来上课？」）
 * 我睡过头了……
 * ```
 */
export function formatQuotedText(text: string, quote: IMessageQuote): string {
  return `（引用消息 · ${quote.senderName}：「${quote.preview}」）\n${text}`;
}
