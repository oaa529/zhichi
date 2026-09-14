/**
 * @file agnes_quote_format_probe.mts
 * 真机对照：引用在 Prompt 里的写法，哪种最不容易被模型理解成"别人说的话"。
 *
 * 背景：首轮验证里"（引用 苏晚晴：「…」）"拿到了 2/3 命中，但有 1 次模型
 * 反过来否认「我没有说过这样的话哦，我不养猫呢」——说明它把被引用的内容
 * 当成了第三方消息。本探针固定场景、只改引用写法，比较命中率与"否认率"。
 *
 * 用法：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_quote_format_probe.mts
 */

import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import { trimContext } from "../packages/core/src/llm/ContextTrimmer";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐，比用户大两岁，话不多但很细心",
  visualMetadata: { avatarUrl: "", sprites: [], supportsPinSprite: false, defaultSpriteAnchor: "left" },
  schedule: { wakeTime: "07:30", sleepTime: "23:30", scheduleEnabled: false, timezone: "Asia/Shanghai", sleepReplyPolicy: "drowsy-burst" },
  personalityTraits: { archetype: "gentle", typingSpeedMultiplier: 1, fragmentationBias: 0.5, hesitationProbability: 0.1, typoRate: 0, stickerFrequency: 0 },
  promptTemplateId: "",
};

const KEY_TEXT = "我家的猫叫团团，最近生病了，我有点担心";
/**
 * 提问必须复述专有名词才可能答对：
 * "它现在好点了吗"这种问法模型可以含糊回答"好点了"，
 * 无法区分"真的知道"和"顺着说"；"它叫什么名字来着"则只有知道名字才答得上。
 */
const userMessage = "它叫什么名字来着？";

function makeMessage(index: number, senderId: string, text: string): IMessage {
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
  messages.push(makeMessage(index++, "user", "我最近有点忙"));
  messages.push(makeMessage(index++, profile.id, "嗯，注意休息"));
  messages.push(makeMessage(index++, "user", "你也是"));
  messages.push(makeMessage(index++, profile.id, "好"));
  return messages;
}

async function callAgnes(messages: ReadonlyArray<ILLMMessage>): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.8, max_tokens: 512, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

const FORMATS: ReadonlyArray<{ label: string; render: (text: string) => string }> = [
  { label: "F1 引用+名字（当前实现）", render: (t) => `（引用 苏晚晴：「${t}」）\n${userMessage}` },
  { label: "F2 说过的话", render: (t) => `（引用苏晚晴说过的话：「${t}」）\n${userMessage}` },
  { label: "F3 我（角色）之前说过", render: (t) => `（引用我（苏晚晴）之前说过的话：「${t}」）\n${userMessage}` },
  { label: "F4 引用消息 · 名字", render: (t) => `（引用消息 · 苏晚晴：「${t}」）\n${userMessage}` },
];

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const trimmed = trimContext(toLLMHistory(buildConversation()), {
    keepRounds: 4,
    softLimitChars: 120,
    hardLimitChars: 400,
  });
  console.log(
    `裁剪后历史条数=${trimmed.messages.length}，含关键句=${trimmed.messages.some((m) => m.content.includes("团团"))}`,
  );

  for (const format of FORMATS) {
    console.log(`\n===== ${format.label} =====`);
    const prompt = format.render(KEY_TEXT);
    const messages = buildPrompt(profile, trimmed.messages, prompt).messages;
    let hits = 0;
    let denials = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const reply = await callAgnes(messages);
      const denied = /没说过|没有说过|不养猫|没有猫|什么时候说过/.test(reply);
      const hit = !denied && /团团/.test(reply);
      if (denied) denials += 1;
      if (hit) hits += 1;
      console.log(`  #${round} ${hit ? "✅" : denied ? "🚫 否认" : "❌"}：${reply.replace(/\s+/g, " ").slice(0, 80)}`);
    }
    console.log(`命中率：${hits}/${ROUNDS}　否认率：${denials}/${ROUNDS}`);
  }
}

await main();
