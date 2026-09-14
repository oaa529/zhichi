/**
 * @file agnes_lore_probe.mts
 * 真机验证：世界书条目能不能让角色答出"作者写死的设定"。
 *
 * 场景：世界书里有一条只有作者知道的设定——
 * 「店里最老的一张黑胶是 1968 年的 Beatles《White Album》，从不外借」。
 * 用户问「你店里最老的那张黑胶是什么？」（关键词"黑胶"命中）。
 *
 * A（无世界书）：模型只能含糊其辞或编造
 * B（有世界书）：应当答出 1968 / Beatles / White Album
 *
 * 命中判定：回复里出现 "1968"、"White Album" 或 "披头士/Beatles" 之一。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_lore_probe.mts
 */

import type { ICharacterProfile, ILoreEntry } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { selectLoreEntries } from "../packages/core/src/lore/LoreKeeper";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 2);

const profile: ICharacterProfile = {
  id: "char-lin-xia",
  displayName: "林见夏",
  bio: "海边小镇的旧唱片店老板",
  visualMetadata: { avatarUrl: "", sprites: [], supportsPinSprite: false, defaultSpriteAnchor: "left" },
  schedule: { wakeTime: "07:30", sleepTime: "23:30", scheduleEnabled: false, timezone: "Asia/Shanghai", sleepReplyPolicy: "drowsy-burst" },
  personalityTraits: { archetype: "gentle", typingSpeedMultiplier: 1, fragmentationBias: 0.5, hesitationProbability: 0.12, typoRate: 0, stickerFrequency: 0 },
  promptTemplateId: "",
};

/** 作者写死的设定：模型不可能自己知道。 */
const loreEntries: ReadonlyArray<ILoreEntry> = [
  {
    id: "lore-oldest",
    keys: ["黑胶", "最老", "唱片"],
    secondaryKeys: [],
    content:
      "店里最老的一张黑胶是 1968 年的 Beatles《White Album》，老板从不外借，只允许在店里听。",
    enabled: true,
    order: 0,
    caseSensitive: false,
    constant: false,
    selective: false,
  },
  {
    id: "lore-unrelated",
    keys: ["咖啡"],
    secondaryKeys: [],
    content: "店里的咖啡只做手冲，用的是云南豆。",
    enabled: true,
    order: 1,
    caseSensitive: false,
    constant: false,
    selective: false,
  },
];

const userMessage = "你店里最老的那张黑胶是什么？";

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
      max_tokens: 512,
      stream: false,
    }),
    signal: AbortSignal.timeout(150_000),
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

/** 回复是否用上了那条世界书设定。 */
function mentionsLore(reply: string): boolean {
  return /1968|White Album|white album|披头士|Beatles/i.test(reply);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  // 走真实链路：检索（关键词命中）→ 渲染成 Prompt 段落
  const selection = selectLoreEntries(userMessage, loreEntries);
  console.log(
    `检索结果：注入 ${selection.stats.injected} 条 / 候选 ${selection.stats.total} 条` +
      `（命中：${selection.entries.map((e) => e.id).join(", ") || "无"}）`,
  );

  const variants = [
    { label: "A 无世界书（改造前）", lore: [] as ReadonlyArray<ILoreEntry> },
    { label: "B 有世界书（改造后）", lore: selection.entries },
  ];

  for (const variant of variants) {
    console.log(`\n===== ${variant.label} =====`);
    const messages = buildPrompt(profile, [], userMessage, undefined, {
      lore: variant.lore,
    }).messages;
    let hits = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      // 免费额度偶尔会慢到超时，失败重试一次再算数
      let reply = "";
      try {
        reply = await callAgnes(messages);
      } catch (error) {
        console.warn(`  #${round} 首次请求失败（${String(error).slice(0, 60)}），重试…`);
        reply = await callAgnes(messages);
      }
      const hit = mentionsLore(reply);
      if (hit) hits += 1;
      console.log(
        `  #${round} ${hit ? "✅ 用上设定" : "❌ 没用上"}：${reply.replace(/\s+/g, " ").slice(0, 90)}`,
      );
    }
    console.log(`命中率：${hits}/${ROUNDS}`);
  }
}

await main();
