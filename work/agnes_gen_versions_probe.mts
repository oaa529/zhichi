/**
 * @file agnes_gen_versions_probe.mts
 * 真机验证：同一个描述生成两版，结果差异有多大？
 *
 * 这直接决定「再生成一版」值不值得——如果两次输出几乎一样，
 * 那多版本只是浪费 token。
 *
 * 用法：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_gen_versions_probe.mts
 */

import {
  buildCharacterGenPrompt,
  parseCharacterGenResult,
  type ICharacterDraft,
} from "../packages/core/src/character/CharacterForge";
import { bigramSimilarity } from "../packages/core/src/memory/MemoryRetriever";
import { OpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

function makeAdapter(): OpenAIAdapter {
  return new OpenAIAdapter({
    config: {
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 150_000,
      maxRetries: 1,
      temperature: 0.9,
      maxTokens: 1600,
    },
  });
}

async function generate(description: string): Promise<ICharacterDraft> {
  const prompt = buildCharacterGenPrompt(description);
  const adapter = makeAdapter();
  const fullText = await new Promise<string>((resolve, reject) => {
    adapter.stream(
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        model: MODEL,
        maxTokens: 1600,
        temperature: 0.9,
      },
      {
        onDelta: () => {},
        onComplete: (text) => resolve(text),
        onError: (error) => reject(new Error(String(error))),
        onAbort: () => reject(new Error("aborted")),
      },
      new AbortController().signal,
    );
  });
  const draft = parseCharacterGenResult(fullText);
  if (!draft) throw new Error("解析失败");
  return draft;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const description = "高中同桌，傲娇但细心，喜欢猫";
  console.log(`描述：${description}\n`);

  const startedAt = Date.now();
  const first = await generate(description);
  const firstMs = Date.now() - startedAt;
  console.log(`第一版（${firstMs}ms）：${first.displayName}｜${first.bio}`);
  console.log(`  背景：${first.background.slice(0, 60)}`);

  const secondStart = Date.now();
  const second = await generate(description);
  const secondMs = Date.now() - secondStart;
  console.log(`\n第二版（${secondMs}ms）：${second.displayName}｜${second.bio}`);
  console.log(`  背景：${second.background.slice(0, 60)}`);

  const similarity = bigramSimilarity(
    `${first.background}${first.personality}`,
    `${second.background}${second.personality}`,
  );
  console.log(
    `\n两版相似度：${(similarity * 100).toFixed(1)}%` +
      `　名字：${first.displayName} vs ${second.displayName}`,
  );
  console.log(
    similarity < 0.6
      ? "\n✅ 两版差异明显——「再生成一版」确实能挑到不同的人设"
      : "\n⚠ 两版差别不大，多生成的意义有限（可考虑调高 temperature）",
  );
}

await main();
