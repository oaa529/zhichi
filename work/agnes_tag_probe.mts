/**
 * @file agnes_tag_probe.mts
 * 真机探针：模型肯不肯在回复开头打情绪标签、会不会漏到正文里。
 *
 * 背景：关键词推断在 38 条真实语料上只有 68%——"去湖边野餐吧"这类
 * 没有任何情绪词的建议句天生抓不到。让模型自己标情绪更准，
 * 但必须放在**开头**（结尾的话，前面的气泡早就发出去了）。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_tag_probe.mts
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/**
 * 两种候选指令，都要求情绪放在**开头**（结尾的话前面的气泡已经发出去了）。
 *
 * A. 行内标签：`[emotion:happy] 内容`——实测模型常写成 `[happy]`，
 *    还出现过 `[neutral:整句话]` 这种把正文包进括号的写法，剥标签会误删正文。
 * B. 独立首行：第一行只写情绪词——解析只需判断"第一行是否恰好是那 8 个词之一"，
 *    不匹配就完全不动正文，**最坏情况只是没标签，不会吃掉内容**。
 */
const VARIANT_A = [
  "【情绪标记】每条回复的**最开头**先输出一个情绪标签，格式 [emotion:xxx]，",
  "xxx 只能取 neutral / happy / sad / angry / shy / surprised / thinking / sleepy 之一。",
  "标签后面紧接着照常说话；正文里不要再出现任何标签。",
].join("\n");

const VARIANT_B = [
  "【情绪标记】每条回复的**第一行**只写一个情绪词，然后换行，从第二行开始才是你要说的话。",
  "情绪词只能取这 8 个之一：neutral、happy、sad、angry、shy、surprised、thinking、sleepy。",
  "第一行除了这个情绪词不要写任何别的内容；正文里也不要再出现情绪词标签。",
].join("\n");

const EMOTION_WORDS = new Set([
  "neutral",
  "happy",
  "sad",
  "angry",
  "shy",
  "surprised",
  "thinking",
  "sleepy",
]);

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐",
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

const PROMPTS: ReadonlyArray<string> = [
  "我今天升职了！",
  "我养的猫昨天走了…",
  "周末去哪玩好呢",
  "你是不是偷偷喜欢我呀",
  "已经凌晨两点了，你还不睡？",
  "我把你最喜欢的杯子打碎了，对不起",
  "你猜我刚才在楼下看见谁了",
  "今天加班到现在，累死了",
  "在吗",
  "陪我聊会儿天吧",
];

/** B 变体：首行恰好是情绪词才认（用产品里的同一个解析器）。 */
const extractFirstLineTag = (reply: string) => {
  const { emotion, body } = parseEmotionTagHead(reply);
  return { emotion, body: body.trim() };
};

/** A 变体：匹配行内 `[emotion:xxx]`（对照组）。 */
function extractInlineTag(reply: string): {
  emotion: string | null;
  body: string;
} {
  const match = reply.match(/^\s*\[emotion:\s*([a-zA-Z]+)\s*\]\s*/);
  if (!match) return { emotion: null, body: reply };
  return {
    emotion: (match[1] ?? "").toLowerCase(),
    body: reply.slice(match[0].length),
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

async function runVariant(
  label: string,
  instruction: string,
  extract: (reply: string) => { emotion: string | null; body: string },
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  let compliant = 0;
  let leaked = 0;
  const tagCounts: Record<string, number> = {};

  for (const prompt of PROMPTS) {
    // buildPrompt 现在已经自带情绪标记指令，不需要手工拼
    const base = buildPrompt(profile, [], prompt).messages;
    const head = base[0];
    if (!head) continue;
    const messages: ReadonlyArray<ILLMMessage> =
      instruction === ""
        ? base
        : [{ role: "system", content: `${head.content}\n\n${instruction}` }, ...base.slice(1)];

    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      console.log(`✗ 调用失败：${(error as Error).message}`);
      continue;
    }

    const { emotion, body } = extract(reply);
    const leak = /\[emotion:|\[(happy|sad|angry|shy|surprised|thinking|sleepy)\]/i.test(
      body,
    );
    if (emotion) compliant += 1;
    if (leak) leaked += 1;
    if (emotion) tagCounts[emotion] = (tagCounts[emotion] ?? 0) + 1;

    console.log(
      `${emotion ? "✓" : "✗"} 标签=${(emotion ?? "无").padEnd(9)}${leak ? " [正文有残留!]" : ""}  ` +
        `正文：${body.replace(/\s+/g, " ").slice(0, 44)}`,
    );
  }

  const total = PROMPTS.length;
  console.log(
    `合规 ${compliant}/${total}（${Math.round((compliant / total) * 100)}%），正文残留 ${leaked}/${total}`,
  );
  console.log("标签分布：" + JSON.stringify(tagCounts));
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  // 产品里实际用的是 B（已在 buildPrompt 中内置），这里只跑 B 做真机合规性核对
  await runVariant("B. 独立首行情绪词（产品当前方案）", "", extractFirstLineTag);
}

void main();
