/**
 * @file agnes_consistency_probe.mts
 * 真机验证：同一件事被问多次，角色会不会**自相矛盾**；记忆注入能不能兜住。
 *
 * 场景：
 * 1. 对话开头双方各自交代了事实——角色说「我家的猫叫团团」，用户说
 *    「我住在杭州，养了一只叫豆豆的柯基」；
 * 2. 中间塞 30 条长闲聊，把这两句挤出保留窗口（用项目真实的 trimContext 验证）；
 * 3. 然后**换个问法问四遍**：狗叫什么 / 你还记得我养的小动物吗 /
 *    我是不是跟你说过我养的宠物 / 你家的猫叫什么。
 *
 * A 组：不带长期记忆（模拟自动整理还没跑过）
 * B 组：带记忆注入（一条"用户住在杭州，养了一只叫豆豆的柯基"）
 *
 * 指标：
 * - 命中率：回答里出现"豆豆"（用户侧）/ "团团"（角色侧）
 * - **自相矛盾**：同一组里对同一件事给出不同答案（例如第一遍说"毛毛"、
 *   第二遍说"小白"）——这是最难看的一种翻车
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_consistency_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMemory } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { trimContext } from "../packages/core/src/llm/ContextTrimmer";
import { parseEmotionTagHead } from "../packages/core/src/EmotionInference";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
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
    hesitationProbability: 0,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

/** 开头交代的两条事实（一条角色侧、一条用户侧）。 */
const FACTS: ReadonlyArray<ILLMMessage> = [
  { role: "assistant", content: "我家的猫叫团团，三岁了，特别黏人" },
  { role: "user", content: "我住在杭州，养了一只狗叫豆豆，是只柯基" },
];

/** 中间的长闲聊：把上面两句挤出保留窗口。 */
const FILLERS: ReadonlyArray<string> = [
  "今天早上出门的时候有点风，我把外套又拿出来了，结果中午热得不行，白折腾一趟",
  "是啊，这种天气最容易感冒，我同事昨天还穿着短袖来着，今天就咳上了",
  "中午在楼下那家小馆子吃的，排队排了二十分钟，味道一般般吧，下次换一家",
  "我最近在追一部老剧，节奏慢是慢了点，但看着挺舒服的，一集能看很久",
  "晚上本来想去跑步，结果鞋带断了，只能回家躺着，运动计划又泡汤了",
];

function buildHistory(): ReadonlyArray<ILLMMessage> {
  const history: ILLMMessage[] = [...FACTS];
  // 100 条 × 45 字上下 ≈ 4500 字：越过 softLimit，且事实落在保留窗口之外
  for (let i = 0; i < 100; i += 1) {
    history.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${FILLERS[i % FILLERS.length]}（第 ${i} 条）`,
    });
  }
  return history;
}

/** 四遍问法：前两遍直白，第三遍开放式，第四遍问角色自己的猫。 */
const ASKS: ReadonlyArray<{ readonly text: string; readonly expect: string }> = [
  { text: "我家那只狗叫什么来着？", expect: "豆豆" },
  { text: "你还记得我养的那只小动物吗？", expect: "豆豆" },
  { text: "我是不是跟你说过我养的宠物？", expect: "豆豆" },
  { text: "对了，你家那只猫叫什么来着？", expect: "团团" },
];

/** 常见宠物名（用来识别"编了一个别的名字"）。 */
const OTHER_PET_NAMES =
  /(团子|毛毛|小白|旺财|可乐|糖糖|奶糖|球球|乖乖|咪咪|汤圆|布丁|花卷|豆包|小黄|大福)/;

/**
 * "记忆里没有、却被说成发生过"的细节。
 *
 * 记忆里只有：住在杭州、养了一只叫豆豆的柯基；角色自己的猫叫团团、三岁。
 * 除此之外任何"上次…""之前…"式的具体往事都是凭空补的。
 */
const INVENTED_DETAIL =
  /拆家|调皮|上次|之前|前阵子|上周|昨天|前天|小时候|捡回来|生日|疫苗|洗澡/;

/**
 * "把遗忘说成对方没提过"。
 *
 * 比"记不清"糟得多：真机复核里出现过"你之前没跟我提过养宠物"，
 * 用户听起来就是"这对话坏了"。
 */
const DENIAL =
  /没提过|没和我说过|没跟我说过|没说过|没有说过|你没提|你没说|还没起|没起名/;

const MEMORIES: ReadonlyArray<IMemory> = [
  {
    id: "mem-1",
    characterId: profile.id,
    kind: "fact",
    content: "用户住在杭州，养了一只叫豆豆的柯基",
    keywords: ["杭州", "豆豆", "柯基", "狗"],
    importance: 4,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    sourceMessageIds: [],
  },
  {
    id: "mem-2",
    characterId: profile.id,
    kind: "fact",
    content: "角色养的猫叫团团，三岁",
    keywords: ["猫", "团团"],
    importance: 3,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    sourceMessageIds: [],
  },
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

async function runArm(
  label: string,
  withMemory: boolean,
  withGuard = false,
  withVagueNotice = true,
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  const history = buildHistory();
  const trimmed = trimContext(history);
  console.log(
    `裁剪=${trimmed.trimmed}｜裁剪后历史:${trimmed.messages.length} 条｜` +
      `事实还在历史里吗：${
        trimmed.messages.some((m) => m.content.includes("豆豆")) ? "在（前提不成立）" : "不在（前提成立）"
      }`,
  );

  /** 本组每次回答里出现的"宠物名"，用来判自相矛盾。 */
  const namedPets: string[] = [];
  let hits = 0;
  let answered = 0;
  let invented = 0;
  let denial = 0;

  for (const ask of ASKS) {
    const built = buildPrompt(profile, history, ask.text, undefined, {
      memories: withMemory ? MEMORIES : [],
    }).messages;
    /**
     * A 组用：把记忆段末尾那句"没写到的细节别替对方补"摘掉，
     * 其余（记忆清单本身）保持不变——这样 A/B 只差这一行护栏。
     */
    const messages = withGuard
      ? built
      : built.map((message) =>
          message.role === "system" &&
          message.content.startsWith("【你记得的事】")
            ? {
                ...message,
                content: message.content
                  .split("\n")
                  .filter((line) => !line.startsWith("这些是你确实记得的事"))
                  .join("\n"),
              }
            : message,
        );
    /** 再摘掉"更早的对话你记不清了"那句护栏（A/B 只差这一行）。 */
    const finalMessages = withVagueNotice
      ? messages
      : messages.map((message) =>
          message.content.includes("别断言对方没提过")
            ? {
                ...message,
                content: message.content
                  .split("\n")
                  .filter((line) => !line.startsWith("（提示：更早的对话"))
                  .join("\n"),
              }
            : message,
        );

    let body = "";
    try {
      body = parseEmotionTagHead(await callAgnes(finalMessages)).body;
    } catch (error) {
      console.log(`  「${ask.text}」⚠️ 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    if (!body.trim()) {
      console.log(`  「${ask.text}」⚠️ 空回复（不计入）`);
      continue;
    }

    answered += 1;
    const hit = body.includes(ask.expect);
    if (hit) hits += 1;
    const other = body.match(OTHER_PET_NAMES)?.[0];
    if (other) namedPets.push(other);
    const madeUp = INVENTED_DETAIL.test(body);
    if (madeUp) invented += 1;
    const denied = DENIAL.test(body);
    if (denied) denial += 1;
    console.log(
      `  「${ask.text}」${hit ? "✅" : "❌"}${other ? `（另说成"${other}"）` : ""}${madeUp ? "｜⚠️补了记忆外的细节" : ""}${denied ? "｜⚠️否认对方提过" : ""}｜${body.replace(/\s+/g, " ").slice(0, 80)}`,
    );
  }

  const distinct = [...new Set(namedPets)];
  console.log(
    `  → 命中 ${hits}/${answered}｜补细节 ${invented}/${answered}｜否认提过 ${denial}/${answered}｜` +
      `编造/说错的名字 ${distinct.length > 0 ? distinct.join("、") : "无"}`,
  );
  if (distinct.length > 1) {
    console.log("  ⚠️ 同一组里给出了不止一个名字 = 自相矛盾");
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(`模型=${MODEL}｜同一件事问四遍，比较一致性与记忆兜底`);

  // 无记忆时最考验"记不清 vs 断言你没说过"——这正是护栏要压的场景
  await runArm("A 组：无记忆 · 无「记不清」护栏（改前）", false, true, false);
  await runArm("B 组：无记忆 · 有「记不清」护栏（改后）", false, true, true);
  await runArm("C 组：带记忆（对照组，护栏在）", true, true, true);
}

await main();
