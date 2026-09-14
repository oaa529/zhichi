/**
 * @file ProactivePrompt.ts
 * 「实时 AI 主动消息」的提示词构造（纯函数，可单测）。
 *
 * 旧实现只有一句通用指令："现在是个自然时机，主动发一条消息"。
 * 结果每次都像群发问候——因为模型压根不知道现在几点、上次聊到哪、
 * 有什么没聊完的事。这里把这些上下文喂进去，并把"别老问候"写成硬要求。
 *
 * 另外顺带修了一个隐性 bug：记忆检索的 query 用的一直是这句指令文本本身
 * （没有任何关键词），等于没检索。调用方应改用 `buildProactiveQuery`
 * 拿"最近对话 + 未解线索"去做检索。
 *
 * 时间相关的换算统一走 `time/Clock`：这里的"现在几点""隔了多久"过去各有
 * 一份实现，而 Clock 那份还要管作息判定与 Prompt 注入——两份实现迟早会
 * 对同一个时刻给出不同答案（跨时区角色尤其明显）。
 */

import { formatDuration, wallClockInZone } from "../time/Clock";

/** 构造主动消息提示词所需的上下文。 */
export interface IProactivePromptInput {
  /** 角色显示名（用于告诉模型"以谁的身份说话"）。 */
  readonly characterName: string;
  /** 当前时间（ms，测试可注入）。 */
  readonly now: number;
  /** 上一条消息的时间戳；0 表示还没聊过。 */
  readonly lastMessageAt: number;
  /** 最近几条对话文本（时间正序，最后一条最新）。 */
  readonly recentTexts: ReadonlyArray<string>;
  /** 未解线索（剧情状态卡里的 openThreads）。 */
  readonly openThreads?: ReadonlyArray<string>;
  /** 剧情概要（可选，用于让主动消息贴合当前剧情）。 */
  readonly synopsis?: string;
  /** 角色所在时区（IANA）；缺省或非法时按宿主本地时间。 */
  readonly timeZone?: string | null;
  /**
   * 角色最近说过的话（`collectRecentSaid` 的输出）。
   *
   * 主动消息最容易变成"复读机"——每次都是同一句问候。原来这里只有一句
   * 空泛的"不要重复你最近说过的话"，模型不知道"最近"具体说了什么；
   * 把清单列出来才真的管用。
   */
  readonly recentSaid?: ReadonlyArray<string>;
}

/**
 * 把一天切成 6 个时段。深夜与清晨的主动消息语气应该完全不同，
 * 这是"拟真"最容易被忽略、又最容易被用户察觉的一环。
 */
export function describeTimeOfDay(
  now: number,
  timeZone?: string | null,
): string {
  const hour = wallClockInZone(now, timeZone).hour;
  if (hour >= 5 && hour < 9) return "早上";
  if (hour >= 9 && hour < 11) return "上午";
  if (hour >= 11 && hour < 13) return "中午";
  if (hour >= 13 && hour < 17) return "下午";
  if (hour >= 17 && hour < 19) return "傍晚";
  if (hour >= 19 && hour < 23) return "晚上";
  return "深夜";
}

/**
 * 描述"距离上次聊天过了多久"，用于决定开场的分寸。
 *
 * 名字从 `describeElapsed` 改过来：那个名字现在属于 `time/Clock`
 * 里更通用的"过了多久"（只吃时长、不带聊天语义），两者别再撞名。
 */
export function describeChatGap(lastMessageAt: number, now: number): string {
  if (!lastMessageAt || lastMessageAt <= 0) return "你们还没聊过";
  const diff = Math.max(0, now - lastMessageAt);
  if (diff < 5 * 60_000) return "刚刚才聊过";
  return `距离上次聊天 ${formatDuration(diff)}`;
}

/** 单条文本截断，避免把整段历史塞进提示词。 */
function clip(text: string, max = 60): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 构造主动消息提示词。
 *
 * 结构：情境（几点、多久没聊）、可参考的上下文（最近对话、未解线索）、
 * 以及硬要求（别只问候、别重复、别提系统提示）。
 */
export function buildProactivePrompt(input: IProactivePromptInput): string {
  const timeOfDay = describeTimeOfDay(input.now, input.timeZone);
  const elapsed = describeChatGap(input.lastMessageAt, input.now);

  const lines: string[] = [
    `（系统提示：以下内容不要向对方提及）`,
    `现在是${timeOfDay}，${elapsed}。`,
  ];

  const recent = input.recentTexts
    .map((text) => clip(text))
    .filter((text) => text.length > 0);
  if (recent.length > 0) {
    lines.push(`最近的对话（由旧到新）：${recent.join(" / ")}`);
  }

  const threads = (input.openThreads ?? [])
    .map((thread) => clip(thread, 30))
    .filter((thread) => thread.length > 0);
  if (threads.length > 0) {
    lines.push(`还没聊完的事：${threads.join("、")}`);
  }

  if (input.synopsis?.trim()) {
    lines.push(`当前剧情：${clip(input.synopsis, 80)}`);
  }

  lines.push(
    `请以${input.characterName}的身份，主动给对方发一条消息：`,
    `1. 优先接上面列出的未解线索，或顺着最近的话题往下说；都没有，就说说你此刻在做什么、想到什么。`,
  );

  const said = input.recentSaid ?? [];
  if (said.length > 0) {
    lines.push(
      `2. 不要用"在吗""干嘛呢""吃了吗"这类空泛问候开场；下面这些是你最近说过的话，**别再说一遍**：`,
      ...said.map((sentence) => `- ${sentence}`),
    );
  } else {
    lines.push(
      `2. 不要用"在吗""干嘛呢""吃了吗"这类空泛问候开场；不要重复你最近说过的话。`,
    );
  }

  lines.push(`3. 口语化，短，1~2 句，符合${timeOfDay}的状态。只输出消息本身。`);

  return lines.join("\n");
}

/**
 * 构造记忆检索用的 query。
 *
 * 主动消息没有"用户输入"，拿提示词本身去检索是检索不到东西的；
 * 真正相关的是最近聊的内容和还没聊完的线索。
 */
export function buildProactiveQuery(
  input: Pick<IProactivePromptInput, "recentTexts" | "openThreads" | "synopsis">,
): string {
  return [
    input.recentTexts.join(" "),
    (input.openThreads ?? []).join(" "),
    input.synopsis ?? "",
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
}
