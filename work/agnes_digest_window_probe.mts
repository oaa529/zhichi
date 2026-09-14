/**
 * @file agnes_digest_window_probe.mts
 * 真机验证：**一整窗（60 条）对话仍能被正确整理**。
 *
 * 背景：`digestRunner` 的整理窗口从"永远取最后 60 条"改成了
 * "从游标开始取 60 条"（积压时一批批吃，不再跳过中间内容）。
 * 窗口一旦真的装满 60 条，输入长度是以前的 2~3 倍——
 * 这里用真机确认模型在这种长度下**仍然只输出 JSON、且能解析**。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_digest_window_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { buildDigestPrompt, parseDigest, runDigest } from "../packages/core/src/memory/MemoryDigest";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 编一段 60 条、信息密度接近真实聊天的对话。 */
function buildHistory(): ReadonlyArray<ILLMMessage> {
  const history: ILLMMessage[] = [];
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["我下周要去杭州出差三天", "那边最近降温，记得带件外套"],
    ["我妈下个月生日，我在想要送什么", "她喜欢什么呀"],
    ["她喜欢养花，阳台上摆了一排", "那送个好看的花盆？"],
    ["我们部门新来了个实习生", "带新人累不累"],
    ["团团最近学会开柜子了", "哈哈那猫粮要藏好"],
    ["我最近开始晨跑，六点半出门", "坚持住，前两周最难"],
    ["上周把《海边的卡夫卡》看完了", "结局你满意吗"],
    ["我下决心报了个吉他班", "什么时间上课"],
    ["周三晚上七点，在公司附近", "那正好下班顺路"],
    ["我答应过你要少熬夜的", "嗯，我记着呢"],
  ];
  for (let round = 0; round < 5; round += 1) {
    for (const [user, assistant] of facts) {
      history.push({ role: "user", content: user });
      history.push({ role: "assistant", content: assistant });
    }
  }
  return history.slice(0, 60);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const history = buildHistory();
  const prompt = buildDigestPrompt(history, "苏晚晴", "char-su-wanqing");
  console.log(`窗口消息数：${history.length}`);
  console.log(`user 段字符数：${prompt.user.length}`);

  const adapter = createOpenAIAdapter({
    config: {
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 120_000,
      maxRetries: 1,
      temperature: 0.8,
      maxTokens: 1500,
    },
  });

  const started = Date.now();
  const digest = await runDigest({
    adapter,
    history,
    characterName: "苏晚晴",
    characterId: "char-su-wanqing",
    model: MODEL,
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  });
  console.log(`耗时：${Math.round((Date.now() - started) / 1000)}s`);

  if (!digest) {
    console.error("❌ 解析失败：模型没有给出可解析的 JSON");
    process.exit(1);
  }

  console.log(`✅ 解析成功：记忆 ${digest.memories.length} 条、事件 ${digest.events.length} 条`);
  for (const memory of digest.memories) {
    console.log(`  [${memory.kind}] ${memory.content}（重要度 ${memory.importance}）`);
  }
  for (const event of digest.events) {
    console.log(`  · ${event.summary}`);
  }
  if (digest.plot?.synopsis) console.log(`  剧情：${digest.plot.synopsis}`);
  void parseDigest;
}

await main();
