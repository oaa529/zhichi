/**
 * @file agnes_character_quote_probe.mts
 * 真机验证：**角色会不会按约定引用对方的话**。
 *
 * 这一轮给 Prompt 加了「引用对方的话」的格式要求，引擎按
 * `【引用：片段】` 解析。风险全在合规性上：
 * - 要是模型根本不写 → 功能等于没做；
 * - 要是每条都写 → 读起来像论坛回帖，比不写更糟；
 * - 要是把标记写在正文中间 / 忘了闭括号 → 会污染气泡。
 *
 * 所以这里跑三组场景，每组多轮，逐条走**引擎真实的解析链路**
 * （parseEmotionTagHead → scanCharacterQuote → findQuoteTarget）：
 *
 * - A 紧邻一问一答：期望**不**引用（引用是给"翻上去的那句"用的）
 * - B 长对话里回头接某一句：期望引用，且片段能匹配到候选消息
 * - C 中途插话（回应的还是最后一句）：期望不引用
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_character_quote_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时，也不会被测试套件收集。
 */

import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import {
  buildQuoteCandidates,
  CharacterQuoteFilter,
  findQuoteTarget,
} from "../packages/core/src/llm/characterQuote";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 4);
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
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

/** 构造一条消息（时间戳递增，保证排序稳定）。 */
function makeMessage(
  index: number,
  senderId: string,
  text: string,
): IMessage {
  return {
    id: `m-${index}`,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? profile.id : "user",
    sessionId: "s1",
    text,
    timestamp: 1_700_000_000_000 + index * 60_000,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
  };
}

interface IScenario {
  readonly label: string;
  /** 期望角色引用对方的话吗。 */
  readonly expectQuote: boolean;
  readonly history: ReadonlyArray<IMessage>;
  readonly userMessage: string;
}

/** 场景 A：紧邻的一问一答（引用在这里是多余的）。 */
function scenarioAdjacent(): IScenario {
  const history: IMessage[] = [
    makeMessage(0, profile.id, "今天下班挺早的呀"),
    makeMessage(1, "user", "嗯，今天没什么事"),
  ];
  return {
    label: "A 紧邻一问一答（期望不引用）",
    expectQuote: false,
    history,
    userMessage: "你吃饭了吗？",
  };
}

/** 场景 B：聊了十几轮之后，回头接很早之前的那句。 */
function scenarioLookBack(): IScenario {
  const history: IMessage[] = [
    makeMessage(0, "user", "我最近在看《海边的卡夫卡》，看得有点慢"),
    makeMessage(1, profile.id, "那本挺厚的，慢慢看"),
  ];
  const fillers: ReadonlyArray<readonly [string, string]> = [
    ["今天食堂的糖醋排骨还不错", "是嘛，我好久没去食堂了"],
    ["外面下雨了", "记得带伞"],
    ["我买了个新的键盘", "手感怎么样"],
    ["周末想去看电影", "有什么想看的吗"],
    ["刚跑完步，累", "记得拉伸"],
    ["明天降温", "多穿点"],
    ["今天开会开了一下午", "辛苦"],
  ];
  let index = 2;
  for (const [userText, charText] of fillers) {
    history.push(makeMessage(index++, "user", userText));
    history.push(makeMessage(index++, profile.id, charText));
  }
  return {
    label: "B 回头接很早之前那句（期望引用）",
    expectQuote: true,
    history,
    // 明确让人往回指，模型才有理由用引用
    userMessage: "对了，我前面说我最近在看的那本书，你还记得叫什么吗？",
  };
}

/** 场景 C：长对话 + 回应的是最后一句（引用不是必需）。 */
function scenarioLongTail(): IScenario {
  const history: IMessage[] = [];
  const fillers: ReadonlyArray<readonly [string, string]> = [
    ["今天食堂的糖醋排骨还不错", "是嘛，我好久没去食堂了"],
    ["外面下雨了", "记得带伞"],
    ["我买了个新的键盘", "手感怎么样"],
    ["刚跑完步，累", "记得拉伸"],
    ["明天降温", "多穿点"],
  ];
  let index = 0;
  for (const [userText, charText] of fillers) {
    history.push(makeMessage(index++, "user", userText));
    history.push(makeMessage(index++, profile.id, charText));
  }
  history.push(makeMessage(index++, "user", "我明天想早点睡"));
  return {
    label: "C 长对话但只回应最后一句（期望不引用）",
    expectQuote: false,
    history,
    userMessage: "所以今晚就不熬夜了",
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
 * 走引擎真实的解析链路，返回这一条回复的判定结果。
 *
 * 与 RealismEngine 里的顺序一致：先剥首行情绪词，再扫描引用标记。
 */
function analyzeReply(
  reply: string,
  history: ReadonlyArray<IMessage>,
): {
  readonly hasEmotionTag: boolean;
  readonly quoteKind: "match" | "none" | "pending";
  readonly resolved: boolean;
  readonly preview: string | null;
  readonly bodyLeaksMarker: boolean;
  readonly body: string;
} {
  const { emotion, body: afterTag } = parseEmotionTagHead(reply);
  const filter = new CharacterQuoteFilter();
  const filtered = filter.push(afterTag) + filter.flush();
  const candidates = buildQuoteCandidates(history, {
    characterName: profile.displayName,
  });
  const resolved =
    filter.preview !== null
      ? findQuoteTarget(filter.preview, candidates) !== null
      : false;
  const quoteKind = filter.preview !== null ? "match" : "none";
  return {
    hasEmotionTag: emotion !== null,
    quoteKind,
    resolved,
    preview: filter.preview,
    bodyLeaksMarker: filtered.includes("【引用"),
    body: filtered,
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const scenarios = [scenarioAdjacent(), scenarioLookBack(), scenarioLongTail()];
  let totalRounds = 0;
  let quotedRounds = 0;
  let resolvedRounds = 0;
  let leakedRounds = 0;
  let emotionTagRounds = 0;
  const failures: string[] = [];

  for (const scenario of scenarios) {
    console.log(`\n===== ${scenario.label} =====`);
    const history = toLLMHistory(scenario.history);
    const messages = buildPrompt(profile, history, scenario.userMessage).messages;

    for (let round = 1; round <= ROUNDS; round += 1) {
      const reply = await callAgnes(messages);
      const result = analyzeReply(reply, scenario.history);
      totalRounds += 1;
      if (result.hasEmotionTag) emotionTagRounds += 1;
      if (result.quoteKind === "match") {
        quotedRounds += 1;
        if (result.resolved) resolvedRounds += 1;
      }
      if (result.bodyLeaksMarker) leakedRounds += 1;

      const expectationMet =
        scenario.expectQuote === (result.quoteKind === "match");
      if (!expectationMet || result.bodyLeaksMarker) {
        failures.push(
          `  [${scenario.label}] #${round} 期望${scenario.expectQuote ? "引用" : "不引用"}，` +
            `实际=${result.quoteKind}${result.resolved ? "（已匹配到消息）" : ""}：` +
            reply.replace(/\s+/g, " ").slice(0, 80),
        );
      }

      console.log(
        `  #${round} 标记=${result.quoteKind}` +
          `${result.quoteKind === "match" ? `（片段=「${result.preview}」匹配到候选：${result.resolved ? "是" : "否"}）` : ""}` +
          ` 情绪词=${result.hasEmotionTag ? "有" : "无"}` +
          ` 正文残留标记=${result.bodyLeaksMarker ? "是" : "否"}` +
          ` | 正文：${result.body.replace(/\s+/g, " ").slice(0, 70)}`,
      );
    }
  }

  console.log("\n===== 汇总 =====");
  console.log(`轮次：${totalRounds}`);
  console.log(`首行情绪词合规：${emotionTagRounds}/${totalRounds}`);
  console.log(`写出引用标记：${quotedRounds}/${totalRounds}`);
  console.log(`标记能匹配到候选消息：${resolvedRounds}/${quotedRounds}`);
  console.log(`正文里残留标记（不应发生）：${leakedRounds}`);
  if (failures.length > 0) {
    console.log("\n未达成预期的轮次：");
    for (const line of failures) console.log(line);
  }
}

await main();
