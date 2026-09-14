/**
 * @file agnes_role_confusion_probe.mts
 * 真机验证：**角色会不会把自己的名字用在用户身上**。
 *
 * 起因：`engine_live_probe` 复跑时，用户说"我今天升职了！"，
 * 角色回的是"恭喜你呀**晚晴姐**！"——晚晴是**角色自己**的名字。
 * 猜测的根因：提示词里只说了"你是谁"（你是苏晚晴），
 * 对方是个匿名的"用户"，于是模型抓了唯一的那个名字去称呼对方。
 *
 * 这里把风险量化：几种典型用户发言各跑一轮（每轮都是全新的单轮对话），
 * 统计回复里有没有把"晚晴"用在对方身上。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_role_confusion_probe.mts
 *   $env:GUARD="1"   # 用"带角色守卫句"的提示词跑（对照）
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS_PER_MESSAGE = Number(process.env.PROBE_ROUNDS ?? 2);

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

const USER_MESSAGES = [
  "我今天升职了！",
  "我有点累，不太想说话",
  "你觉得我该怎么办才好",
  "谢谢你一直陪着我",
];

/** 角色自己名字的各种叫法（出现在回复里就值得看一眼，可能是把用户叫成了自己）。 */
const SELF_NAMES = ["晚晴", "苏晚晴"];

/** 带"角色守卫句"的版本：明确点出对方是谁、不要用自己名字叫对方。 */
function guardedExtras(): Parameters<typeof buildPrompt>[4] {
  return {
    userProfile: { displayName: "我", bio: "" },
  };
}

const GUARD_TEXT = [
  "",
  "【关于对方】",
  "- 对方就是正在和你聊天的人，你没有对方的名字。",
  "- 用「你」称呼对方；**不要用「苏晚晴」或任何你自己的名字去称呼对方**。",
].join("\n");

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
      max_tokens: 300,
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const withGuard = (process.env.GUARD ?? "").trim() === "1";
  console.log(`提示词版本：${withGuard ? "带角色守卫句" : "现状（不特别说明对方是谁）"}`);

  let confused = 0;
  let rounds = 0;
  for (const userMessage of USER_MESSAGES) {
    const base = buildPrompt(
      profile,
      [],
      userMessage,
      undefined,
      withGuard ? guardedExtras() : undefined,
    );
    // 守卫句直接拼到开头 system 的末尾（模拟"没填名字也要说清对方是谁"）
    const messages = withGuard
      ? [
          { role: "system" as const, content: base.messages[0]!.content + GUARD_TEXT },
          ...base.messages.slice(1),
        ]
      : base.messages;

    for (let round = 1; round <= ROUNDS_PER_MESSAGE; round += 1) {
      let reply = "";
      try {
        reply = await callAgnes(messages);
      } catch (error) {
        console.log(`  「${userMessage}」调用失败：${String(error).slice(0, 50)}`);
        continue;
      }
      const { body } = parseEmotionTagHead(reply);
      if (body.trim().length === 0) continue;
      rounds += 1;
      const hit = SELF_NAMES.some((name) => body.includes(name));
      if (hit) confused += 1;
      console.log(
        `  ${hit ? "⚠️ 用自己名字称呼对方" : "✅ 正常"}｜「${userMessage}」→ ${body.replace(/\s+/g, " ").slice(0, 46)}`,
      );
    }
  }

  console.log(
    `\n===== 汇总 =====\n角色把自己的名字用在对方身上：${confused}/${rounds}`,
  );
}

await main();
