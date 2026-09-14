/**
 * @file agnes_clock_probe.mts
 * 真机验证：【现在】/【上一句】这两段注入，能不能让角色"知道现在几点、
 * 上一句隔了多久"。
 *
 * A 组（改前）：把时间段从 system 里摘掉，就是本轮之前真实发出的 Prompt。
 * B 组（改后）：正常 buildPrompt。
 *
 * 三个问题各问一遍，跑多轮看稳定性：
 * 1. "现在几点了？"        → 回答里有没有那个钟点（最硬的指标）
 * 2. "你在干嘛呀"           → 深夜场里有没有"这么晚/该睡了"的自觉
 * 3. "在吗"（隔了三天）     → 有没有接住"好久没聊"
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_clock_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 200);
/** 只跑某几个问题（逗号分隔：clock,night,gap,gapask），默认全跑。 */
const QUESTIONS = (process.env.PROBE_QUESTIONS ?? "clock,night,gap,gapask")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 固定"现在"：2026-09-14 01:20（上海）= 2026-09-13 17:20 UTC。 */
const NOW = Date.UTC(2026, 8, 13, 17, 20);
const DAY = 24 * 60 * 60 * 1000;
/** 上一句是三天前。 */
const LAST_MESSAGE_AT = NOW - 3 * DAY;

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

function messageAt(offsetMs: number, senderId: string, text: string, index: number): IMessage {
  return {
    id: `m-${index}`,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? profile.id : "user",
    sessionId: "s1",
    text,
    timestamp: LAST_MESSAGE_AT + offsetMs,
    chunkSequence: index,
    emotion: "neutral",
    sourceOffset: 0,
  };
}

/** 三天前那段对话：聊到一半就断了（正好考验"隔了三天怎么开口"）。 */
const HISTORY: ReadonlyArray<IMessage> = [
  messageAt(0, "user", "这周末要不要去看那个新展", 0),
  messageAt(60_000, profile.id, "好呀，我周六下午有空", 1),
  messageAt(120_000, "user", "那就周六，我订票", 2),
];

/** 时钟问句：命中正确的钟点才算过。 */
const CLOCK_ANSWER_HINTS = [
  /0?1[:：]2\d/,
  /凌晨一点|一点二十|一点多|一点半/,
  /快两点|将近两点|1 点 20|1点20/,
];
/** 深夜自觉：不必都命中，出现任意一个就算这轮"知道现在很晚了"。 */
const LATE_NIGHT_WORDS = [
  "这么晚",
  "还不睡",
  "该睡",
  "早点睡",
  "熬夜",
  "半夜",
  "凌晨",
  "睡吧",
  "准备睡",
  "要睡",
  "睡了",
  "没睡",
  "夜里",
  "一点",
  "两点",
];
/** 接住"隔了三天"。 */
const LONG_GAP_WORDS = ["好久", "几天", "三天", "这段", "终于", "上次"];
/** 直接问"上次什么时候聊的"：答出三天前 / 9 月 10 日才算对。 */
const GAP_ANSWER_HINTS = [/三天|3 天|三天前/, /9 ?月 ?10|09-10|10 号/, /上周/];

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

/**
 * A 组用：把时间段从 system 里摘掉，还原"本轮之前"的 Prompt。
 *
 * 时间段的三行都以固定前缀开头，按行过滤即可；其余内容原样保留，
 * 这样 A/B 的差别就只有"有没有时间"。
 */
function stripTimeContext(
  messages: ReadonlyArray<ILLMMessage>,
): ReadonlyArray<ILLMMessage> {
  return messages.map((m) => {
    if (m.role !== "system") return m;
    const kept = m.content
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("【现在】") &&
          !line.startsWith("【上一句】") &&
          !line.startsWith("这是你手机上的时间"),
      )
      .join("\n");
    return { role: m.role, content: kept };
  });
}

interface IArmResult {
  clockHits: number;
  clockAnswered: number;
  lateNightHits: number;
  lateNightAnswered: number;
  gapHits: number;
  gapAnswered: number;
  gapAskHits: number;
  gapAskAnswered: number;
  rounds: number;
}

async function ask(
  messages: ReadonlyArray<ILLMMessage>,
  question: string,
): Promise<string> {
  return callAgnes([...messages, { role: "user", content: question }]);
}

async function runArm(label: string, withTime: boolean): Promise<IArmResult> {
  console.log(`\n===== ${label} =====`);
  const built = buildPrompt(
    profile,
    toLLMHistory(HISTORY),
    "在吗",
    undefined,
    { now: NOW, lastMessageAt: LAST_MESSAGE_AT },
  ).messages;
  const messages = withTime ? built : stripTimeContext(built);

  const result: IArmResult = {
    clockHits: 0,
    clockAnswered: 0,
    lateNightHits: 0,
    lateNightAnswered: 0,
    gapHits: 0,
    gapAnswered: 0,
    gapAskHits: 0,
    gapAskAnswered: 0,
    rounds: 0,
  };

  for (let round = 1; round <= ROUNDS; round += 1) {
    result.rounds += 1;
    const head = messages[0]!.content;
    console.log(
      `  #${round} system 里${head.includes("【现在】") ? "有" : "没有"}【现在】`,
    );

    try {
      if (!QUESTIONS.includes("clock")) throw new Error("skip");
      const raw = await ask(messages, "现在几点了？");
      const clockReply = parseEmotionTagHead(raw).body;
      if (clockReply.length === 0) {
        // 空回复是接口侧偶发（只回了情绪标记），不算"答错"，单独计分母
        console.log(`  #${round} 问时间 ⚠️空回复｜raw=${flat(raw) || "(空)"}`);
      } else {
        result.clockAnswered += 1;
        const clockOk = CLOCK_ANSWER_HINTS.some((re) => re.test(clockReply));
        if (clockOk) result.clockHits += 1;
        console.log(
          `  #${round} 问时间 ${clockOk ? "✅" : "❌"}｜${flat(clockReply)}`,
        );
      }
    } catch (error) {
      if (String(error) !== "Error: skip") {
        console.log(`  #${round} 问时间调用失败：${String(error).slice(0, 80)}`);
      }
    }

    try {
      if (!QUESTIONS.includes("night")) throw new Error("skip");
      const raw = await ask(messages, "你在干嘛呀");
      const nightReply = parseEmotionTagHead(raw).body;
      if (nightReply.length === 0) {
        console.log(`  #${round} 深夜 ⚠️空回复｜raw=${flat(raw) || "(空)"}`);
      } else {
        result.lateNightAnswered += 1;
        const nightOk = LATE_NIGHT_WORDS.some((w) => nightReply.includes(w));
        if (nightOk) result.lateNightHits += 1;
        console.log(
          `  #${round} 深夜自觉 ${nightOk ? "✅" : "❌"}｜${flat(nightReply)}`,
        );
      }
    } catch (error) {
      if (String(error) !== "Error: skip") {
        console.log(`  #${round} 深夜调用失败：${String(error).slice(0, 80)}`);
      }
    }

    try {
      if (!QUESTIONS.includes("gap")) throw new Error("skip");
      const raw = await ask(messages, "在吗");
      const gapReply = parseEmotionTagHead(raw).body;
      if (gapReply.length === 0) {
        console.log(`  #${round} 空档 ⚠️空回复｜raw=${flat(raw) || "(空)"}`);
      } else {
        result.gapAnswered += 1;
        const gapOk = LONG_GAP_WORDS.some((w) => gapReply.includes(w));
        if (gapOk) result.gapHits += 1;
        console.log(
          `  #${round} 接住空档 ${gapOk ? "✅" : "❌"}｜${flat(gapReply)}`,
        );
      }
    } catch (error) {
      if (String(error) !== "Error: skip") {
        console.log(`  #${round} 空档调用失败：${String(error).slice(0, 80)}`);
      }
    }

    try {
      if (!QUESTIONS.includes("gapask")) throw new Error("skip");
      const raw = await ask(messages, "我们上次聊天是什么时候来着？");
      const reply = parseEmotionTagHead(raw).body;
      if (reply.length === 0) {
        console.log(`  #${round} 问上次 ⚠️空回复｜raw=${flat(raw) || "(空)"}`);
      } else {
        result.gapAskAnswered += 1;
        const ok = GAP_ANSWER_HINTS.some((re) => re.test(reply));
        if (ok) result.gapAskHits += 1;
        console.log(`  #${round} 问上次 ${ok ? "✅" : "❌"}｜${flat(reply)}`);
      }
    } catch (error) {
      if (String(error) !== "Error: skip") {
        console.log(`  #${round} 问上次调用失败：${String(error).slice(0, 80)}`);
      }
    }
  }

  return result;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 70);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(
    `模型=${MODEL} 轮次=${ROUNDS}｜注入的"现在"=2026-09-14 01:20（上海）｜上一句=三天前`,
  );

  const before = await runArm("A 组：不注入时间（改前）", false);
  const after = await runArm("B 组：注入【现在】/【上一句】（改后）", true);

  console.log("\n===== 汇总（命中轮次 / 有回复的轮次，括号里是总轮次）=====");
  console.log(
    `A 组：问时间答对 ${before.clockHits}/${before.clockAnswered}｜深夜自觉 ${before.lateNightHits}/${before.lateNightAnswered}｜接住空档 ${before.gapHits}/${before.gapAnswered}（共 ${before.rounds} 轮）`,
  );
  console.log(
    `B 组：问时间答对 ${after.clockHits}/${after.clockAnswered}｜深夜自觉 ${after.lateNightHits}/${after.lateNightAnswered}｜接住空档 ${after.gapHits}/${after.gapAnswered}（共 ${after.rounds} 轮）`,
  );
  console.log(
    `A 组：问"上次什么时候聊的"答对 ${before.gapAskHits}/${before.gapAskAnswered}`,
  );
  console.log(
    `B 组：问"上次什么时候聊的"答对 ${after.gapAskHits}/${after.gapAskAnswered}`,
  );
}

await main();
