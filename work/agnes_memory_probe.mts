/**
 * @file agnes_memory_probe.mts
 * 真机验证：记忆注入位置对回复的影响（旧=开头 system / 新=末尾 system）。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_memory_probe.mts
 *
 * 这是一个一次性探针脚本，不参与产品运行时，也不会被测试套件收集。
 */

import type { ICharacterProfile, IMemory } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
/** 默认值与应用设置里的 maxTokens 保持一致，避免测出"假故障"。 */
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 1024);

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐，比用户大两岁，平时话不多但很细心",
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

/** 关键事实：用户对花生过敏。模型只有"记得"这条，才可能提醒。 */
const memory: IMemory = {
  id: "mem-peanut",
  characterId: "char-su-wanqing",
  kind: "fact",
  content: "用户对花生严重过敏，不能吃花生及花生制品",
  keywords: ["花生", "过敏"],
  importance: 5,
  pinned: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sourceMessageIds: [],
};

const history: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天加班到好晚，累死了" },
  { role: "assistant", content: "辛苦啦，早点休息" },
];

const userMessage = "晚上一起吃饭吧，我想吃宫保鸡丁";

/** 新版结构：记忆在末尾 system，紧贴当前提问。 */
function buildTailVariant(withMemory: boolean): ReadonlyArray<ILLMMessage> {
  return buildPrompt(profile, history, userMessage, undefined, {
    memories: withMemory ? [memory] : [],
  }).messages;
}

/** 旧版结构：把动态内容合并回开头那条 system（模拟改造前的行为）。 */
function buildHeadVariant(withMemory: boolean): ReadonlyArray<ILLMMessage> {
  const messages = buildTailVariant(withMemory);
  const systems = messages.filter((m) => m.role === "system");
  const dialog = messages.filter((m) => m.role !== "system");
  const merged = systems.map((m) => m.content).join("\n\n");
  return [{ role: "system", content: merged }, ...dialog];
}

async function callAgnes(messages: ReadonlyArray<ILLMMessage>): Promise<{
  content: string;
  finishReason: string;
  reasoningChars: number;
  promptTokens: number;
}> {
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
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
    usage?: { prompt_tokens?: number };
  };
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content?.trim() ?? "",
    finishReason: choice?.finish_reason ?? "?",
    reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
    promptTokens: data.usage?.prompt_tokens ?? 0,
  };
}

/** 判断回复是否用上了"花生过敏"这条记忆。 */
function mentionsPeanut(reply: string): boolean {
  return /花生|过敏/.test(reply);
}

async function runVariant(
  label: string,
  messages: ReadonlyArray<ILLMMessage>,
  rounds: number,
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  console.log(
    `system 条数=${messages.filter((m) => m.role === "system").length} ` +
      `动态块位置=${messages.map((m) => m.role[0]).join("")}`,
  );
  let hits = 0;
  for (let i = 1; i <= rounds; i += 1) {
    try {
      const result = await callAgnes(messages);
      const reply = result.content;
      const hit = mentionsPeanut(reply);
      if (hit) hits += 1;
      console.log(
        `  #${i} ${hit ? "提到花生/过敏 ✓" : "没提 ✗"} ` +
          `[finish=${result.finishReason} 正文=${reply.length}字 思考=${result.reasoningChars}字 prompt=${result.promptTokens}tok] ` +
          `${reply.replace(/\s+/g, " ").slice(0, 90)}`,
      );
    } catch (error) {
      console.log(`  #${i} 调用失败: ${(error as Error).message}`);
    }
  }
  console.log(`  → 命中 ${hits}/${rounds}`);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY 环境变量");
    process.exit(1);
  }
  const rounds = Number(process.env.PROBE_ROUNDS ?? 3);

  await runVariant("A. 无记忆（对照组）", buildTailVariant(false), rounds);
  await runVariant("B. 记忆注入开头 system（旧位置）", buildHeadVariant(true), rounds);
  await runVariant("C. 记忆注入末尾 system（新位置）", buildTailVariant(true), rounds);
}

void main();
