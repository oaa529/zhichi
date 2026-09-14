/**
 * @file agnes_plot_accumulation_probe.mts
 * 真机验证：**剧情时间线与线索卡在长会话里的自动累积会不会失真**。
 *
 * 四个整理轮次，故意让"线索了结"发生：
 * - R1 约好周六去看摄影展（线索：看展）
 * - R2 闲聊 + 用户提到下周要交报告（线索：报告）
 * - R3 周六看展结束（"看展"这条线索**该被删掉**）
 * - R4 报告交掉了（"报告"这条线索**该被删掉**）
 *
 * 每轮都把上一轮的整张卡传给整理（产品就是这么做的：整卡维护），
 * 然后 `applyDigest` 合并。逐轮统计：
 * - 未解线索：了结之后还挂着几条（陈旧线索）
 * - 时间线：新增了几条、有没有重复（相似度 ≥ 0.8 算重复）
 * - 状态卡：章节/场景/地点有没有被维护
 * - 噪声：事件里有多少是"日常琐事"而不是剧情推进
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_plot_accumulation_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { IPlotState } from "@wechat-rp/shared-types";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { runDigest } from "../packages/core/src/memory/MemoryDigest";
import { applyDigest } from "../packages/core/src/plot/PlotKeeper";
import { bigramSimilarity } from "../packages/core/src/memory/MemoryRetriever";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 四轮对话：每轮 4~6 条，都带一点剧情推进。 */
const ROUNDS: ReadonlyArray<{
  readonly label: string;
  readonly history: ReadonlyArray<ILLMMessage>;
}> = [
  {
    label: "R1 约好看展",
    history: [
      { role: "user", content: "周六那个摄影展你还去吗" },
      { role: "assistant", content: "去啊，我一直想看那个" },
      { role: "user", content: "那我们十点在门口见，票我来买" },
      { role: "assistant", content: "好，十点见" },
    ],
  },
  {
    label: "R2 用户提到报告",
    history: [
      { role: "user", content: "今天上班累死了，明天还得接着弄" },
      { role: "assistant", content: "怎么了" },
      { role: "user", content: "下周要交一份季度报告，今天才写了个开头" },
      { role: "assistant", content: "那这周得挤点时间了" },
      { role: "user", content: "晚上想吃点好的犒劳自己，点了份炸鸡" },
    ],
  },
  {
    label: "R3 看展结束",
    history: [
      { role: "user", content: "展看完了，比想象中好看" },
      { role: "assistant", content: "我就说值得跑一趟吧" },
      { role: "user", content: "那张海边的照片我站那儿看了好久" },
      { role: "assistant", content: "下次还有别的展我们再去" },
    ],
  },
  {
    label: "R4 报告交掉",
    history: [
      { role: "user", content: "报告终于交了，整个人都空了" },
      { role: "assistant", content: "辛苦啦，今晚早点睡" },
      { role: "user", content: "嗯，明天想请假在家躺一天" },
    ],
  },
];

/** 明显属于日常琐事、不该进时间线的词。 */
const NOISE_PATTERN = /炸鸡|奶茶|天气|外卖|地铁|键盘|电影|零食/;

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
  console.log(`模型=${MODEL}｜四轮整理，看线索会不会积灰、事件会不会灌水`);

  let state: IPlotState | null = null;
  let previousEventCount = 0;
  let duplicateEvents = 0;
  const noiseEvents: string[] = [];

  for (const [index, round] of ROUNDS.entries()) {
    console.log(`\n===== ${round.label} =====`);
    const digest = await runDigest({
      adapter: makeAdapter(),
      history: round.history,
      characterName: "苏晚晴",
      characterId: "char-su-wanqing",
      userName: "用户",
      existingMemories: [],
      currentPlot: state,
      model: MODEL,
      maxTokens: 1200,
      timeoutMs: 180_000,
      onFailure: (reason) => console.log(`  ⚠️ 整理失败：${reason}`),
    });
    if (!digest) {
      console.log("  本轮整理没结果，跳过。");
      continue;
    }

    console.log(
      `  模型给的卡：章节=${digest.plot.chapter ?? "(省)"}｜场景=${digest.plot.scene ?? "(省)"}｜` +
        `地点=${digest.plot.location ?? "(省)"}｜线索=${(digest.plot.openThreads ?? []).join("、") || "(无)"}`,
    );
    console.log(
      `  模型给的事件：${digest.events.map((event) => event.summary).join("｜") || "(无)"}`,
    );
    console.log(
      `  模型给的记忆：${digest.memories.map((memory) => memory.content).join("｜") || "(无)"}`,
    );

    const before = state?.events ?? [];
    state = applyDigest({
      sessionId: "s1",
      state,
      digest,
      sourceMessageIds: round.history.map((_, i) => `r${index}-${i}`),
      now: Date.UTC(2026, 8, 13 + index, 12, 41),
    });

    // 新增的事件里有没有噪声、有没有跟旧事件重复
    const added = state.events.slice(previousEventCount);
    for (const event of added) {
      if (NOISE_PATTERN.test(event.summary)) noiseEvents.push(event.summary);
      const nearDuplicate = before.some(
        (old) => bigramSimilarity(old.summary, event.summary) >= 0.8,
      );
      if (nearDuplicate) duplicateEvents += 1;
    }
    previousEventCount = state.events.length;

    console.log(`  合并后线索：${state.openThreads.join("、") || "(无)"}`);
    console.log(
      `  时间线共 ${state.events.length} 条（本轮新增 ${added.length}）｜` +
        `章节=${state.chapter || "(空)"}｜场景=${state.scene || "(空)"}`,
    );
  }

  console.log("\n===== 汇总 =====");
  const threads = state?.openThreads ?? [];
  /**
   * 陈旧线索 = 已经了结的事还挂在卡上。
   *
   * 判定要排除"下次再约"这类**新的**线索：第一版用 /展|报告/ 一律算陈旧，
   * 结果把"下次摄影展的约定"（R3 里新产生的合理线索）也算进去了。
   */
  const staleThreads = threads.filter((thread) =>
    /参观|实际|看展完成|报告提交|交报告/.test(thread),
  );
  console.log(
    `最终线索：${threads.join("、") || "(无)"}｜` +
      `陈旧线索（已了结的事还挂着）：${staleThreads.length} 条` +
      (staleThreads.length > 0 ? `（${staleThreads.join("、")}）` : ""),
  );
  console.log(
    `时间线 ${state?.events.length ?? 0} 条｜重复事件 ${duplicateEvents} 条｜噪声事件 ${noiseEvents.length} 条` +
      (noiseEvents.length > 0 ? `（${noiseEvents.join("；")}）` : ""),
  );
  for (const event of state?.events ?? []) {
    console.log(`  · ${event.summary}`);
  }
}

await main();
