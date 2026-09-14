/**
 * @file agnes_repeat_probe.mts
 * 真机验证：闲聊里的复读到底有多频繁，【别重复】这段注入有没有用。
 *
 * 场景：连续 6 轮低信息量对话（在吗 / 嗯 / 今天好累 …）。
 * 这是模型最容易开始套公式的场合：上一轮「那你早点休息呀」，
 * 这一轮还是「那你早点休息呀」。
 *
 * A 组（改前）：把末尾那段 【别重复】 整条 system 摘掉。
 * B 组（改后）：正常 buildPrompt。
 *
 * 指标（第 2 轮起统计）：
 * - 复读轮次：这一轮的回复里，有句子跟之前任何一轮说过的句子
 *   相似度 ≥ 0.75（字符 bigram）
 * - 平均字数：防止用短句糊弄刷指标
 * 原始回复全部打印，供人工过一眼。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_repeat_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import {
  findRepeatedSentences,
  splitSentences,
} from "../packages/core/src/llm/AntiRepeat";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 200);

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

/** 低信息量的六轮：问晚安、嗯、抱怨累、再嗯、追问、再问在不在。 */
const USER_TURNS = ["在吗", "嗯", "今天好累啊", "嗯嗯", "还没睡呀", "在吗"];

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

/** A 组用：把【别重复】那条 system 摘掉，还原改前的 Prompt。 */
function stripAntiRepeat(
  messages: ReadonlyArray<ILLMMessage>,
): ReadonlyArray<ILLMMessage> {
  return messages.filter(
    (m) => !(m.role === "system" && m.content.startsWith("【别重复】")),
  );
}

interface IArmStat {
  rounds: number;
  repeated: number;
  chars: number;
}

async function runArm(label: string, withAntiRepeat: boolean): Promise<IArmStat> {
  console.log(`\n===== ${label} =====`);
  const stat: IArmStat = { rounds: 0, repeated: 0, chars: 0 };
  const history: ILLMMessage[] = [];
  /** 之前所有轮次说过的句子，用来判定这一轮是不是又说了 */
  const saidBefore: string[] = [];

  for (let round = 0; round < USER_TURNS.length; round += 1) {
    const userMessage = USER_TURNS[round]!;
    const built = buildPrompt(profile, history, userMessage).messages;
    const messages = withAntiRepeat ? built : stripAntiRepeat(built);
    const hasSection = messages.some(
      (m) => m.role === "system" && m.content.startsWith("【别重复】"),
    );

    let replyBody = "";
    try {
      const raw = await callAgnes(messages);
      replyBody = parseEmotionTagHead(raw).body;
    } catch (error) {
      console.log(`  第 ${round + 1} 轮调用失败：${String(error).slice(0, 90)}`);
      continue;
    }

    if (replyBody.length === 0) {
      console.log(`  第 ${round + 1} 轮 ⚠️空回复（不计入统计）`);
      continue;
    }

    const repeated = findRepeatedSentences(replyBody, saidBefore);
    stat.rounds += 1;
    stat.chars += replyBody.length;
    // 第一轮没有「之前」，复读只可能从第二轮开始
    if (round > 0 && repeated.length > 0) {
      stat.repeated += 1;
      console.log(
        `  第 ${round + 1} 轮 🔁 复读《${repeated[0]}》｜${flat(replyBody)}` +
          `（本轮${hasSection ? "有" : "无"}【别重复】）`,
      );
    } else {
      console.log(
        `  第 ${round + 1} 轮 ✅ 新内容｜${flat(replyBody)}` +
          `（本轮${hasSection ? "有" : "无"}【别重复】）`,
      );
    }

    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: replyBody });
    saidBefore.push(...splitSentences(replyBody));
  }

  return stat;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 60);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(`模型=${MODEL}｜6 轮低信息量闲聊，比较复读轮次`);

  const before = await runArm("A 组：不注入【别重复】（改前）", false);
  const after = await runArm("B 组：注入【别重复】（改后）", true);

  const avg = (s: IArmStat): string =>
    s.rounds === 0 ? "—" : (s.chars / s.rounds).toFixed(1);
  console.log("\n===== 汇总 =====");
  console.log(
    `A 组：复读轮次 ${before.repeated}/${Math.max(0, before.rounds - 1)}（共 ${before.rounds} 轮有回复）｜平均字数 ${avg(before)}`,
  );
  console.log(
    `B 组：复读轮次 ${after.repeated}/${Math.max(0, after.rounds - 1)}（共 ${after.rounds} 轮有回复）｜平均字数 ${avg(after)}`,
  );
}

await main();
