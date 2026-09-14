/**
 * @file agnes_supersede_probe.mts
 * 真机验证：**改口之后，旧记忆会不会被取代**。
 *
 * 场景（很常见的一种翻车）：
 * 1. 第一次整理：用户说"我不吃辣，闻到辣椒就难受" → 记忆里留下一条；
 * 2. 过一阵子用户改口："最近胃养好了，能吃一点辣了" → 第二次整理；
 * 3. 问"我现在能吃辣吗？"
 *
 * 如果旧条目没被取代，两条会**并存**：检索可能只捞到旧的那条，
 * 角色就会纠正你——"你不是不吃辣吗"。这比"忘了"更让人出戏。
 *
 * 检查三段：
 * - 提炼：第二次整理的草稿里有没有填 `supersedes`；
 * - 记忆库：合并后旧条目是被改写还是与新的并存；
 * - 回答：问"现在能吃辣吗"，答的是最新状态还是旧状态。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_supersede_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMemory } from "@wechat-rp/shared-types";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import { runDigest, mergeMemories } from "../packages/core/src/memory/MemoryDigest";
import { retrieveMemories } from "../packages/core/src/memory/MemoryRetriever";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐，比用户大两岁，话不多但很细心",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: false,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.5,
    hesitationProbability: 0,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

const NOW = Date.UTC(2026, 8, 13, 12, 41);

/** 第一次整理用的语料：用户明确说不能吃辣。 */
const ROUND_1: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天食堂的菜都放辣椒了，我只能挑着吃" },
  { role: "assistant", content: "你不是一点辣都吃不了吗" },
  { role: "user", content: "对，我不吃辣，闻到辣椒就难受，胃也不好" },
  { role: "assistant", content: "那以后点菜都给你说不要辣" },
  { role: "user", content: "中午还喝了杯冰美式，下午心跳有点快" },
  { role: "assistant", content: "少喝点咖啡吧" },
];

/** 第二次整理用的语料：用户改口了。 */
const ROUND_2: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "最近调理得不错，胃养好了" },
  { role: "assistant", content: "那挺好的" },
  {
    role: "user",
    content: "我现在能吃一点辣了，微辣还行，太辣还是受不了",
  },
  { role: "assistant", content: "那慢慢来，别一下子吃太猛" },
  { role: "user", content: "嗯，今天还试了麻辣烫，微辣正好" },
];

function makeAdapter(): ReturnType<typeof createOpenAIAdapter> {
  return createOpenAIAdapter({
    config: {
      adapter: "openai",
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 180_000,
      maxRetries: 1,
      temperature: 0.8,
      maxTokens: 400,
    },
  });
}

async function askModel(messages: ReadonlyArray<ILLMMessage>): Promise<string> {
  const adapter = makeAdapter();
  return new Promise<string>((resolve) => {
    adapter.stream(
      { messages, model: MODEL, maxTokens: 300, temperature: 0.8 },
      {
        onDelta: () => {},
        onComplete: (fullText) => resolve(fullText),
        onError: () => resolve(""),
      },
      new AbortController().signal,
    );
  });
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(`模型=${MODEL}｜改口：旧记忆该被取代，而不是并存`);

  // ---------- 第一次整理 ----------
  console.log("\n===== 第一次整理（用户：我不吃辣）=====");
  const first = await runDigest({
    adapter: makeAdapter(),
    history: ROUND_1,
    characterName: profile.displayName,
    characterId: profile.id,
    userName: "用户",
    existingMemories: [],
    model: MODEL,
    maxTokens: 1200,
    timeoutMs: 180_000,
    onFailure: (reason) => console.log(`  ⚠️ 整理失败：${reason}`),
  });
  if (!first) {
    console.log("第一次整理没结果，结束。");
    return;
  }
  const memories1: ReadonlyArray<IMemory> = mergeMemories({
    characterId: profile.id,
    existing: [],
    drafts: first.memories,
    sourceMessageIds: ROUND_1.map((_, index) => `r1-${index}`),
    now: NOW,
  });
  for (const memory of memories1) {
    console.log(`  · ${memory.content}｜关键词：${memory.keywords.join("/")}`);
  }
  const spicyBefore = memories1.filter((memory) => /辣/.test(memory.content));
  console.log(`含"辣"的记忆 ${spicyBefore.length} 条`);

  // ---------- 第二次整理（带上已知记忆，和产品一样） ----------
  console.log("\n===== 第二次整理（用户改口：能吃一点辣了）=====");
  const second = await runDigest({
    adapter: makeAdapter(),
    history: ROUND_2,
    characterName: profile.displayName,
    characterId: profile.id,
    userName: "用户",
    existingMemories: memories1.map((memory) => memory.content),
    model: MODEL,
    maxTokens: 1200,
    timeoutMs: 180_000,
    onFailure: (reason) => console.log(`  ⚠️ 整理失败：${reason}`),
  });
  if (!second) {
    console.log("第二次整理没结果，结束。");
    return;
  }
  console.log(`草稿 ${second.memories.length} 条：`);
  for (const draft of second.memories) {
    console.log(
      `  · [${draft.kind}] ${draft.content}` +
        `${draft.supersedes ? `｜supersedes=「${draft.supersedes}」` : "｜⚠️ 没填 supersedes"}`,
    );
  }
  const filledSupersedes = second.memories.filter((draft) =>
    Boolean(draft.supersedes),
  ).length;

  // ---------- 合并后的记忆库 ----------
  const memories2 = mergeMemories({
    characterId: profile.id,
    existing: memories1,
    drafts: second.memories,
    sourceMessageIds: ROUND_2.map((_, index) => `r2-${index}`),
    now: NOW + 86_400_000,
  });
  console.log("\n===== 合并后的记忆库 =====");
  for (const memory of memories2) {
    console.log(`  · ${memory.content}`);
  }
  const spicyAfter = memories2.filter((memory) => /辣/.test(memory.content));
  const canEatSpicy = spicyAfter.some((memory) =>
    /能吃|微辣|可以吃|开始吃|已经能/.test(memory.content),
  );
  /**
   * 旧状态是否**残留**：只看"完全不能吃辣"这类断言，且排除已包含最新状态的那条。
   *
   * 第一版判定写得太粗：`/不吃|不能吃|受不了/` 会被**新**条目里的
   * "能吃微辣，但太辣还是受不了"命中，于是每轮都误报"新旧并存"。
   */
  const cannotEatSpicy = spicyAfter.some(
    (memory) =>
      /不吃辣|不能吃辣|完全不.*辣|闻到辣椒/.test(memory.content) &&
      !/现在能|已经能|可以吃一点|能吃微辣/.test(memory.content),
  );
  console.log(
    `含"辣"的记忆 ${spicyAfter.length} 条｜最新状态（能吃一点）在库：${canEatSpicy}｜旧状态（不吃）仍在库：${cannotEatSpicy}`,
  );
  if (canEatSpicy && cannotEatSpicy) {
    console.log("  ⚠️ 新旧并存 = 角色可能拿旧状态纠正用户");
  }

  // ---------- 回答问题 ----------
  console.log("\n===== 问「我现在能吃辣吗？」=====");
  const question = "我现在能吃辣吗？";
  const picked = retrieveMemories(question, memories2, {
    now: NOW + 2 * 86_400_000,
    maxItems: 5,
  });
  console.log(`检索到 ${picked.length} 条：${picked.map((m) => m.content).join("｜") || "（空）"}`);
  const messages = buildPrompt(profile, [], question, undefined, {
    memories: picked,
  }).messages;
  const raw = await askModel(messages);
  const body = parseEmotionTagHead(raw).body;
  console.log(`回答：${body.replace(/\s+/g, " ").slice(0, 100)}`);
  const saysLatest = /微辣|一点辣|能吃|可以吃/.test(body);
  const saysOld = /你不吃辣|你不是不吃|不能吃辣|吃不了辣/.test(body);
  console.log(
    `→ 说最新状态：${saysLatest ? "是" : "否"}｜拿旧状态纠正用户：${saysOld ? "是（翻车）" : "否"}`,
  );

  console.log("\n===== 汇总 =====");
  console.log(
    `supersedes 草稿 ${filledSupersedes}/${second.memories.length}｜` +
      `新旧并存：${canEatSpicy && cannotEatSpicy ? "是" : "否"}｜` +
      `回答是否用最新状态：${saysLatest && !saysOld ? "是" : "否"}`,
  );
}

await main();
