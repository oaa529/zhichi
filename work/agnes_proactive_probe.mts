/**
 * @file agnes_proactive_probe.mts
 * 真机 A/B：主动消息提示词（旧=一句通用指令 / 新=带时段+未解线索的上下文）。
 *
 * 关注两点：① 会不会接上"还没聊完的事"；② 会不会又是空泛问候。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_proactive_probe.mts
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { buildProactivePrompt } from "../packages/core/src/proactive/ProactivePrompt";
import { findRepeatedSentences } from "../packages/core/src/llm/AntiRepeat";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 改造前的通用指令（对照组）。 */
const LEGACY_PROMPT =
  "（系统：现在是一个自然时机，请以角色身份主动给对方发一条消息。可以是日常问候、分享心情或发起话题。保持人设，不要提及系统提示。）";

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

interface IScenario {
  readonly name: string;
  readonly history: ReadonlyArray<ILLMMessage>;
  readonly recentTexts: ReadonlyArray<string>;
  readonly openThreads: ReadonlyArray<string>;
  readonly synopsis: string;
  /** 判定"接上了线索"的正则。 */
  readonly threadPattern: RegExp;
  /**
   * 角色最近自己说过的话（`collectRecentSaid` 的输出口径）。
   *
   * 主动消息最容易变成复读机——每次都是同一句问候。第九十四轮之后
   * `buildProactivePrompt` 支持带上这份清单，这里顺便量一下它管不管用。
   */
  readonly recentSaid: ReadonlyArray<string>;
}

/**
 * 场景 1：线索就在最近对话里（历史本身带着上下文）。
 * 场景 2：线索只在剧情卡里——最近几条只是闲聊，历史窗口看不到"面试"。
 * 这才是有没有主动推进能力的真正分水岭。
 */
const SCENARIOS: ReadonlyArray<IScenario> = [
  {
    name: "场景1：线索在最近对话里（看海）",
    history: [
      { role: "user", content: "我周末想去海边走走，好久没看海了" },
      { role: "assistant", content: "好啊，那我们去" },
      { role: "user", content: "就是不知道几点出发合适，早上太早起不来" },
      { role: "assistant", content: "那就下午去，正好看日落" },
    ],
    recentTexts: [
      "我周末想去海边走走，好久没看海了",
      "好啊，那我们去",
      "就是不知道几点出发合适，早上太早起不来",
      "那就下午去，正好看日落",
    ],
    openThreads: ["周末去看海", "还没定几点出发"],
    synopsis: "两人约好周末去海边，时间还没定",
    threadPattern: /海|日落|出发|周末|几点/,
    recentSaid: ["那就下午去，正好看日落", "那我提前把车加满油"],
  },
  {
    name: "场景2：线索只在剧情卡里（下周三面试）",
    history: [
      { role: "user", content: "今天天气还不错" },
      { role: "assistant", content: "是啊，难得放晴" },
      { role: "user", content: "嗯，我先去忙了" },
      { role: "assistant", content: "好，忙完记得吃饭" },
    ],
    recentTexts: [
      "今天天气还不错",
      "是啊，难得放晴",
      "嗯，我先去忙了",
      "好，忙完记得吃饭",
    ],
    openThreads: ["用户下周三有一场面试", "简历还没改完"],
    synopsis: "用户正在准备下周三的面试",
    threadPattern: /面试|简历|准备/,
    recentSaid: ["好，忙完记得吃饭", "我这边刚下过雨"],
  },
];

/** 用真实 PromptBuilder 拼请求，只替换"当前用户消息"那一句。 */
function messagesFor(
  scenario: IScenario,
  instruction: string,
): ReadonlyArray<ILLMMessage> {
  return buildPrompt(profile, scenario.history, instruction).messages;
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
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** 是否是空泛问候开场。 */
function isGenericOpener(reply: string): boolean {
  return /^(在吗|在么|干嘛呢|在干嘛|吃了吗|你好呀?[，,。!！]?$)/.test(
    reply.trim(),
  );
}

async function runVariant(
  label: string,
  scenario: IScenario,
  instruction: string,
  rounds: number,
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  const messages = messagesFor(scenario, instruction);
  let picked = 0;
  let generic = 0;
  let repeated = 0;
  let answered = 0;
  for (let i = 1; i <= rounds; i += 1) {
    try {
      const reply = await callAgnes(messages);
      if (!reply.trim()) {
        console.log(`  #${i} ⚠️ 空回复（不计入分母）`);
        continue;
      }
      answered += 1;
      const ok = scenario.threadPattern.test(reply);
      const g = isGenericOpener(reply);
      // 复读：这轮有没有把"自己最近说过的话"再说一遍
      const said = findRepeatedSentences(reply, scenario.recentSaid);
      if (ok) picked += 1;
      if (g) generic += 1;
      if (said.length > 0) repeated += 1;
      console.log(
        `  #${i} ${ok ? "接上话题 ✓" : "没接 ✗"}${g ? " [空泛问候]" : ""}` +
          `${said.length > 0 ? ` [复读《${said[0]}》]` : ""}  ` +
          reply.replace(/\s+/g, " ").slice(0, 70),
      );
    } catch (error) {
      console.log(`  #${i} 调用失败: ${(error as Error).message}`);
    }
  }
  console.log(
    `  → 接上话题 ${picked}/${answered}，空泛问候 ${generic}/${answered}，复读 ${repeated}/${answered}（共 ${rounds} 轮，失败/空回复不计）`,
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  const rounds = Number(process.env.PROBE_ROUNDS ?? 3);
  const now = Number(process.env.PROBE_NOW ?? Date.now());
  const lastMessageAt = now - 3 * 3600_000;

  for (const scenario of SCENARIOS) {
    console.log(`\n########## ${scenario.name} ##########`);
    const newPrompt = buildProactivePrompt({
      characterName: "苏晚晴",
      now,
      lastMessageAt,
      recentTexts: scenario.recentTexts,
      openThreads: scenario.openThreads,
      synopsis: scenario.synopsis,
      recentSaid: scenario.recentSaid,
    });
    await runVariant("A. 旧的通用指令", scenario, LEGACY_PROMPT, rounds);
    await runVariant("B. 新的上下文提示词", scenario, newPrompt, rounds);
  }
}

void main();
