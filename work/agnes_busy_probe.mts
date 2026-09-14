/**
 * @file agnes_busy_probe.mts
 * 真机验证：**注入「你现在在忙」能不能让回复变短、带上"待会儿再说"的味道**。
 *
 * 场景：用户抛一个本来值得多聊两句的话题（刚面试完、想吐槽），
 * 对比 A 组（老链路）与 B 组（多一段忙碌状态）的回复。
 *
 * 指标：
 * - 平均字数（忙里偷闲的人不会写小作文）
 * - "待会儿/下课/忙完/晚点/回头"这类措辞的比例
 * - 打印原文供人工过一眼（别变得敷衍到像不想理人）
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_busy_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { IPresenceDecision } from "../packages/core/src/PresenceManager";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 4);
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

const NOW = Date.now();

function message(index: number, senderId: string, text: string): IMessage {
  return {
    id: `m-${index}`,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? profile.id : "user",
    sessionId: "s1",
    text,
    timestamp: NOW - (10 - index) * 60_000,
    chunkSequence: index,
    emotion: "neutral",
    sourceOffset: 0,
  };
}

/** 一段普通闲聊，最后抛出一个值得多聊两句的话题。 */
const HISTORY: ReadonlyArray<IMessage> = [
  message(0, "user", "今天食堂的糖醋排骨还不错"),
  message(1, profile.id, "是嘛，我好久没去食堂了"),
  message(2, "user", "我刚面试完，感觉被问得有点懵"),
];

const USER_MESSAGE = "面试官问了我一堆没准备的问题，我现在越想越难受，想跟你聊聊";

const BUSY_DECISION: IPresenceDecision = {
  isSleeping: false,
  msUntilWake: 0,
  policy: "next-day-queue",
  displayText: "在上课",
  presence: "away",
  isBusy: true,
  busyLabel: "在上课",
};

const ONLINE_DECISION: IPresenceDecision = {
  isSleeping: false,
  msUntilWake: 0,
  policy: "next-day-queue",
  displayText: "在线",
  presence: "online",
  isBusy: false,
  busyLabel: null,
};

const LATER_WORDS = ["待会", "等下", "下课", "忙完", "晚点", "回头", "一会儿", "稍后"];

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

interface IStat {
  rounds: number;
  chars: number;
  later: number;
}

async function runArm(
  label: string,
  decision: IPresenceDecision,
): Promise<IStat> {
  console.log(`\n----- ${label} -----`);
  const stat: IStat = { rounds: 0, chars: 0, later: 0 };
  const messages = buildPrompt(
    profile,
    toLLMHistory(HISTORY),
    USER_MESSAGE,
    decision,
  ).messages;

  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      console.log(`  #${round} 调用失败：${String(error).slice(0, 80)}`);
      continue;
    }
    const { body } = parseEmotionTagHead(reply);
    const hasLater = LATER_WORDS.some((w) => body.includes(w));
    stat.rounds += 1;
    stat.chars += body.length;
    if (hasLater) stat.later += 1;
    console.log(
      `  #${round} 字数=${body.length}${hasLater ? " ⏳提到待会儿" : ""}｜${body.replace(/\s+/g, " ").slice(0, 80)}`,
    );
  }
  console.log(
    `  小结：平均 ${Math.round(stat.chars / Math.max(1, stat.rounds))} 字，提到"待会儿" ${stat.later}/${stat.rounds}`,
  );
  return stat;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const onlyBusy = (process.env.PROBE_ONLY ?? "").trim() === "busy";
  const onlyOnline = (process.env.PROBE_ONLY ?? "").trim() === "online";

  const online = onlyBusy
    ? null
    : await runArm("A 在线（改造前）", ONLINE_DECISION);
  const busy = onlyOnline
    ? null
    : await runArm("B 在上课（改造后）", BUSY_DECISION);

  console.log("\n===== 汇总 =====");
  if (online && busy) {
    console.log(
      `A 在线：平均 ${Math.round(online.chars / Math.max(1, online.rounds))} 字，提到"待会儿" ${online.later}/${online.rounds}`,
    );
    console.log(
      `B 忙碌：平均 ${Math.round(busy.chars / Math.max(1, busy.rounds))} 字，提到"待会儿" ${busy.later}/${busy.rounds}`,
    );
  }
}

await main();
