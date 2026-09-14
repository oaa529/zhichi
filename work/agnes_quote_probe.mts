/**
 * @file agnes_quote_probe.mts
 * 真机验证：引用回复能不能救回"已经被上下文裁剪掉"的信息。
 *
 * 场景设计（对照组只差"引用"这一项）：
 * - 很早之前角色说过一句独有信息：「我家的猫叫团团，最近生病了」
 * - 之后几十条闲聊把它挤出上下文窗口（用项目真实的 trimContext 裁剪）
 * - 用户问「它现在好点了吗？」——"它"指谁，只存在于被裁掉的那句里
 *
 * A（改造前）：直接发用户消息 → 模型没有任何线索
 * B（改造后）：formatQuotedText 把被引用的原话拼进 Prompt → 模型应当知道"它"是团团
 *
 * 命中判定：回复里出现"团团"或"猫"即算用上了引用。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_quote_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时，也不会被测试套件收集。
 */

import type {
  ICharacterProfile,
  IMessage,
  IMessageQuote,
} from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import { trimContext } from "../packages/core/src/llm/ContextTrimmer";
import { formatQuotedText } from "../packages/core/src/llm/formatQuote";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 512);

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

/** 早期关键消息：独有信息只在这里出现。 */
const KEY_TEXT = "我家的猫叫团团，最近生病了，我有点担心";

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

/** 早期关键消息 + 若干轮闲谈，长度足以把关键消息挤出裁剪窗口。 */
function buildConversation(): ReadonlyArray<IMessage> {
  const messages: IMessage[] = [];
  let index = 0;
  messages.push(makeMessage(index++, profile.id, KEY_TEXT));
  const fillers: ReadonlyArray<readonly [string, string]> = [
    ["今天食堂的糖醋排骨还不错", "是嘛，我好久没去食堂了"],
    ["你论文写完了吗", "还差最后两章，头大"],
    ["晚上要不要一起散步", "今晚要值班，改天吧"],
    ["外面下雨了", "记得带伞"],
    ["我买了个新的键盘", "手感怎么样"],
    ["周末想去看电影", "有什么想看的吗"],
    ["刚跑完步，累", "记得拉伸"],
    ["明天降温", "多穿点"],
    ["我在看一本小说", "好看吗"],
    ["今天开会开了一下午", "辛苦"],
  ];
  for (const [userText, charText] of fillers) {
    messages.push(makeMessage(index++, "user", userText));
    messages.push(makeMessage(index++, profile.id, charText));
  }
  // 最近几轮（会被保留）
  messages.push(makeMessage(index++, "user", "我最近有点忙"));
  messages.push(makeMessage(index++, profile.id, "嗯，注意休息"));
  messages.push(makeMessage(index++, "user", "你也是"));
  messages.push(makeMessage(index++, profile.id, "好"));
  return messages;
}

/**
 * 当前提问：必须复述专有名词才可能答对。
 * （"它现在好点了吗"这种问法模型含糊回一句"好点了"也能蒙混过关，
 * 无法区分"真的知道"和"顺着说"。）
 */
const userMessage = "它叫什么名字来着？";

const quote: IMessageQuote = {
  messageId: "m-0",
  senderName: profile.displayName,
  preview: KEY_TEXT,
};

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
    /**
     * 180 秒。
     *
     * 探测脚本用的是"总时长"超时，而 agnes 忙起来单次要 60 秒上下——
     * 90 秒会把正常请求掐断，整个对照实验就废了（实测踩到过）。
     * 顺便记一笔：产品里的适配器早就改成**空闲**超时了，脚本没跟着改。
     */
    signal: AbortSignal.timeout(180_000),
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

/** 回复是否用上了引用里的独有信息（猫的名字"团团"）。 */
function mentionsCat(reply: string): boolean {
  return /团团/.test(reply);
}

/**
 * 回复是否在**否认**自己说过那句被引用的话。
 *
 * 这是本轮复核抓到的真问题：就算认出了"团团"，也可能顺手来一句
 * "我没有说过这个呢"——因为那句原话早被上下文裁掉了，它眼前确实没有。
 * 命中率之外单独统计这一项，否则"用上了"会把这种翻车也算成成功。
 */
function deniesSaying(reply: string): boolean {
  return /没说过|没有说过|没说这个|不记得说过|没提过|哪一条|哪句|哪个猫/.test(
    reply,
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  // 1. 走真实链路：消息 → LLM 历史 → 裁剪
  const history = toLLMHistory(buildConversation());
  const trimmed = trimContext(history, {
    keepRounds: 4,
    softLimitChars: 120,
    hardLimitChars: 400,
  });
  const trimmedText = trimmed.messages.map((m) => m.content).join("\n");
  console.log(`裁剪前历史条数=${history.length}`);
  console.log(`裁剪后历史条数=${trimmed.messages.length}（trimmed=${trimmed.trimmed}）`);
  console.log(
    `裁剪后历史里还含关键句（团团）：${trimmedText.includes("团团") ? "是（前提不成立）" : "否（前提成立）"}`,
  );

  const variants: ReadonlyArray<{ label: string; prompt: string }> = [
    { label: "A 无引用（改造前）", prompt: userMessage },
    { label: "B 带引用（改造后）", prompt: formatQuotedText(userMessage, quote) },
  ];

  for (const variant of variants) {
    console.log(`\n===== ${variant.label} =====`);
    console.log(`发给模型的当前用户消息：${JSON.stringify(variant.prompt)}`);
    const messages = buildPrompt(profile, trimmed.messages, variant.prompt).messages;
    let hits = 0;
    let denies = 0;
    let answered = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      /**
       * 单次失败不中断整个对照实验。
       *
       * 端点偶发超时/空回复时，旧写法会直接抛出去把整轮跑废（实测踩到过），
       * 于是"这一组到底行不行"就没法判断了。这里把失败单独标出来，
       * 分母只算真正有回复的轮次。
       */
      let reply = "";
      try {
        reply = await callAgnes(messages);
      } catch (error) {
        console.log(`  #${round} ⚠️ 调用失败：${String(error).slice(0, 80)}`);
        continue;
      }
      if (!reply.trim()) {
        console.log(`  #${round} ⚠️ 空回复（不计入分母）`);
        continue;
      }
      answered += 1;
      const hit = mentionsCat(reply);
      const denied = deniesSaying(reply);
      if (hit) hits += 1;
      if (denied) denies += 1;
      console.log(
        `  #${round} ${hit ? "✅ 用上引用" : "❌ 没用上"}${denied ? "｜⚠️ 否认自己说过" : ""}：${reply.replace(/\s+/g, " ").slice(0, 90)}`,
      );
    }
    console.log(
      `命中率：${hits}/${answered}｜否认率：${denies}/${answered}（共 ${ROUNDS} 轮，失败/空回复不计）`,
    );
  }
}

await main();
