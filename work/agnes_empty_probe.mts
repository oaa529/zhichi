/**
 * @file agnes_empty_probe.mts
 * 诊断：Agnes 是否会返回"空内容"，以及空回复时 finish_reason 是什么。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> work/agnes_empty_probe.mts
 */

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

interface IChoice {
  readonly finish_reason?: string;
  readonly message?: { readonly content?: string | null; readonly reasoning_content?: string };
}

async function oneCall(index: number, prompt: string): Promise<void> {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "你是苏晚晴，说话简短口语化。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 200,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const text = await response.text();
    const ms = Date.now() - started;
    if (!response.ok) {
      console.log(`#${index} HTTP ${response.status} (${ms}ms) ${text.slice(0, 160)}`);
      return;
    }
    const data = JSON.parse(text) as { choices?: IChoice[]; usage?: unknown };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content ?? "";
    console.log(
      `#${index} (${ms}ms) finish=${choice?.finish_reason} ` +
        `content长度=${content.length} reasoning长度=${reasoning.length} ` +
        `内容="${content.replace(/\s+/g, " ").slice(0, 60)}"`,
    );
  } catch (error) {
    console.log(`#${index} 异常: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  const prompts = [
    "晚上一起吃饭吧，我想吃宫保鸡丁",
    "今天好累啊",
    "在吗",
    "推荐一部电影",
    "你觉得我该早点睡吗",
    "周末去哪玩好",
  ];
  for (let i = 0; i < prompts.length; i += 1) {
    await oneCall(i + 1, prompts[i]!);
  }
}

void main();
