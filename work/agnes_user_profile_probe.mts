/**
 * @file agnes_user_profile_probe.mts
 * 真机验证：**填了"关于你"之后，角色是否真的知道对方是谁**。
 *
 * 对照：A 不填（老行为，角色只知道对方是抽象的"用户"）；
 * B 填上「小满 / 25 岁，程序员，独居，养了一只叫团团的猫」。
 *
 * 提问：「你还记得我是谁吗？我平时都干什么来着」
 * 判定：回复里有没有出现名字（小满）或背景关键词（程序员/写代码/猫/团团）。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_user_profile_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 300);

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
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

/** 一段普通寒暄（刻意不含任何自我介绍）。 */
const HISTORY: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天忙完了吗" },
  { role: "assistant", content: "刚忙完，你呢" },
  { role: "user", content: "我也刚到家" },
  { role: "assistant", content: "那先歇会儿" },
];

const QUESTION = "你还记得我是谁吗？我平时都干什么来着";

const USER_PROFILE = {
  displayName: "小满",
  bio: "25 岁，程序员，独居，养了一只叫团团的猫",
};

/** 回复里有没有用上"关于你"的信息。 */
function usedProfile(reply: string): { name: boolean; background: boolean } {
  return {
    name: reply.includes("小满"),
    background: ["程序员", "写代码", "加班", "团团", "猫", "独居"].some((w) =>
      reply.includes(w),
    ),
  };
}

async function callAgnes(messages: ReadonlyArray<ILLMMessage>): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function runArm(
  label: string,
  withProfile: boolean,
): Promise<{ nameHits: number; bgHits: number; rounds: number }> {
  console.log(`\n----- ${label} -----`);
  const messages = buildPrompt(profile, HISTORY, QUESTION, undefined, {
    userProfile: withProfile ? USER_PROFILE : null,
  }).messages;

  let nameHits = 0;
  let bgHits = 0;
  let rounds = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      console.log(`  #${round} 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    const { body } = parseEmotionTagHead(reply);
    if (body.trim().length === 0) {
      console.log(`  #${round} ⚠️ 空响应（不计入统计）`);
      continue;
    }
    const used = usedProfile(body);
    rounds += 1;
    if (used.name) nameHits += 1;
    if (used.background) bgHits += 1;
    console.log(
      `  #${round} 名字=${used.name ? "✅" : "—"} 背景=${used.background ? "✅" : "—"}｜${body.replace(/\s+/g, " ").slice(0, 70)}`,
    );
  }
  return { nameHits, bgHits, rounds };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const without = await runArm("A 不填「关于你」（老行为）", false);
  const withIt = await runArm("B 填了「关于你」", true);

  console.log("\n===== 汇总 =====");
  console.log(
    `A 不填：说出名字 ${without.nameHits}/${without.rounds}，提到背景 ${without.bgHits}/${without.rounds}`,
  );
  console.log(
    `B 填了：说出名字 ${withIt.nameHits}/${withIt.rounds}，提到背景 ${withIt.bgHits}/${withIt.rounds}`,
  );
}

await main();
