/**
 * @file agnes_style_probe.mts
 * 真机 A/B：回复风格指令是否真的改变输出。
 *
 * 关注两点：① 还会不会写"（她抬头看了看窗外）"这类旁白；
 *          ② 回复长度是否符合档位。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_style_probe.mts
 */

import type { ICharacterProfile, IReplyStyle } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 改造前的通用要求（对照组）。 */
const LEGACY_REQUIREMENT =
  "要求：回复自然口语化，符合日常聊天节奏。不要用书面语或长段落。";

function makeProfile(style?: IReplyStyle): ICharacterProfile {
  return {
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
    ...(style ? { replyStyle: style } : {}),
  };
}

const history: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天上班被领导当众说了一顿，有点丧" },
  { role: "assistant", content: "啊…那挺难受的" },
];
const userMessage = "你現在在干嘛";

/** 把风格段换回旧的那句通用要求，模拟改造前的 prompt。 */
function withLegacyRequirement(
  messages: ReadonlyArray<ILLMMessage>,
): ReadonlyArray<ILLMMessage> {
  const [head, ...rest] = messages;
  if (!head) return messages;
  const legacy = head.content.replace(/【回复风格】[\s\S]*$/, LEGACY_REQUIREMENT);
  return [{ role: "system", content: legacy }, ...rest];
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

/** 旁白特征：星号包裹，或整句被全角括号包住。 */
function hasNarration(text: string): boolean {
  return /[*＊][^*＊\n]{2,}[*＊]/.test(text) || /（[^）\n]{3,40}）/.test(text);
}

async function runVariant(
  label: string,
  messages: ReadonlyArray<ILLMMessage>,
  rounds: number,
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  let narration = 0;
  let totalChars = 0;
  for (let i = 1; i <= rounds; i += 1) {
    try {
      const reply = await callAgnes(messages);
      const bad = hasNarration(reply);
      if (bad) narration += 1;
      totalChars += reply.length;
      console.log(
        `  #${i} ${bad ? "有旁白 ✗" : "纯聊天 ✓"} ${reply.length} 字  ` +
          reply.replace(/\s+/g, " ").slice(0, 60),
      );
    } catch (error) {
      console.log(`  #${i} 调用失败: ${(error as Error).message}`);
    }
  }
  console.log(
    `  → 旁白 ${narration}/${rounds}，平均 ${Math.round(totalChars / rounds)} 字`,
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  const rounds = Number(process.env.PROBE_ROUNDS ?? 3);

  const legacyMessages = withLegacyRequirement(
    buildPrompt(makeProfile(), history, userMessage).messages,
  );
  const shortMessages = buildPrompt(
    makeProfile({ length: "short", allowActions: false }),
    history,
    userMessage,
  ).messages;
  const terseMessages = buildPrompt(
    makeProfile({ length: "terse", allowActions: false }),
    history,
    userMessage,
  ).messages;
  const actionMessages = buildPrompt(
    makeProfile({ length: "medium", allowActions: true }),
    history,
    userMessage,
  ).messages;

  await runVariant("A. 旧通用要求（对照）", legacyMessages, rounds);
  await runVariant("B. 简短 + 禁止旁白（新默认）", shortMessages, rounds);
  await runVariant("C. 极简 + 禁止旁白", terseMessages, rounds);
  await runVariant("D. 适中 + 允许旁白", actionMessages, rounds);
}

void main();
