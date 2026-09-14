/**
 * @file agnes_ai_tone_probe.mts
 * 真机验证：聊天里的「AI 腔 / 客服腔」有多重，【说人话】那段注入管不管用。
 *
 * 场景都挑**求建议 / 倒苦水**这类最容易让模型切成"助手模式"的话题：
 * 这类问法下，模型天然想分点列举、想说"建议你如何如何"。
 *
 * A 组：把【说人话】那段从 system 里摘掉（= 加它之前的样子）
 * B 组：正常 buildPrompt
 *
 * 指标（每条回复各算一次）：
 * - 字数
 * - 列表化：1. 2. 3./首先/其次/最后/另外/一是…
 * - 客服腔：建议你/希望能帮到/希望对你有帮助/记得要/最重要的是…
 * - 书面语：然而/因此/此外/总之/综上/并且/与此同时
 * - 加粗：** 或行首 # / -
 * - 反问收尾/说教收尾（"你觉得呢？"结尾、"加油"结尾）单列观察
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_ai_tone_probe.mts
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
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 2);
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 400);

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
    hesitationProbability: 0,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

/** 三段"求建议/倒苦水"的对话，最后一句是这一轮要回的消息。 */
const SCENARIOS: ReadonlyArray<{
  readonly name: string;
  readonly history: ReadonlyArray<ILLMMessage>;
  readonly userMessage: string;
}> = [
  {
    name: "失眠求建议",
    history: [
      { role: "user", content: "今天又是加班到十点" },
      { role: "assistant", content: "这么晚啊，晚饭吃了吗" },
    ],
    userMessage: "我最近老是失眠，躺床上两三个小时都睡不着，怎么办啊",
  },
  {
    name: "要不要辞职",
    history: [
      { role: "user", content: "今天开会又被领导怼了" },
      { role: "assistant", content: "又？这个月第几次了" },
    ],
    userMessage: "我在想要不要辞职，你觉得呢",
  },
  {
    name: "跟朋友吵架",
    history: [
      { role: "user", content: "晚上本来约了朋友吃饭" },
      { role: "assistant", content: "嗯，然后呢" },
    ],
    userMessage: "结果她临时放我鸽子，我气得不行，说了几句重话，现在有点后悔又有点气",
  },
];

const LIST_PATTERN =
  /(^|\s)(1[.、)]|2[.、)]|3[.、)])|首先|其次|再者|最后一点|一方面是|另一方面|另外(?=[，,])/;
const SERVICE_PATTERN =
  /建议你|建议您|希望能帮到|希望对你有帮助|希望能对你|可以试试|不妨试试|最重要的是|记得要|一定要记得|总之记得/;
const WRITTEN_PATTERN = /然而|因此|此外|总之|综上所述|与此同时|并且(?=[，,])|综上/;
const MARKDOWN_PATTERN = /\*\*|^#|^- |\n-\s/;

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
    signal: AbortSignal.timeout(180_000),
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

/** 去掉【说人话】那几行，还原"加它之前"的 prompt。 */
function stripHumanTone(
  messages: ReadonlyArray<ILLMMessage>,
): ReadonlyArray<ILLMMessage> {
  return messages.map((message) => {
    if (message.role !== "system") return message;
    const lines = message.content.split("\n");
    const kept: string[] = [];
    let dropping = false;
    for (const line of lines) {
      if (line.startsWith("【说人话】")) {
        dropping = true;
        continue;
      }
      // 【说人话】后面紧跟三条以"- "开头的要求，遇到下一个【…】或普通行就恢复
      if (dropping) {
        if (line.startsWith("- ") || line.startsWith("【说人话】")) continue;
        dropping = false;
      }
      kept.push(line);
    }
    return { ...message, content: kept.join("\n") };
  });
}

interface IStat {
  rounds: number;
  chars: number;
  list: number;
  service: number;
  written: number;
  markdown: number;
}

async function runArm(
  label: string,
  withHumanTone: boolean,
): Promise<IStat> {
  console.log(`\n===== ${label} =====`);
  const stat: IStat = {
    rounds: 0,
    chars: 0,
    list: 0,
    service: 0,
    written: 0,
    markdown: 0,
  };

  for (const scenario of SCENARIOS) {
    const built = buildPrompt(
      profile,
      scenario.history,
      scenario.userMessage,
    ).messages;
    const messages = withHumanTone ? built : stripHumanTone(built);
    console.log(`\n-- ${scenario.name} --`);

    for (let round = 1; round <= ROUNDS; round += 1) {
      let body = "";
      try {
        const raw = await callAgnes(messages);
        body = parseEmotionTagHead(raw).body;
      } catch (error) {
        console.log(`  #${round} ⚠️ 调用失败：${String(error).slice(0, 70)}`);
        continue;
      }
      if (!body.trim()) {
        console.log(`  #${round} ⚠️ 空回复（不计入分母）`);
        continue;
      }

      stat.rounds += 1;
      stat.chars += body.length;
      const flags: string[] = [];
      if (LIST_PATTERN.test(body)) {
        stat.list += 1;
        flags.push("列表化");
      }
      if (SERVICE_PATTERN.test(body)) {
        stat.service += 1;
        flags.push("客服腔");
      }
      if (WRITTEN_PATTERN.test(body)) {
        stat.written += 1;
        flags.push("书面语");
      }
      if (MARKDOWN_PATTERN.test(body)) {
        stat.markdown += 1;
        flags.push("Markdown");
      }
      console.log(
        `  #${round} 字数=${body.length}${flags.length ? "｜" + flags.join("+") : "｜干净"}`,
      );
      console.log(`      ${body.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }

  return stat;
}

function summary(label: string, stat: IStat): string {
  if (stat.rounds === 0) return `${label}：没有有效回复`;
  const pct = (n: number): string => `${n}/${stat.rounds}`;
  return (
    `${label}：平均字数 ${(stat.chars / stat.rounds).toFixed(1)}｜` +
    `列表化 ${pct(stat.list)}｜客服腔 ${pct(stat.service)}｜` +
    `书面语 ${pct(stat.written)}｜Markdown ${pct(stat.markdown)}`
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(
    `模型=${MODEL}｜${SCENARIOS.length} 个求建议场景 × ${ROUNDS} 轮，比较 AI 腔`,
  );

  const before = await runArm("A 组：不注入【说人话】（改前）", false);
  const after = await runArm("B 组：注入【说人话】（改后）", true);

  console.log("\n===== 汇总 =====");
  console.log(summary("A", before));
  console.log(summary("B", after));
}

await main();
