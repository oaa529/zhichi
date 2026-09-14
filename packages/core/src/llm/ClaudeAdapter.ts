/**
 * @file ClaudeAdapter.ts
 * Anthropic Claude LLM 适配器骨架实现。
 *
 * Claude 的 API 协议与 OpenAI 不同：
 * - 端点：/v1/messages（非 /chat/completions）
 * - 消息格式：system 是顶层字段，非 messages 数组内
 * - SSE 事件：message_start / content_block_start / content_block_delta / message_stop
 * - delta 提取：content_block_delta.delta.text
 *
 * 本文件实现完整协议解析，但 SDK 调用预留（实际接入时替换 fetch 逻辑）。
 */

import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";

import type { ILLMAdapter, ILLMAdapterFactoryOptions, IConnectionTestResult } from "./LLMAdapter";
import type { ILLMAbortHandle, ILLMConfigInternal, ILLMRequest } from "./types";
import type { ILLMMessage } from "./types";
import { LLMError } from "./types";
import { mergeAbortSignals } from "./abort";

/**
 * 把内部消息列表翻译成 Anthropic /v1/messages 的请求体。
 *
 * Claude 的 system 是**顶层单字段**，而我们的消息列表可能有多条 system
 * （角色卡在最前、上下文摘要或"记得的事"在中间/末尾）。旧实现用
 * `find()` 只取第一条，其余 system 消息被静默丢弃——实测后果是上下文被
 * 裁剪后生成的「前情提要」摘要根本进不了请求。这里改为按顺序合并全部
 * system 内容，用空行拼接，保证一条都不丢。
 *
 * @param stream 是否开启流式
 */
export function buildClaudeRequestBody(
  req: ILLMRequest,
  stream: boolean,
): {
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly stream: boolean;
} {
  const systemText = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");

  const messages = req.messages
    .filter((m: ILLMMessage) => m.role !== "system")
    .map((m: ILLMMessage) => ({ role: m.role, content: m.content }));

  return {
    model: req.model,
    system: systemText,
    messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stream,
  };
}

/**
 * Claude 适配器（骨架，协议已实现，预留 SDK 接入）。
 */
export class ClaudeAdapter implements ILLMAdapter {
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

    // 空闲看门狗：与 OpenAIAdapter 同一套语义——只要还在出字就不算超时，
    // 避免"总时限"把一条写到一半的正常回复掐断。
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

    const combinedSignal = signal.aborted
      ? signal
      : mergeAbortSignals([signal, watchdog.signal]);

    let deltaStarted = false;
    let aborted = false;
    let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      disarmIdle();
      try {
        readerRef?.cancel();
      } catch {
        // 忽略
      }
      // 超时与"用户主动中止"必须分开：前者要交给引擎重试/降级，
      // 归成 aborted 会被当成用户取消而静默返回（状态卡在 streaming）。
      handlers.onError(
        new LLMError(
          idleFired
            ? `模型 ${Math.round(idleMs / 1000)} 秒没有返回任何新内容（超时时间可在设置里调大）`
            : "Stream aborted",
          idleFired ? "timeout" : "aborted",
          undefined,
          deltaStarted,
        ),
      );
    };

    combinedSignal.addEventListener("abort", onAbort, { once: true });

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

    void this.doStream(req, wrappedHandlers, combinedSignal, {
      onDeltaStart: () => {
        deltaStarted = true;
      },
      setReader: (r: ReadableStreamDefaultReader<Uint8Array>) => {
        readerRef = r;
      },
      getDeltaStarted: () => deltaStarted,
      keepAlive: armIdle,
    }).catch((err) => {
      if (aborted) return;
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
          readerRef?.cancel(reason);
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
    const url = `${this.config.baseURL}/v1/messages`;
    const systemMsg = "You are a helpful assistant. Reply in 3 words max.";
    const body = {
      model: this.config.model,
      max_tokens: 5,
      system: systemMsg,
      messages: [{ role: "user", content: "ping" }],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
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

      const data = await response.json() as {
        content?: Array<{ text?: string }>;
      };
      const sample = data.content?.[0]?.text ?? "";

      return {
        ok: true,
        latencyMs,
        sample: sample.slice(0, 20),
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
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
   * 执行 Claude SSE 流式请求。
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
    const url = `${this.config.baseURL}/v1/messages`;

    const body = buildClaudeRequestBody(req, true);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw new LLMError("Request aborted", "aborted", undefined, false);
      }
      throw new LLMError(`Network error: ${String(err)}`, "network");
    }

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

    if (!response.body) {
      throw new LLMError("Response body is null", "unknown", undefined, false);
    }

    // Claude SSE 解析
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    ctx.setReader(reader);

    let buffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        ctx.keepAlive();

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed.startsWith(":")) continue;
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          try {
            const event = JSON.parse(data) as ClaudeStreamEvent;
            const delta = this.extractDelta(event);
            if (delta) {
              if (!ctx.getDeltaStarted()) {
                ctx.onDeltaStart();
              }
              fullText += delta;
              handlers.onDelta(delta);
            }

            // message_stop 事件
            if (event.type === "message_stop") {
              handlers.onComplete(fullText);
              return;
            }
          } catch {
            // JSON 解析失败，跳过
          }
        }
      }

      // 流结束
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

  /**
   * 从 Claude SSE 事件中提取 delta 文本。
   */
  private extractDelta(event: ClaudeStreamEvent): string | null {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return event.delta.text ?? null;
    }
    return null;
  }
}

/** Claude SSE 流事件（部分字段）。 */
interface ClaudeStreamEvent {
  readonly type: string;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
  };
}

/**
 * 创建 Claude 适配器实例。
 */
export function createClaudeAdapter(opts: ILLMAdapterFactoryOptions): ClaudeAdapter {
  return new ClaudeAdapter(opts);
}
