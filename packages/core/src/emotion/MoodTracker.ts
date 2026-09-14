/**
 * @file MoodTracker.ts
 * 角色的"心情"——跨轮次的情绪惯性。
 *
 * 由来：每条消息的情绪是**独立**判定的（模型标签 / 关键词），
 * 于是出现一个很出戏的现象：刚吵完架，下一句问"在吗"，角色又乐呵呵地回，
 * 仿佛上一轮没发生过。真人有情绪残留——这就是这里要补的东西。
 *
 * 做法上刻意选"**推导**而不是存储"：心情完全由「最近几条角色消息的情绪 +
 * 时间衰减」算出来，不落库、不需要同步、刷新后天然一致，也不会跟消息列表
 * 对不上。代价是它只能反映"最近聊得怎么样"，而记不住"三天前那次吵架"——
 * 那类长期状态归记忆与剧情管，各司其职。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { CharacterEmotion, IMessage } from "@wechat-rp/shared-types";

/** 只看最近多少条**角色发的**消息。 */
export const MOOD_WINDOW_MESSAGES = 8;

/**
 * 心情的半衰期（真实时间）。
 *
 * 两小时减半：一个下午过去，早上的不快基本就淡了；
 * 但刚发生的事权重接近 1，说话语气会明显带着它。
 */
export const MOOD_HALF_LIFE_MS = 2 * 60 * 60 * 1000;

/**
 * 低于这个强度就不注入 Prompt。
 *
 * 轻微的开心 / 不开心不值得写进 system——既占预算，
 * 又会让模型误以为"必须表现得情绪化"。
 */
export const MOOD_MIN_INTENSITY = 3;

/** 一条消息在"往回数"时的衰减系数（每往回一条权重减半）。 */
const RECENCY_STEP_DECAY = 0.5;

/** 心情状态。 */
export interface IMoodState {
  /** 当前主要情绪。 */
  readonly emotion: CharacterEmotion;
  /** 强度 1~5：越大越"浓"。 */
  readonly intensity: number;
  /** 参与计算的消息条数（调试与展示用）。 */
  readonly sourceCount: number;
}

/** 强度 → 中文程度词（写进 Prompt，也便于界面展示）。 */
const INTENSITY_LABELS: Record<number, string> = {
  1: "几乎察觉不到",
  2: "有一点",
  3: "有些",
  4: "比较明显",
  5: "非常强烈",
};

/** 情绪 → 中文名（Prompt 里说人话，模型更容易顺着写）。 */
const EMOTION_LABELS: Record<CharacterEmotion, string> = {
  neutral: "平静",
  happy: "开心",
  sad: "低落",
  angry: "生气",
  shy: "害羞",
  surprised: "惊讶",
  thinking: "若有所思",
  sleepy: "困倦",
};

/** 情绪的强弱排序（用于强度换算时的加权，负向情绪更"黏"）。 */
const NEGATIVE_EMOTIONS: ReadonlySet<CharacterEmotion> = new Set([
  "sad",
  "angry",
]);

/**
 * 从消息列表推导当前心情。
 *
 * 规则（都好理解、也方便解释给用户）：
 * - 只算**角色自己发的**文本/贴图消息——用户的情绪不是角色的心情；
 * - 越近的消息权重越高（每往回一条减半），再乘一层真实时间衰减；
 * - 得分最高的情绪胜出；`neutral` 也参与计算，于是"说了几句平淡的话"
 *   会把之前的情绪自然稀释掉；
 * - 强度 1~5：一条新鲜的情绪算 3（"有些"），连着两条同向升到 4~5。
 *
 * @returns 没有可用的角色消息时返回 null
 */
export function deriveMood(
  messages: ReadonlyArray<IMessage>,
  now: number = Date.now(),
): IMoodState | null {
  const own = messages
    .filter(
      (message) =>
        message.senderId !== "user" &&
        (message.type === "text" || message.type === "sticker"),
    )
    .slice(-MOOD_WINDOW_MESSAGES);
  if (own.length === 0) return null;

  const scores = new Map<CharacterEmotion, number>();
  let stepsBack = 0;
  // 从最近一条往回累加
  for (let i = own.length - 1; i >= 0; i -= 1) {
    const message = own[i]!;
    const recency = RECENCY_STEP_DECAY ** stepsBack;
    const elapsed = Math.max(0, now - message.timestamp);
    const timeDecay = RECENCY_STEP_DECAY ** (elapsed / MOOD_HALF_LIFE_MS);
    const weight = recency * timeDecay;
    stepsBack += 1;
    if (weight <= 0) continue;
    scores.set(
      message.emotion,
      (scores.get(message.emotion) ?? 0) + weight,
    );
  }

  let winner: CharacterEmotion = "neutral";
  let winnerScore = 0;
  for (const [emotion, score] of scores) {
    if (score > winnerScore) {
      winnerScore = score;
      winner = emotion;
    }
  }
  if (winnerScore <= 0) return null;

  // 强度：权重满 1（一条新鲜消息）算 3；负向情绪稍微"黏"一点
  const weighted = NEGATIVE_EMOTIONS.has(winner)
    ? winnerScore * 1.15
    : winnerScore;
  const intensity = Math.max(
    1,
    Math.min(5, 1 + Math.round(Math.min(weighted, 2) / 2 * 4)),
  );

  return { emotion: winner, intensity, sourceCount: own.length };
}

/** 心情是否值得注入 Prompt（平静 / 太弱的都跳过）。 */
export function shouldInjectMood(mood: IMoodState | null): boolean {
  return (
    mood !== null && mood.emotion !== "neutral" && mood.intensity >= MOOD_MIN_INTENSITY
  );
}

/**
 * 渲染成注入用的 system 段落（无内容返回空串）。
 *
 * 三条要求缺一不可：说清是什么心情、强调"这是累积的不是这一句的反应"、
 * 以及**留出反转的余地**——否则模型会为了维持心情而无视对方刚说的话，
 * 那是另一种出戏。
 */
export function renderMoodStatePrompt(mood: IMoodState | null): string {
  if (!shouldInjectMood(mood) || !mood) return "";
  const label = EMOTION_LABELS[mood.emotion];
  const degree = INTENSITY_LABELS[mood.intensity] ?? "";
  return [
    "【你此刻的心情】",
    `你最近的心情：${label}（${degree}）。`,
    "这是前几轮聊下来累积的状态，不是对这一句的直接反应——回话的语气要顺着它，",
    "不要一开口就恢复成轻快的样子。",
    "当然，如果对方这句话真的让你情绪变了，那就变——那才像真人。",
  ].join("\n");
}

/** 心情对应的情绪（供立绘兜底：文本看不出情绪时用心情）。 */
export function moodEmotionForSprite(
  mood: IMoodState | null,
): CharacterEmotion | null {
  if (!shouldInjectMood(mood) || !mood) return null;
  return mood.emotion;
}
