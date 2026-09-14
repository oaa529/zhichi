/**
 * @file OpenAIAdapter.ts
 * OpenAI 兼容 LLM 适配器实现。
 *
 * 支持所有 OpenAI 兼容端点（OpenAI/Azure/Kimi/DeepSeek/通义千问等）。
 *
 * 实现：
 * - 用 fetch 调用 /chat/completions（stream: true）
 * - 解析 SSE 流（data: 行，[DONE] 结束）
 * - 提取 choices[0].delta.content 增量
 * - 超时控制：**空闲超时**（多久没有新数据）。此前的 `AbortSignal.timeout`
 *   是整条请求的总时限，慢一点的供应商会把一条写到一半的正常回复掐断；
 *   真人不会因为你打字慢就把话咽回去，所以只要还在出字就继续等。
 * - 错误分类为 LLMError（network/server-error/client-error/timeout/aborted/rate-limit）
 *
 * 不负责重试逻辑（由 RealismEngine 的 streamWithRetry 编排）。
 */

import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";

import type { ILLMAdapter, ILLMAdapterFactoryOptions, IConnectionTestResult } from "./LLMAdapter";
import type { ILLMAbortHandle, ILLMConfigInternal, ILLMRequest } from "./types";
import { LLMError } from "./types";
import { mergeAbortSignals } from "./abort";

/**
 * OpenAI 兼容适配器。
 */
export class OpenAIAdapter implements ILLMAdapter {
  private readonly config: ILLMConfigInternal;

  constructor(opts: ILLMAdapterFactoryOptions) {
    this.config = opts.config;
  }

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    signal: AbortSignal,
  ): ILLMAbortHandle {
    const idleMs = this.config.timeoutMs;

    /**
     * 空闲看门狗。
     *
     * 计时器在"每次收到数据"后重新计时：连接阶段也算等待（首字节超时），
     * 但只要还有新的 SSE 数据进来，这条请求就有权继续跑下去。
     */
    const watchdog = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleFired = false;

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        watchdog.abort();
      }, idleMs);
    };
    const disarmIdle = (): void => {
      if (idleTimer === null) return;
      clearTimeout(idleTimer);
      idleTimer = null;
    };
    armIdle();

    // 合并用户 signal 和看门狗 signal
    const combinedSignal = signal.aborted
      ? signal
      : mergeAbortSignals([signal, watchdog.signal]);

    // 用闭包变量共享状态（stream 方法内部与 doStream 之间）
    let deltaStarted = false;
    let aborted = false;
    let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;

    // 监听 abort
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      disarmIdle();
      try {
        void readerRef?.cancel()?.catch(() => undefined);
      } catch {
        // 忽略 cancel 错误
      }
      // 区分"超时中止"与"用户主动中止"：
      // 前者必须归类为 timeout，交给引擎重试/降级；
      // 若一律当作 aborted，引擎会认为是用户取消而静默返回，导致状态永久停在 streaming。
      const timedOut = idleFired;
      handlers.onError(
        new LLMError(
          timedOut
            ? `模型 ${Math.round(idleMs / 1000)} 秒没有返回任何新内容（超时时间可在设置里调大）`
            : "Stream aborted",
          timedOut ? "timeout" : "aborted",
          undefined,
          deltaStarted,
        ),
      );
    };

    combinedSignal.addEventListener("abort", onAbort, { once: true });

    /**
     * 包一层 handlers：正常收尾（完成/报错）时把看门狗停掉，
     * 否则计时器会活到超时之后才醒（每次请求都漏一个定时器）。
     */
    const wrappedHandlers: ILlmStreamHandlers = {
      onDelta: (delta) => handlers.onDelta(delta),
      onComplete: (fullText) => {
        disarmIdle();
        handlers.onComplete(fullText);
      },
      onError: (error) => {
        disarmIdle();
        handlers.onError(error);
      },
    };

    // 启动 SSE fetch（async IIFE，不阻塞）
    void this.doStream(req, wrappedHandlers, combinedSignal, {
      onDeltaStart: () => {
        deltaStarted = true;
      },
      setReader: (r: ReadableStreamDefaultReader<Uint8Array>) => {
        readerRef = r;
      },
      getDeltaStarted: () => deltaStarted,
      // 收到数据就续命：只要还在出字，就不算超时
      keepAlive: armIdle,
    }).catch((err) => {
      if (aborted) return; // abort 已处理
      disarmIdle();
      wrappedHandlers.onError(
        err instanceof LLMError ? err : new LLMError(String(err), "unknown"),
      );
    });

    return {
      abort: (reason?: string) => {
        if (aborted) return;
        aborted = true;
        disarmIdle();
        try {
          void readerRef?.cancel(reason)?.catch(() => undefined);
        } catch {
          // 忽略
        }
        combinedSignal.removeEventListener("abort", onAbort);
        handlers.onError(new LLMError(reason ?? "User aborted", "aborted", undefined, deltaStarted));
      },
    };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    const startedAt = Date.now();
    const url = `${this.config.baseURL}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: [{ role: "user" as const, content: "ping" }],
      max_tokens: 5,
      stream: false,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 15000)),
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let errorKind: IConnectionTestResult["errorKind"] = "unknown";
        if (response.status === 401 || response.status === 403) errorKind = "auth";
        else if (response.status === 404) errorKind = "not-found";
        else if (response.status === 429) errorKind = "rate-limit";
        else if (response.status >= 500) errorKind = "server";

        return {
          ok: false,
          latencyMs,
          error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
          errorKind,
        };
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const sample = data.choices?.[0]?.message?.content ?? "";

      return {
        ok: true,
        latencyMs,
        sample: sample.slice(0, 20),
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (err instanceof LLMError) {
        return { ok: false, latencyMs, error: err.message, errorKind: "unknown" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("abort");
      return {
        ok: false,
        latencyMs,
        error: msg,
        errorKind: isTimeout ? "timeout" : "network",
      };
    }
  }

  /**
   * 执行 SSE 流式请求。
   */
  private async doStream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    signal: AbortSignal,
    ctx: {
      onDeltaStart: () => void;
      setReader: (r: ReadableStreamDefaultReader<Uint8Array>) => void;
      getDeltaStarted: () => boolean;
      /** 每收到一块数据就调用一次：给空闲看门狗续命。 */
      keepAlive: () => void;
    },
  ): Promise<void> {
    const url = `${this.config.baseURL}/chat/completions`;
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // 网络错误或 abort
      if (signal.aborted) {
        throw new LLMError("Request aborted", "aborted", undefined, false);
      }
      throw new LLMError(`Network error: ${String(err)}`, "network");
    }

    // HTTP 状态码检查
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const statusCode = response.status;

      let kind: LLMError["kind"] = "unknown";
      if (statusCode === 429) kind = "rate-limit";
      else if (statusCode >= 500) kind = "server-error";
      else if (statusCode >= 400) kind = "client-error";

      throw new LLMError(
        `HTTP ${statusCode}: ${errorBody.slice(0, 200)}`,
        kind,
        statusCode,
        false,
      );
    }

    // 检查 response.body
    if (!response.body) {
      throw new LLMError("Response body is null", "unknown", undefined, false);
    }

    // SSE 流解析
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    ctx.setReader(reader);

    let buffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 还在出数据 → 重新计时（空闲超时，不是总超时）
        ctx.keepAlive();

        buffer += decoder.decode(value, { stream: true });

        // 按行解析 SSE
        const lines = buffer.split("\n");
        // 保留最后一行（可能不完整）
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (trimmed.startsWith(":")) continue; // SSE 注释
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            handlers.onComplete(fullText);
            return;
          }

          try {
            const json = JSON.parse(data) as OpenAIStreamChunk;
            const delta = json.choices?.[0]?.delta?.content;
            if (delta && typeof delta === "string" && delta.length > 0) {
              if (!ctx.getDeltaStarted()) {
                ctx.onDeltaStart();
              }
              fullText += delta;
              handlers.onDelta(delta);
            }
          } catch {
            // JSON 解析失败，跳过此行
          }
        }
      }

      // 流结束但没收到 [DONE]，也视为完成
      handlers.onComplete(fullText);
    } catch (err) {
      if (signal.aborted) {
        throw new LLMError("Stream aborted during reading", "aborted", undefined, ctx.getDeltaStarted());
      }
      throw new LLMError(`Stream read error: ${String(err)}`, "network", undefined, ctx.getDeltaStarted());
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 忽略
      }
    }
  }
}

/** OpenAI SSE 流的单个 chunk JSON 结构（部分字段）。 */
interface OpenAIStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string };
    readonly finish_reason?: string | null;
  }>;
}

/**
 * 创建 OpenAI 适配器实例。
 */
export function createOpenAIAdapter(opts: ILLMAdapterFactoryOptions): OpenAIAdapter {
  return new OpenAIAdapter(opts);
}
