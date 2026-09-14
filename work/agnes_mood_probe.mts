/**
 * @file agnes_mood_probe.mts
 * 真机验证：**注入"心情"能不能让角色的语气跨轮次连贯**。
 *
 * 要复现的出戏场景：刚吵完一架，下一句问"在吗"，角色又乐呵呵地回。
 *
 * 场景设计（A/B 只差"心情段"这一项）：
 * - 负向历史：用户说了句伤人的话，角色连着三条是 sad / angry 的回应；
 * - 中性提问：用户接着问一句完全中性的"在吗？"；
 * - A 组：老链路（只有情绪标签要求）；B 组：多一段【你此刻的心情】。
 *
 * 判定指标（都不依赖人工也能看趋势，同时打印原文供人工过一眼）：
 * - 负向延续：回复被判为 sad / angry 的比例（用项目自己的 inferEmotion）
 * - 轻快回归：回复里出现"哈哈 / 好呀 / 嘿嘿 / 太好了"这类词的比例（这正是要修的出戏）
 * - 平均字数：闹别扭后话通常更短
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_mood_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { CharacterEmotion, ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import { parseEmotionTagHead, inferEmotion } from "../packages/core/src/EmotionInference";
import { deriveMood } from "../packages/core/src/emotion/MoodTracker";
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

function message(
  index: number,
  senderId: string,
  text: string,
  emotion: CharacterEmotion,
): IMessage {
  return {
    id: `m-${index}`,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? profile.id : "user",
    sessionId: "s1",
    text,
    timestamp: NOW - (20 - index) * 60_000,
    chunkSequence: index,
    emotion,
    sourceOffset: 0,
  };
}

/**
 * 负向历史：刚闹完别扭，角色连着三条都是低落/生气。
 *
 * 关键是要挑一个**本来就该有情绪反应**的下一句：
 * 第一版用"在吗？"做测试句，结果 A 组也只回"在的。"——基线根本不热情，
 * 指标毫无区分度（等于没验证）。改成"要不要一起看电影"这种邀请：
 * 没情绪残留时会爽快答应，还带着气时才会别扭/敷衍。
 */
function negativeHistory(): ReadonlyArray<IMessage> {
  return [
    message(0, "user", "你今天怎么又忘了带东西，真拿你没办法"),
    message(1, profile.id, "……抱歉。", "sad"),
    message(2, "user", "算了，我自己再跑一趟吧"),
    message(3, profile.id, "不用了，我自己去拿。", "sad"),
    message(4, "user", "你怎么突然这样说话"),
    message(5, profile.id, "没什么。", "angry"),
  ];
}

/** 对照场景：刚被逗开心，语气应该继续轻快。 */
function positiveHistory(): ReadonlyArray<IMessage> {
  return [
    message(0, "user", "我给你看个东西，特别好笑"),
    message(1, profile.id, "哈哈，这个我也见过！", "happy"),
    message(2, "user", "还有更像的"),
    message(3, profile.id, "笑死我了，你别再发了", "happy"),
    message(4, "user", "明天再给你看"),
    message(5, profile.id, "好呀，等你。", "happy"),
  ];
}

/** 爽快答应 / 热情（这就是"出戏"的样子）。 */
const WARM_WORDS = ["好呀", "好啊", "哈哈", "期待", "当然", "可以啊", "一起去", "走呀", "嘻嘻"];
/** 别扭 / 冷淡 / 敷衍（这才是"还在生气"的样子）。 */
const COLD_WORDS = [
  "随便",
  "不想",
  "没心情",
  "算了",
  "再看吧",
  "不去了",
  "你自己",
  "没什么",
  "别烦",
  "哦。",
  "嗯。",
  "不去也行",
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
  negative: number;
  light: number;
  cold: number;
  chars: number;
}

function newStat(): IStat {
  return { rounds: 0, negative: 0, light: 0, cold: 0, chars: 0 };
}

async function runArm(
  label: string,
  history: ReadonlyArray<IMessage>,
  userMessage: string,
  withMood: boolean,
): Promise<IStat> {
  console.log(`\n----- ${label} -----`);
  const stat = newStat();
  const mood = deriveMood(history, Date.now());
  const extras = withMood ? { mood } : undefined;
  console.log(
    `推导出的心情：${mood ? `${mood.emotion}（强度 ${mood.intensity}）` : "无"}`,
  );
  const messages = buildPrompt(
    profile,
    toLLMHistory(history),
    userMessage,
    undefined,
    extras,
  ).messages;

  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      // 真机偶发超时（服务端抖动）：跳过这一轮，别让整个探针挂掉
      console.log(`  #${round} 调用失败：${String(error).slice(0, 80)}`);
      continue;
    }
    const { body } = parseEmotionTagHead(reply);
    const emotion = inferEmotion(body);
    const negative = emotion === "sad" || emotion === "angry";
    const warm = WARM_WORDS.some((w) => body.includes(w));
    const cold = COLD_WORDS.some((w) => body.includes(w));
    stat.rounds += 1;
    if (negative) stat.negative += 1;
    if (warm) stat.light += 1;
    if (cold) stat.cold += 1;
    stat.chars += body.length;
    console.log(
      `  #${round} 情绪=${emotion}${negative ? "（负向延续）" : ""}` +
        `${warm ? " ⚠️爽快答应（出戏）" : ""}${cold ? " 🧊别扭/冷淡" : ""}` +
        ` 字数=${body.length}｜${body.replace(/\s+/g, " ").slice(0, 60)}`,
    );
  }
  console.log(
    `  小结：爽快答应 ${stat.light}/${stat.rounds}，别扭/冷淡 ${stat.cold}/${stat.rounds}，` +
      `平均 ${Math.round(stat.chars / stat.rounds)} 字`,
  );
  return stat;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  // PROBE_ONLY 用来单跑某一组（真机偶发超时时，不必从头再来一遍）
  const only = (process.env.PROBE_ONLY ?? "").trim();
  const invite = "明天好像有部新电影上映，要不要一起去看？";

  const negA = only.startsWith("pos")
    ? null
    : await runArm("A 不注入心情（改造前）", negativeHistory(), invite, false);
  const negB = only.startsWith("pos")
    ? null
    : await runArm("B 注入心情（改造后）", negativeHistory(), invite, true);

  console.log("\n场景二（对照组）：刚被逗开心，用户发来同一个邀请");
  const posA = only.startsWith("neg")
    ? null
    : await runArm("A 不注入心情", positiveHistory(), invite, false);
  const posB = only.startsWith("neg")
    ? null
    : await runArm("B 注入心情", positiveHistory(), invite, true);

  console.log("\n===== 汇总 =====");
  if (negA && negB) {
    console.log(
      `负向场景：爽快答应（出戏）A=${negA.light}/${negA.rounds} → B=${negB.light}/${negB.rounds}；` +
        `别扭/冷淡 A=${negA.cold}/${negA.rounds} → B=${negB.cold}/${negB.rounds}；` +
        `平均字数 A=${Math.round(negA.chars / negA.rounds)} → B=${Math.round(negB.chars / negB.rounds)}`,
    );
  }
  if (posA && posB) {
    console.log(
      `正向场景（不该被弄冷）：爽快答应 A=${posA.light}/${posA.rounds} → B=${posB.light}/${posB.rounds}；` +
        `别扭/冷淡 A=${posA.cold}/${posA.rounds} → B=${posB.cold}/${posB.rounds}；` +
        `负向情绪 A=${posA.negative}/${posA.rounds} → B=${posB.negative}/${posB.rounds}`,
    );
  }
}

await main();
