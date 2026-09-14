/**
 * @file agnes_plot_card_probe.mts
 * 真机验证：**未解线索会不会被后台整理抹掉**。
 *
 * 怀疑点（读代码时发现）：
 * - `buildDigestPrompt` 只把【已知的长期记忆】发给模型，**没有发当前状态卡**；
 * - `applyDigest` 对 openThreads 是**整组替换**（`patch.openThreads ?? base.openThreads`）。
 *
 * 两者合起来意味着：模型只根据**这一段对话**写 openThreads，
 * 于是"这段时间没提到、但还没了结"的线索会被静默清空。
 *
 * 场景设计：
 * - 现有状态卡里有两条线索：「周六的展还没定下来」「说好要送的摄影集还没送出去」
 * - 待整理的这段对话里，展**去了、结束了**，摄影集**一个字都没提**
 * - 正确结果：展那条该删掉，摄影集那条必须留着
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_plot_card_probe.mts
 *   $env:WITH_CARD="1"   # 用"把当前状态卡一起发过去"的新版提示词
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { IPlotState } from "@wechat-rp/shared-types";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { buildDigestPrompt, parseDigest, runDigest } from "../packages/core/src/memory/MemoryDigest";
import { applyDigest } from "../packages/core/src/plot/PlotKeeper";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 2);

const NOW = Date.now();

/** 最近一次请求的原始输出（解析失败时看它到底回了什么）。 */
let lastRaw = "";

/** 包一层适配器，把原始输出抄一份下来。 */
function withCapture(inner: ReturnType<typeof createOpenAIAdapter>) {
  return {
    stream: (
      req: Parameters<typeof inner.stream>[0],
      handlers: Parameters<typeof inner.stream>[1],
      signal: AbortSignal,
    ) =>
      inner.stream(
        req,
        {
          ...handlers,
          onComplete: (fullText: string) => {
            lastRaw = fullText;
            handlers.onComplete(fullText);
          },
        },
        signal,
      ),
    testConnection: () => inner.testConnection(),
  };
}

/** 现有状态卡：两条未解线索。 */
const CURRENT: IPlotState = {
  sessionId: "s1",
  chapter: "第二章",
  scene: "和好之后的周末",
  timeLabel: "周六下午",
  location: "市美术馆",
  relations: [{ characterId: "char-su-wanqing", label: "关系缓和" }],
  openThreads: ["周六的展还没定下来", "说好要送的摄影集还没送出去"],
  synopsis: "两人和好，约了周六看展。",
  events: [],
  history: [],
  updatedAt: NOW,
};

/** 待整理的对话：展去了、结束了；摄影集完全没提。 */
const HISTORY: ReadonlyArray<ILLMMessage> = [
  { role: "user", content: "我到了，在门口等你" },
  { role: "assistant", content: "马上到，刚停好车" },
  { role: "user", content: "这个展比想象中好看，那组海边的照片我站了很久" },
  { role: "assistant", content: "我也是，尤其是最后那间暗房" },
  { role: "user", content: "下次有这种展还叫我" },
  { role: "assistant", content: "好，看到合适的就告诉你" },
];

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const withCard = (process.env.WITH_CARD ?? "").trim() === "1";
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
  const capturing = withCapture(adapter);

  const prompt = buildDigestPrompt(
    HISTORY,
    "苏晚晴",
    "char-su-wanqing",
    "用户",
    [],
    withCard ? CURRENT : undefined,
  );
  console.log(`提示词里带了当前状态卡：${prompt.user.includes("周六的展还没定下来") ? "是" : "否"}`);

  for (let round = 1; round <= ROUNDS; round += 1) {
    let digest = null;
    try {
      lastRaw = "";
      digest = await runDigest({
        adapter: capturing,
        history: HISTORY,
        characterName: "苏晚晴",
        characterId: "char-su-wanqing",
        existingMemories: [],
        currentPlot: withCard ? CURRENT : undefined,
        model: MODEL,
        // 与产品一致：整理需要更多输出预算（维护整张状态卡会更长）
        maxTokens: 2048,
        timeoutMs: 120_000,
        signal: new AbortController().signal,
      });
    } catch (error) {
      console.log(`#${round} 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    if (!digest) {
      console.log(`#${round} ❌ 解析失败（原始输出 ${lastRaw.length} 字）`);
      console.log("------- 原始输出全文 -------");
      console.log(lastRaw.trim());
      console.log("---------------------------");
      // 打印 JSON.parse 的报错位置与那片字符的码点：
      // 全角引号/零宽字符这类问题在终端里看不出来
      const text = lastRaw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
      try {
        JSON.parse(text);
        console.log("（原文其实能 parse——失败可能在别处）");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const at = Number(/position (\d+)/.exec(message)?.[1] ?? -1);
        console.log(`JSON.parse 报错：${message}`);
        if (at >= 0) {
          const slice = text.slice(Math.max(0, at - 30), at + 30);
          console.log(`出错位置附近：${JSON.stringify(slice)}`);
          console.log(
            `码点：${[...slice].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`,
          );
        }
      }
      continue;
    }

    const next = applyDigest({
      sessionId: "s1",
      state: CURRENT,
      digest,
      sourceMessageIds: ["m-1"],
      now: NOW,
    });
    const threads = next.openThreads;
    const keptGift = threads.some((t) => t.includes("摄影集"));
    const droppedExhibit = !threads.some((t) => t.includes("展"));
    console.log(
      `#${round} ${keptGift && droppedExhibit ? "✅ 符合预期" : "⚠️ 需要人工看"}` +
        `｜整理后线索：${threads.length > 0 ? threads.join("；") : "（空）"}`,
    );
    console.log(`       （模型这一轮给出的 plot.openThreads：${JSON.stringify(digest.plot.openThreads ?? null)}）`);
  }
  void parseDigest;
}

await main();
