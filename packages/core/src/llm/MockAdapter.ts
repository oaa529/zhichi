/**
 * @file MockAdapter.ts
 * Mock LLM 适配器（开发/测试用）。
 *
 * 模拟真实 LLM 的流式输出，用于：
 * - 开发环境无 API key 时的 fallback
 * - 测试重试/超时/fallback 逻辑
 * - 可控的 token 生成节奏
 */

import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";

import type { ILLMAdapter, ILLMAdapterFactoryOptions, IConnectionTestResult } from "./LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "./types";
import { LLMError } from "./types";

/**
 * Mock 适配器配置。
 */
export interface IMockAdapterOptions extends ILLMAdapterFactoryOptions {
  /** 每个 token 的间隔 ms（默认 80）。 */
  readonly tokenIntervalMs?: number;
  /** 是否模拟错误（测试重试/fallback 用）。 */
  readonly simulateError?: {
    readonly type: "server-error" | "network" | "timeout";
    readonly atAttempt?: number; // 第几次尝试时报错（默认第 1 次）
  };
}

export class MockAdapter implements ILLMAdapter {
  private readonly tokenIntervalMs: number;
  private readonly simulateError?: IMockAdapterOptions["simulateError"];
  private attemptCount = 0;

  constructor(opts: IMockAdapterOptions) {
    this.tokenIntervalMs = opts.tokenIntervalMs ?? 80;
    this.simulateError = opts.simulateError;
  }

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    signal: AbortSignal,
  ): ILLMAbortHandle {
    this.attemptCount += 1;
    let aborted = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    // 检查是否模拟错误
    if (this.simulateError) {
      const errorAt = this.simulateError.atAttempt ?? 1;
      if (this.attemptCount === errorAt) {
        const errorType = this.simulateError.type;
        // 延迟 100ms 后报错（模拟网络延迟）
        const errorTimer = setTimeout(() => {
          if (aborted || signal.aborted) return;
          switch (errorType) {
            case "server-error":
              handlers.onError(new LLMError("Mock server error 500", "server-error", 500, false));
              break;
            case "network":
              handlers.onError(new LLMError("Mock network error", "network", undefined, false));
              break;
            case "timeout":
              // 不调用任何 handler，让真正的 timeout signal 触发
              // 适配器层会通过 AbortSignal.timeout 处理
              break;
          }
        }, 100);
        return {
          abort: (reason?: string) => {
            aborted = true;
            clearTimeout(errorTimer);
            if (timer) clearInterval(timer);
            handlers.onError(new LLMError(reason ?? "aborted", "aborted", undefined, false));
          },
        };
      }
    }

    // 生成 mock 回复
    const reply = this.generateReply(req);
    const tokens = Array.from(reply);
    let i = 0;

    timer = setInterval(() => {
      if (aborted || signal.aborted) {
        if (timer) clearInterval(timer);
        if (!aborted) {
          aborted = true;
          handlers.onError(new LLMError("Aborted", "aborted", undefined, i > 0));
        }
        return;
      }

      if (i >= tokens.length) {
        if (timer) clearInterval(timer);
        timer = null;
        handlers.onComplete(reply);
        return;
      }

      const t = tokens[i];
      if (t !== undefined) handlers.onDelta(t);
      i += 1;
    }, this.tokenIntervalMs);

    return {
      abort: (reason?: string) => {
        aborted = true;
        if (timer) clearInterval(timer);
        timer = null;
        handlers.onError(new LLMError(reason ?? "aborted", "aborted", undefined, i > 0));
      },
    };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    // Mock 适配器始终成功，延迟 50ms 模拟网络
    await new Promise((r) => setTimeout(r, 50));
    return {
      ok: true,
      latencyMs: 50,
      sample: "mock-ok",
    };
  }

  /**
   * 生成 mock 回复文本。
   */
  private generateReply(req: ILLMRequest): string {
    const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
    const userText = lastUserMsg?.content ?? "";

    // 检查 system prompt 是否含睡眠状态
    const systemMsg = req.messages.find((m) => m.role === "system");
    const isSleeping = systemMsg?.content.includes("半梦半醒") ?? false;

    if (isSleeping) {
      return "嗯…怎么了…";
    }

    return `嗯，我听到你说"${userText.slice(0, 12)}"了。这个嘛，让我想想……其实我也说不太准，不过我们可以一起慢慢聊。你今天过得怎么样？`;
  }
}

/**
 * 创建 Mock 适配器实例。
 */
export function createMockAdapter(opts: IMockAdapterOptions): MockAdapter {
  return new MockAdapter(opts);
}
