/**
 * @file agnes_emotion_probe.mts
 * 真机抽样：情绪推断在真实回复上的命中率。
 *
 * 做法：给模型一组"情绪色彩明确"的对话场景，让它按角色回一句，
 * 再用 inferEmotion 推断这句的情绪，与场景期望比对。
 * 关注两个数：
 *   ① 命中率（推断 == 期望）
 *   ② 非 neutral 比例（一直 neutral 的话立绘永远不切换）
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_emotion_probe.mts
 */

import type { CharacterEmotion, ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { inferEmotion } from "../packages/core/src/EmotionInference";
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
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
  replyStyle: { length: "short", allowActions: false },
};

interface IScenario {
  readonly userMessage: string;
  readonly expected: CharacterEmotion;
  readonly note: string;
}

const SCENARIOS: ReadonlyArray<IScenario> = [
  { userMessage: "我今天升职了！", expected: "happy", note: "好消息" },
  { userMessage: "我养的猫昨天走了…", expected: "sad", note: "坏消息" },
  { userMessage: "你怎么又把我托你办的事忘了", expected: "sad", note: "抱怨" },
  { userMessage: "我刚中了个小奖，哈哈", expected: "happy", note: "分享喜悦" },
  { userMessage: "你是不是偷偷喜欢我呀", expected: "shy", note: "打趣" },
  { userMessage: "已经凌晨两点了，你还不睡？", expected: "sleepy", note: "深夜" },
  { userMessage: "周末去哪玩好呢，你有什么想法", expected: "thinking", note: "商量" },
  { userMessage: "我把你最喜欢的杯子打碎了，对不起", expected: "sad", note: "道歉" },
  { userMessage: "你猜我刚才在楼下看见谁了", expected: "surprised", note: "悬念" },
  { userMessage: "今天加班到现在，累死了", expected: "sad", note: "诉苦" },
];

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
      max_tokens: 1024,
      stream: false,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  const rounds = Number(process.env.PROBE_ROUNDS ?? 1);

  let total = 0;
  let hit = 0;
  let nonNeutral = 0;
  const misses: string[] = [];

  for (const scenario of SCENARIOS) {
    const messages = buildPrompt(
      profile,
      [{ role: "user", content: "在吗" }],
      scenario.userMessage,
    ).messages;
    for (let round = 0; round < rounds; round += 1) {
      let reply = "";
      try {
        reply = await callAgnes(messages);
      } catch (error) {
        console.log(`  [${scenario.note}] 调用失败：${(error as Error).message}`);
        continue;
      }
      const inferred = inferEmotion(reply);
      total += 1;
      if (inferred === scenario.expected) hit += 1;
      if (inferred !== "neutral") nonNeutral += 1;
      const mark = inferred === scenario.expected ? "✓" : "✗";
      console.log(
        `${mark} [${scenario.note}] 期望 ${scenario.expected.padEnd(9)} 推断 ${inferred.padEnd(9)}  ${reply.replace(/\s+/g, " ").slice(0, 46)}`,
      );
      if (inferred !== scenario.expected) {
        misses.push(`期望 ${scenario.expected} / 推断 ${inferred}：${reply.replace(/\s+/g, " ").slice(0, 60)}`);
      }
    }
  }

  console.log(
    `\n汇总：命中 ${hit}/${total}（${Math.round((hit / Math.max(1, total)) * 100)}%）；` +
      `非 neutral ${nonNeutral}/${total}（${Math.round((nonNeutral / Math.max(1, total)) * 100)}%）`,
  );
  if (misses.length > 0) {
    console.log("\n未命中明细：");
    for (const m of misses) console.log("  - " + m);
  }
}

void main();
