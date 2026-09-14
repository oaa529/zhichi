/**
 * @file agnes_window_flip_probe.mts
 * 真机验证：**同一个整理窗口里改口**，模型会不会把新旧两种说法都留下。
 *
 * 为什么单独测：整理窗口最多 60 条，跨度常常覆盖"用户先说不能吃辣、
 * 过一会儿又说最近能吃点辣了"。这时没有【已知的长期记忆】可 supersedes，
 * 全靠模型自己只输出**最新**的那条。
 *
 * 如果两条都被写进记忆库，检索就可能捞到旧的那条，
 * 角色于是纠正用户——"你不是不吃辣吗"。
 *
 * 判定：
 * - 旧说法（不吃辣/不能吃辣/闻到辣椒）与
 * - 新说法（能吃微辣/现在能/胃养好了）
 * 是否**同时**出现在产出的记忆里。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_window_flip_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { runDigest, mergeMemories } from "../packages/core/src/memory/MemoryDigest";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 一个窗口内先说不能吃辣、后面改口——中间夹着别的闲聊。 */
const HISTORY: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "今天食堂的菜都放辣椒了，我只能挑着吃" },
  { role: "assistant", content: "你不是一点辣都吃不了吗" },
  { role: "user", content: "对，我不吃辣，闻到辣椒就难受" },
  { role: "assistant", content: "那以后点菜都给你说不要辣" },
  { role: "user", content: "这周我把作息调过来了，早睡早起感觉挺好" },
  { role: "assistant", content: "那气色肯定不一样" },
  { role: "user", content: "对了，中药喝了两周，医生说胃养得差不多了" },
  { role: "assistant", content: "那挺不容易的" },
  {
    role: "user",
    content: "今天试了下微辣的麻辣烫，居然没事，我现在能吃一点辣了",
  },
  { role: "assistant", content: "那也别一下子吃太猛" },
  { role: "user", content: "嗯，太辣还是受不了，微辣就行" },
];

const OLD_CLAIM = /不吃辣|不能吃辣|闻到辣椒|一点辣都吃不了/;
const NEW_CLAIM = /能吃|可以吃|微辣|养好|调理好/;

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

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("缺少 AGNES_API_KEY，跳过真机验证。");
    return;
  }
  console.log(`模型=${MODEL}｜同一窗口内改口：只该留最新那条`);

  const digest = await runDigest({
    adapter: makeAdapter(),
    history: HISTORY,
    characterName: "苏晚晴",
    characterId: "char-su-wanqing",
    userName: "用户",
    existingMemories: [],
    model: MODEL,
    maxTokens: 1200,
    timeoutMs: 180_000,
    onFailure: (reason) => console.log(`  ⚠️ 整理失败：${reason}`),
  });
  if (!digest) {
    console.log("整理没拿到结果，结束。");
    return;
  }

  const memories = mergeMemories({
    characterId: "char-su-wanqing",
    existing: [],
    drafts: digest.memories,
    sourceMessageIds: HISTORY.map((_, index) => `m-${index}`),
    now: Date.UTC(2026, 8, 13, 12, 41),
  });

  console.log(`\n整理出 ${memories.length} 条记忆：`);
  for (const memory of memories) console.log(`  · ${memory.content}`);

  /**
   * "旧说法残留"= 某条记忆只讲旧状态，**没提**最新状态。
   *
   * 判定器第一版写成了"含旧说法 && 含新说法"就报警，结果把
   * 「用户原先一点辣都吃不了，最近开始能吃微辣了」这种**正确记录变化**
   * 的条目也算成并存（连续两轮误报）。评估清单/判定器本身也要审——
   * 这类教训在 `agnes_digest_quality_probe` 里已经吃过一次。
   */
  const staleKept = memories.filter(
    (memory) => OLD_CLAIM.test(memory.content) && !NEW_CLAIM.test(memory.content),
  );
  const newKept = memories.filter((memory) => NEW_CLAIM.test(memory.content));
  const coexists = staleKept.length > 0 && newKept.length > 0;

  console.log(
    `\n最新说法 ${newKept.length} 条｜只讲旧状态的残留 ${staleKept.length} 条｜` +
      `新旧并存：${coexists ? "是（可能拿旧状态纠正用户）" : "否"}`,
  );
}

await main();
