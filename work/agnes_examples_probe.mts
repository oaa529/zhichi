/**
 * @file agnes_examples_probe.mts
 * 真机 A/B：模板里的「示例对话」到底有没有塑形作用。
 *
 * 做法：同一份模板，一份带 speechExamples、一份不带；示例刻意做成
 * **可量化的风格**（每次不超过 10 字、结尾带"~"），然后统计真实回复的
 * 平均字数与"~"出现率——比"感觉更像了"这种判断靠谱。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_examples_probe.mts
 */

import type { ICharacterProfile, IPromptTemplate } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

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
  replyStyle: { length: "medium", allowActions: false },
};

const baseTemplate: IPromptTemplate = {
  id: "tpl-probe",
  name: "探针模板",
  speechTone: "轻快随意",
};

/** 刻意做成可量化的风格：极短 + 结尾波浪号。 */
const exampleTemplate: IPromptTemplate = {
  ...baseTemplate,
  speechExamples: [
    "用户：早啊，吃了吗",
    "角色：吃啦~",
    "用户：今天有课吗",
    "角色：有的~下午两点~",
  ].join("\n"),
};

const PROMPTS: ReadonlyArray<string> = [
  "今天中午吃什么好呢",
  "我刚看完一部电影，还不错",
  "周末想出去玩，你有什么建议",
  "今天天气真好",
  "我有点累",
];

async function callAgnes(messages: ReadonlyArray<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.8, max_tokens: 1024, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function runVariant(label: string, template: IPromptTemplate): Promise<void> {
  console.log(`\n===== ${label} =====`);
  let totalChars = 0;
  let tildeCount = 0;
  let n = 0;
  for (const prompt of PROMPTS) {
    let reply = "";
    try {
      reply = await callAgnes(buildPrompt(profile, [], prompt, undefined, { promptTemplate: template }).messages);
    } catch (error) {
      console.log(`  ✗ 调用失败：${(error as Error).message}`);
      continue;
    }
    // 去掉首行情绪词再统计正文
    const body = reply.replace(/^\s*[A-Za-z]+[.。,，:：!！?？\s]*\n?/, "");
    n += 1;
    totalChars += body.length;
    if (body.includes("~") || body.includes("～")) tildeCount += 1;
    console.log(`  ${body.length} 字${body.includes("~") ? " [带~]" : ""}  ${body.replace(/\s+/g, " ").slice(0, 44)}`);
  }
  console.log(
    `  → 平均 ${n ? Math.round(totalChars / n) : 0} 字；带 ~ 的 ${tildeCount}/${n}`,
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  await runVariant("A. 不带示例对话", baseTemplate);
  await runVariant("B. 带示例对话（极短 + 波浪号）", exampleTemplate);
}

void main();
