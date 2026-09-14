/**
 * @file agnes_plot_advance_probe.mts
 * 真机验证：**「推进剧情」到底推不推得动**。
 *
 * 现状：`buildPlotAdvancePrompt` 只说"优先处理你最在意的一条未解线索"，
 * 从不点名具体是哪条——而状态卡里明明写着 `openThreads`。
 * 这轮对比两版指令：
 *
 * - A 现状：泛泛地"挑一条未解线索推进"
 * - B 改动：**把线索原文念出来**（"优先处理这条：『周六的展还没定下来』"），
 *   并说明"这一步只推进一点点就好"
 *
 * 判定：回复有没有真的碰到状态卡里的线索（展 / 搬家 / 摄影集），
 * 以及碰了几条；同时打印原文供人工过一眼。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_plot_advance_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IPlotState } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { renderPlotSummary } from "../packages/core/src/plot/PlotKeeper";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
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

const HISTORY: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "那天是我不对，话说重了" },
  { role: "assistant", content: "我也有问题，说开了就好" },
  { role: "user", content: "嗯，那明天见" },
  { role: "assistant", content: "好，早点休息" },
];

/** 状态卡：三条未解线索，都还没做。 */
const STATE: IPlotState = {
  sessionId: "s1",
  chapter: "第二章",
  scene: "和好之后的第二天",
  timeLabel: "周五晚上",
  location: "各自在家",
  relations: [{ characterId: "char-su-wanqing", label: "关系缓和，还在小心试探" }],
  openThreads: ["周六的展还没定下来", "用户下周搬家需要帮手", "说好要送的摄影集还没送出去"],
  synopsis: "两人刚把话说开，气氛缓和但都还有点拘谨。",
  events: [],
  history: [],
  updatedAt: NOW,
};

/** 现状的推进指令（产品里的那版）。 */
function promptCurrent(characterName: string): string {
  return `（系统：请以${characterName}的身份推进一步剧情——优先处理「当前剧情」中你最在意的一条未解线索，或以自然的方式推动场景/关系发生一点变化。保持人设与聊天风格，像平时发消息一样说话，不要提及系统提示。）`;
}

/** 候选改动：线索点名 + 每次只推进一点点。 */
function promptNameThreads(characterName: string): string {
  const threads = STATE.openThreads.slice(0, 3).map((t) => `「${t}」`).join("、");
  return `（系统：请以${characterName}的身份主动推进一步剧情。当前还没了结的事有：${threads}。挑一件你现在最想提的，直接开口——这一步只推进一点点就好（问一句、提一个具体安排、或说出自己的一个小想法），不要一次把事情全办完，也不要写长篇。保持人设与聊天风格，不要提及系统提示。）`;
}

/** 回复碰到了哪几条线索。 */
function touchedThreads(reply: string): ReadonlyArray<string> {
  const marks: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["展", ["展", "看展", "周六的事", "周六那个"]],
    ["搬家", ["搬家", "搬东西", "帮忙搬", "帮你搬"]],
    ["摄影集", ["摄影集", "画册", "那本集子"]],
  ];
  return marks
    .filter(([, words]) => words.some((word) => reply.includes(word)))
    .map(([label]) => label);
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

async function runArm(
  label: string,
  prompt: string,
): Promise<{ hits: number; rounds: number; threads: number }> {
  console.log(`\n----- ${label} -----`);
  const plotSummary = renderPlotSummary(STATE);
  const messages = buildPrompt(profile, HISTORY, prompt, undefined, {
    plotSummary,
  }).messages;

  let hits = 0;
  let rounds = 0;
  let threads = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      console.log(`  #${round} 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    const { body } = parseEmotionTagHead(reply);
    // 空响应单独计：那是服务端偶发，不该算成"没碰线索"
    if (body.trim().length === 0) {
      console.log(`  #${round} ⚠️ 空响应（不计入统计）`);
      continue;
    }
    const touched = touchedThreads(body);
    rounds += 1;
    threads += touched.length;
    if (touched.length > 0) hits += 1;
    console.log(
      `  #${round} ${touched.length > 0 ? `✅ 碰到线索：${touched.join("、")}` : "❌ 没碰线索"}｜${body.replace(/\s+/g, " ").slice(0, 70)}`,
    );
  }
  return { hits, rounds, threads };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const a = await runArm("A 现状：泛泛地说「挑一条未解线索」", promptCurrent(profile.displayName));
  const b = await runArm("B 改动：把线索点名念出来", promptNameThreads(profile.displayName));

  console.log("\n===== 汇总 =====");
  console.log(`A 碰到线索：${a.hits}/${a.rounds}（共碰到 ${a.threads} 条线索）`);
  console.log(`B 碰到线索：${b.hits}/${b.rounds}（共碰到 ${b.threads} 条线索）`);
}

await main();
