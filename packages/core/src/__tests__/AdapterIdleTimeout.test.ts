/**
 * @file AdapterIdleTimeout.test.ts
 * 流式适配器的超时语义：**空闲超时**，不是总超时。
 *
 * 由来：`AbortSignal.timeout(timeoutMs)` 是整条请求的总时限，慢一点的供应商
 * 会把一条写到一半的正常回复掐断（实测：400ms 总超时下，一条 1.2 秒的正常
 * 流在 409ms 被 abort，用户只看到半句话）。改成"只要还在出字就继续等"之后：
 * - 数据断断续续但一直在来 → 必须跑完；
 * - 真的卡住不动 → 到点报 timeout（可重试），交给引擎重试/降级。
 *
 * 这里用受控的 `ReadableStream` 假扮 SSE 端点：时间与分片完全可控，
 * 且不引入 node:http（core 包不依赖 node 类型）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";
import { OpenAIAdapter, createOpenAIAdapter } from "../llm/OpenAIAdapter";
import type { ILLMRequest } from "../llm/types";
import { LLMError } from "../llm/types";

/** 一步分片：等 delayMs 之后吐 data（data 为 undefined 表示"什么都不吐、也不结束"）。 */
interface IStep {
  readonly delayMs: number;
  readonly data?: string;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 假扮一个"直接返回状态码"的端点（错误分支用）。 */
function stubJsonFetch(status: number, body: string): void {
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

/** 用受控流假扮 OpenAI 兼容端点；返回记录调用次数的对象。 */
function stubFetch(steps: ReadonlyArray<IStep>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (
    _url: string,
    init?: { signal?: AbortSignal },
  ): Promise<Response> => {
    state.calls += 1;
    const encoder = new TextEncoder();
    const signal = init?.signal;
    let index = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 真 fetch 在 signal 中止时会让流报错——这里照做，
        // 否则 wait 中的 read 会被 cancel 变成"正常结束"，掩盖超时路径
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(Object.assign(new Error("aborted"), {
                name: "AbortError",
              }));
            } catch {
              // 流可能已经关掉了
            }
          },
          { once: true },
        );
      },
      async pull(controller) {
        const step = steps[index];
        index += 1;
        if (!step) {
          // 没有更多数据也不结束：一直挂着，模拟"卡住不动"
          await new Promise(() => {});
          return;
        }
        if (step.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
        if (step.data !== undefined) {
          controller.enqueue(encoder.encode(step.data));
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }) as typeof fetch;

  return state;
}

/** 收集一次流式请求的结果。 */
function collect(): {
  handlers: ILlmStreamHandlers;
  done: Promise<{ text: string | null; error: LLMError | null }>;
} {
  let settle: (value: { text: string | null; error: LLMError | null }) => void;
  const done = new Promise<{ text: string | null; error: LLMError | null }>(
    (resolve) => {
      settle = resolve;
    },
  );
  return {
    done,
    handlers: {
      onDelta: () => {},
      onComplete: (fullText) => settle({ text: fullText, error: null }),
      onError: (error) =>
        settle({ text: null, error: error instanceof LLMError ? error : null }),
    },
  };
}

const request: ILLMRequest = {
  messages: [{ role: "user", content: "在吗" }],
  model: "test-model",
  maxTokens: 64,
  temperature: 0.8,
};

/** 把一段文本包成 SSE 分片。 */
function sse(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, index: 0 }],
  })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

/** 按给定的超时时间造一个适配器。 */
function makeAdapter(timeoutMs: number): OpenAIAdapter {
  const config = {
    adapter: "openai" as const,
    baseURL: "http://127.0.0.1:1",
    apiKey: "test",
    model: "test-model",
    timeoutMs,
    maxRetries: 0,
    temperature: 0.8,
    maxTokens: 64,
  };
  return timeoutMs === 400
    ? (createOpenAIAdapter({ config }) as OpenAIAdapter)
    : new OpenAIAdapter({ config });
}

describe("OpenAIAdapter · 空闲超时", () => {
  it("慢但在出字：总耗时远超超时时间，也必须跑完", async () => {
    stubFetch([
      { delayMs: 250, data: sse("今天") },
      { delayMs: 250, data: sse("食堂") },
      { delayMs: 250, data: sse("的排骨") },
      { delayMs: 250, data: sse("还不错") },
      { delayMs: 10, data: DONE },
    ]);
    const adapter = makeAdapter(400);
    const { handlers, done } = collect();

    adapter.stream(request, handlers, new AbortController().signal);
    const result = await done;

    // 总耗时约 1 秒 > 400ms，但每一片之间都 < 400ms → 不该被掐断
    expect(result.error).toBeNull();
    expect(result.text).toBe("今天食堂的排骨还不错");
  });

  it("真的卡住不动：到点报 timeout，已经出过字就不算可重试", async () => {
    stubFetch([{ delayMs: 20, data: sse("我先说一句") }]);
    const adapter = makeAdapter(300);
    const { handlers, done } = collect();

    adapter.stream(request, handlers, new AbortController().signal);
    const result = await done;

    expect(result.text).toBeNull();
    expect(result.error?.kind).toBe("timeout");
    expect(result.error?.message).toContain("没有返回任何新内容");
    // 已经交付过部分正文 → 不能再重试（否则用户会看到重复的话）
    expect(result.error?.deltaStarted).toBe(true);
    expect(result.error?.retryable).toBe(false);
  });

  it("连首字节都不来：同样按 timeout 处理（连接阶段也在计时）", async () => {
    stubFetch([{ delayMs: 0 }]);
    const adapter = makeAdapter(250);
    const { handlers, done } = collect();

    adapter.stream(request, handlers, new AbortController().signal);
    const result = await done;

    expect(result.error?.kind).toBe("timeout");
    // 还没开始出字 → 属于可重试的失败，引擎会自己再试
    expect(result.error?.deltaStarted).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });

  it("正常跑完的请求不会留下看门狗（不会迟到地误报超时）", async () => {
    stubFetch([{ delayMs: 10, data: sse("好") }, { delayMs: 10, data: DONE }]);
    const adapter = makeAdapter(120);
    const { handlers, done } = collect();

    const errors: unknown[] = [];
    const guarded: ILlmStreamHandlers = {
      ...handlers,
      onError: (error) => {
        errors.push(error);
        handlers.onError(error);
      },
    };

    adapter.stream(request, guarded, new AbortController().signal);
    expect((await done).text).toBe("好");

    // 等过超时时间：如果看门狗没被清掉，这里会多出一个 timeout
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors).toHaveLength(0);
  });

  it("HTTP 500 归类为 server-error（可重试）", async () => {
    stubJsonFetch(500, '{"error":"boom"}');
    const adapter = makeAdapter(3000);
    const { handlers, done } = collect();

    adapter.stream(request, handlers, new AbortController().signal);
    const result = await done;

    expect(result.error?.kind).toBe("server-error");
    expect(result.error?.statusCode).toBe(500);
    expect(result.error?.retryable).toBe(true);
  });

  it("HTTP 429 归类为 rate-limit；4xx 客户端错误不重试", async () => {
    stubJsonFetch(429, '{"error":"slow down"}');
    const adapter = makeAdapter(3000);
    const first = collect();
    adapter.stream(request, first.handlers, new AbortController().signal);
    expect((await first.done).error?.kind).toBe("rate-limit");

    stubJsonFetch(401, '{"error":"bad key"}');
    const second = collect();
    adapter.stream(request, second.handlers, new AbortController().signal);
    const unauthorized = await second.done;
    expect(unauthorized.error?.kind).toBe("client-error");
    expect(unauthorized.error?.retryable).toBe(false);
  });

  it("用户主动中止：归类为 aborted，不是 timeout", async () => {
    stubFetch([{ delayMs: 5, data: sse("说了一半") }]);
    const adapter = makeAdapter(3000);
    const { handlers, done } = collect();
    const controller = new AbortController();

    const handle = adapter.stream(request, handlers, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.abort("用户点了停止");

    const result = await done;
    expect(result.error?.kind).toBe("aborted");
    expect(result.error?.message).toContain("用户点了停止");
  });
});

describe("OpenAIAdapter · 连接测试", () => {
  it("成功时返回延迟与样例文本", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "pong 好的" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await makeAdapter(3000).testConnection();

    expect(result.ok).toBe(true);
    expect(result.sample).toBe("pong 好的");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("401 归类为 auth，404 归类为 not-found", async () => {
    stubJsonFetch(401, '{"error":"bad key"}');
    expect((await makeAdapter(3000).testConnection()).errorKind).toBe("auth");

    stubJsonFetch(404, '{"error":"no model"}');
    expect((await makeAdapter(3000).testConnection()).errorKind).toBe(
      "not-found",
    );
  });

  it("网络异常归类为 network，不抛到调用方", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const result = await makeAdapter(3000).testConnection();

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("network");
  });
});
