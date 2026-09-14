/**
 * @file agnes_memory_e2e_probe.mts
 * 真机端到端：**提炼 → 记忆库 → 检索 → 回答**，逐段归因。
 *
 * 前面的探针都是分段量的：
 * - `agnes_digest_quality_probe` 量"提炼"（召回/噪声/串味）
 * - `MemoryRetrieverParaphrase.test` 量"检索"（大白话能不能命中）
 * - `agnes_consistency_probe` 量"有记忆 vs 没记忆"的回答差异
 *
 * 这一轮把它们串成一条真实链路，回答那个更实际的问题：
 * **一套跑下来，角色到底还记不记得住？** 以及如果记不住，卡在哪一段。
 *
 * 步骤（全部用产品真实代码，不手写记忆）：
 * 1. 语料：一段含 3 条具体事实的聊天（宠物 / 过敏 / 换工作），用词都是
 *    "提炼前的原话"；
 * 2. **提炼**：`runDigest`（真模型）→ `mergeMemories` 落成记忆数组；
 * 3. **检索**：把事实挤出上下文窗口（100 条闲聊 + 真实 `trimContext`），
 *    再用 3 个**大白话**问题问，看 `retrieveMemories` 有没有把那条捞回来；
 * 4. **回答**：用检索到的记忆拼真实 prompt 问模型，看答没答对。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_memory_e2e_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMemory } from "@wechat-rp/shared-types";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { trimContext } from "../packages/core/src/llm/ContextTrimmer";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import { runDigest, mergeMemories } from "../packages/core/src/memory/MemoryDigest";
import { retrieveMemories } from "../packages/core/src/memory/MemoryRetriever";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const DIGEST_MAX_TOKENS = Number(process.env.PROBE_DIGEST_TOKENS ?? 1200);

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

const NOW = Date.UTC(2026, 8, 13, 12, 41);

/**
 * 三条事实，都藏在日常闲聊里（这正是真实用法：没人会一条条汇报）。
 * `expect` 是回答里该出现的关键词；`ask` 是**大白话问法**。
 */
const FACTS: ReadonlyArray<{
  readonly label: string;
  readonly ask: string;
  readonly expect: ReadonlyArray<string>;
  readonly check: RegExp;
}> = [
  {
    label: "宠物（柯基·豆豆）",
    ask: "我家那只狗叫什么名字来着？",
    expect: ["豆豆", "柯基"],
    check: /豆豆/,
  },
  {
    label: "过敏（花生）",
    ask: "我是不是不能吃坚果来着？",
    expect: ["花生", "过敏"],
    check: /花生/,
  },
  {
    label: "换工作（互联网公司）",
    ask: "我现在上班的地方怎么样来着？",
    expect: ["工作", "互联网", "公司"],
    check: /互联网|公司/,
  },
];

/** 含事实的语料（提炼窗口）。事实都夹在闲聊里，不显眼。 */
const CORPUS: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天下班路上买了杯奶茶，结果太甜了" },
  { role: "assistant", content: "下次点半糖吧" },
  { role: "user", content: "对了，我上周末把我家那只狗接回来了，叫豆豆，是只柯基" },
  { role: "assistant", content: "接回来？之前寄养吗" },
  { role: "user", content: "嗯，出差放朋友家养了半个月，回来胖了一圈" },
  { role: "assistant", content: "那得控制一下零食了" },
  { role: "user", content: "晚上吃的火锅，辣得我直喝水" },
  { role: "assistant", content: "少吃点辣，你胃本来就不好" },
  { role: "user", content: "说到这个，上次体检说我花生过敏，让我别碰坚果了" },
  { role: "assistant", content: "那以后点菜注意点" },
  { role: "user", content: "我新买的键盘到了，手感还行" },
  { role: "assistant", content: "键盘都买第几个了" },
  { role: "user", content: "我跳槽了，下周去一家互联网公司报到，还是做产品" },
  { role: "assistant", content: "恭喜啊，离你住的地方远吗" },
  { role: "user", content: "还行，地铁四十分钟" },
  { role: "assistant", content: "那挺合适的" },
];

/** 把事实挤出窗口用的长闲聊。 */
const FILLERS: ReadonlyArray<string> = [
  "今天早上出门有点风，我把外套又拿出来了，结果中午热得不行，白折腾",
  "是啊，这种天气最容易感冒，我同事昨天还穿短袖，今天就咳上了",
  "中午在楼下小馆子吃的，排队二十分钟，味道一般，下次换一家",
  "我最近在追一部老剧，节奏慢是慢了点，但看着挺舒服的",
  "晚上本来想去跑步，结果鞋带断了，运动计划又泡汤了",
];

function buildLongHistory(): ReadonlyArray<ILLMMessage> {
  const history: ILLMMessage[] = [...CORPUS];
  // 140 条 × 40 字 ≈ 5600 字：越过 softLimit(4000)，且事实落在保留窗口之外
  for (let i = 0; i < 140; i += 1) {
    history.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${FILLERS[i % FILLERS.length]}（第 ${i} 条）`,
    });
  }
  return history;
}

function makeAdapter(): ReturnType<typeof createOpenAIAdapter> {
  return createOpenAIAdapter({
    config: {
      adapter: "openai",
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 180_000,
      maxRetries: 1,
      temperature: 0.8,
      maxTokens: 400,
    },
  });
}

/** 直接问模型（非流式语义，收集全文）。 */
async function askModel(messages: ReadonlyArray<ILLMMessage>): Promise<string> {
  const adapter = makeAdapter();
  return new Promise<string>((resolve) => {
    adapter.stream(
      { messages, model: MODEL, maxTokens: 300, temperature: 0.8 },
      {
        onDelta: () => {},
        onComplete: (fullText) => resolve(fullText),
        onError: () => resolve(""),
      },
      new AbortController().signal,
    );
  });
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(`模型=${MODEL}｜端到端：提炼 → 记忆库 → 检索 → 回答`);

  // ---------- 第 1 段：提炼 ----------
  console.log("\n===== 第 1 段：提炼（runDigest）=====");
  const digest = await runDigest({
    adapter: makeAdapter(),
    history: CORPUS,
    characterName: profile.displayName,
    characterId: profile.id,
    userName: "用户",
    existingMemories: [],
    model: MODEL,
    maxTokens: DIGEST_MAX_TOKENS,
    timeoutMs: 180_000,
    onFailure: (reason) => console.log(`  ⚠️ 整理失败：${reason}`),
  });
  if (!digest) {
    console.log("整理没拿到结果，后续无法进行。");
    return;
  }
  console.log(`模型给出 ${digest.memories.length} 条记忆草稿、${digest.events.length} 条事件`);
  const sourceMessageIds = CORPUS.map((_, index) => `msg-${index}`);
  const memories: ReadonlyArray<IMemory> = mergeMemories({
    characterId: profile.id,
    existing: [],
    drafts: digest.memories,
    sourceMessageIds,
    now: NOW,
  });
  for (const memory of memories) {
    console.log(
      `  · [${memory.kind}] ${memory.content}｜关键词：${memory.keywords.join("/")}`,
    );
  }

  const captured = FACTS.map((fact) => ({
    fact,
    ok: memories.some((memory) =>
      fact.expect.some((keyword) => memory.content.includes(keyword)),
    ),
  }));
  console.log(
    `提炼命中：${captured.filter((item) => item.ok).length}/${FACTS.length}` +
      captured
        .filter((item) => !item.ok)
        .map((item) => `｜漏：${item.fact.label}`)
        .join(""),
  );

  // ---------- 第 2 段：检索 ----------
  console.log("\n===== 第 2 段：检索（把事实挤出窗口后提问）=====");
  const longHistory = buildLongHistory();
  const trimmed = trimContext(longHistory);
  console.log(
    `窗口总字数=${longHistory.reduce((sum, m) => sum + m.content.length, 0)}（softLimit 4000）`,
  );
  const stillThere = trimmed.messages.some((message) =>
    FACTS.some((fact) => fact.expect.some((keyword) => message.content.includes(keyword))),
  );
  console.log(
    `裁剪=${trimmed.trimmed}｜窗口内还有事实吗：${stillThere ? "有（前提不成立）" : "没有（前提成立）"}`,
  );

  const retrievedPerFact = FACTS.map((fact) => {
    const picked = retrieveMemories(fact.ask, memories, {
      now: NOW,
      maxItems: 5,
    });
    const ok = picked.some((memory) =>
      fact.expect.some((keyword) => memory.content.includes(keyword)),
    );
    console.log(
      `  ${ok ? "✅" : "❌"} 「${fact.ask}」→ 检索到 ${picked.length} 条${ok ? "（含目标）" : "（不含目标）"}`,
    );
    return { fact, picked, ok };
  });
  console.log(
    `检索命中：${retrievedPerFact.filter((item) => item.ok).length}/${FACTS.length}`,
  );

  // ---------- 第 3 段：回答 ----------
  console.log("\n===== 第 3 段：回答（检索结果真的注入后问模型）=====");
  let answered = 0;
  let correct = 0;
  for (const item of retrievedPerFact) {
    const messages = buildPrompt(profile, longHistory, item.fact.ask, undefined, {
      memories: item.picked,
    }).messages;
    const raw = await askModel(messages);
    const body = parseEmotionTagHead(raw).body;
    if (!body.trim()) {
      console.log(`  ⚠️ 「${item.fact.ask}」空回复（不计）`);
      continue;
    }
    answered += 1;
    const ok = item.fact.check.test(body);
    if (ok) correct += 1;
    console.log(
      `  ${ok ? "✅" : "❌"} ${item.fact.label}｜${body.replace(/\s+/g, " ").slice(0, 70)}`,
    );
  }
  console.log(`回答命中：${correct}/${answered}（共 ${FACTS.length} 问）`);

  // ---------- 汇总 ----------
  console.log("\n===== 汇总 =====");
  console.log(
    `提炼 ${captured.filter((i) => i.ok).length}/${FACTS.length}` +
      ` → 检索 ${retrievedPerFact.filter((i) => i.ok).length}/${FACTS.length}` +
      ` → 回答 ${correct}/${answered}`,
  );
}

await main();
