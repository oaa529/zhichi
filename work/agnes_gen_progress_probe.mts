/**
 * @file agnes_gen_progress_probe.mts
 * 真机验证：角色生成的"进度提示"是否真的能跑起来。
 *
 * 界面上的进度是这么来的：流式输出累积 → 节流上报 → 用 extractDraftName
 * 从半截 JSON 里读出角色名。这里用真实模型复现同一条链路，
 * 打印每次上报的内容，确认「正在生成「XX」…已接收 N 字」不会一直空着。
 *
 * 用法：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_gen_progress_probe.mts
 */

import {
  buildCharacterGenPrompt,
  extractDraftName,
  parseCharacterGenResult,
} from "../packages/core/src/character/CharacterForge";
import { OpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";

/** 一次进度上报（与界面收到的东西一致）。 */
interface ICharacterGenProgressProbe {
  readonly atMs: number;
  readonly receivedChars: number;
  readonly name: string | null;
}

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 与界面一致的节流间隔。 */
const REPORT_INTERVAL_MS = 200;

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const description = "高中同桌，傲娇但细心，喜欢猫";
  const prompt = buildCharacterGenPrompt(description);
  const adapter = new OpenAIAdapter({
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

  const reports: ICharacterGenProgressProbe[] = [];
  let received = "";
  let lastReportAt = 0;
  const startedAt = Date.now();

  const done = new Promise<string>((resolve, reject) => {
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
        onDelta: (delta) => {
          received += delta;
          const now = Date.now();
          if (now - lastReportAt < REPORT_INTERVAL_MS) return;
          lastReportAt = now;
          reports.push({
            atMs: now - startedAt,
            receivedChars: received.length,
            name: extractDraftName(received),
          });
        },
        onComplete: (fullText) => resolve(fullText),
        onError: (error) => reject(new Error(String(error))),
        onAbort: () => reject(new Error("aborted")),
      },
      new AbortController().signal,
    );
  });

  console.log(`描述：${description}`);
  const fullText = await done;

  console.log(`\n进度上报 ${reports.length} 次（界面每 200ms 刷新一次）：`);
  for (const report of reports) {
    console.log(
      `  +${String(report.atMs).padStart(6)}ms　已接收 ${String(report.receivedChars).padStart(4)} 字　` +
        (report.name ? `名字已出现：「${report.name}」` : "名字还没写出来"),
    );
  }

  const draft = parseCharacterGenResult(fullText);
  const firstNamed = reports.find((report) => report.name);
  console.log(
    `\n名字首次出现在 +${firstNamed ? firstNamed.atMs : "?"}ms` +
      `（总耗时 ${Date.now() - startedAt}ms），最终解析：${draft ? `成功「${draft.displayName}」` : "失败"}`,
  );
  console.log(
    reports.some((report) => report.name)
      ? "\n✅ 进度提示可用（等待期间用户能看到名字与字数在增长）"
      : "\n⚠ 本次名字出现得很晚或没有解析到——进度里会只剩字数",
  );
}

await main();
