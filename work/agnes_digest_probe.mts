/**
 * @file agnes_digest_probe.mts
 * 真机验证：记忆冲突更新（用户"戒咖啡改喝茶"后，旧记忆应被 supersedes 取代）。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_digest_probe.mts
 */

import type { IMemory } from "@wechat-rp/shared-types";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { mergeMemories, runDigest } from "../packages/core/src/memory/MemoryDigest";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

const NOW = Date.now();

/** 已有的长期记忆（其中"喜欢喝咖啡"这条本轮应当被取代）。 */
function existingMemories(): IMemory[] {
  const base = {
    characterId: "char-su-wanqing",
    keywords: [] as string[],
    importance: 3 as const,
    pinned: false,
    createdAt: NOW - 86400000,
    updatedAt: NOW - 86400000,
    sourceMessageIds: [] as string[],
  };
  return [
    { ...base, id: "mem-coffee", kind: "preference", content: "用户喜欢喝咖啡", keywords: ["咖啡"] },
    { ...base, id: "mem-city", kind: "fact", content: "用户住在北京", keywords: ["北京"] },
    { ...base, id: "mem-cat", kind: "fact", content: "用户养了一只叫团子的猫", keywords: ["团子", "猫"] },
  ];
}

/** 待整理的对话：状态发生了变化。 */
const history: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "跟你说个事，我最近把咖啡戒了" },
  { role: "assistant", content: "诶？怎么突然戒了" },
  { role: "user", content: "胃不太好，医生让少喝，现在改喝茶了，最近迷上白茶" },
  { role: "assistant", content: "那挺好的，白茶养胃一些" },
  { role: "user", content: "对了团子昨天又把我耳机咬坏了" },
];

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }

  const adapter = createOpenAIAdapter({
    config: {
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 90000,
      maxRetries: 1,
      temperature: 0.8,
      maxTokens: 1024,
    },
  });

  const existing = existingMemories();
  const rounds = Number(process.env.PROBE_ROUNDS ?? 2);

  for (let i = 1; i <= rounds; i += 1) {
    const digest = await runDigest({
      adapter,
      history,
      characterName: "苏晚晴",
      characterId: "char-su-wanqing",
      existingMemories: existing.map((m) => m.content),
      model: MODEL,
      timeoutMs: 90000,
    });

    if (!digest) {
      console.log(`#${i} 整理返回 null（解析失败或调用失败）`);
      continue;
    }

    console.log(`\n===== 第 ${i} 次整理 =====`);
    for (const draft of digest.memories) {
      console.log(
        `  [${draft.kind}] ${draft.content}` +
          (draft.supersedes ? `  ← supersedes: "${draft.supersedes}"` : ""),
      );
    }

    const merged = mergeMemories({
      characterId: "char-su-wanqing",
      existing,
      drafts: digest.memories,
      now: NOW,
    });
    const coffeeStillThere = merged.some((m) => m.content === "用户喜欢喝咖啡");
    const hasTea = merged.some((m) => /茶/.test(m.content));
    console.log(
      `  合并后共 ${merged.length} 条；旧"喜欢喝咖啡"是否还在=${coffeeStillThere}；` +
        `是否记住喝茶=${hasTea}`,
    );
    console.log(`  最终列表：`);
    for (const m of merged) console.log(`    - ${m.content}`);
  }
}

void main();
