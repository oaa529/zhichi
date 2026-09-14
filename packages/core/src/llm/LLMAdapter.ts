/**
 * @file LLMAdapter.ts
 * LLM 适配器抽象接口。
 *
 * 设计目标：
 * - 统一不同 LLM 提供商（OpenAI/Claude/其他）的流式输出协议
 * - 返回 ILLMAbortHandle 供引擎中止 SSE fetch
 * - 适配器内部处理超时和错误分类（LLMError）
 * - 不负责重试逻辑（由 RealismEngine 的 streamWithRetry 统一编排）
 *
 * 实现方需保证：
 * - stream() 是非阻塞的，立即返回 ILLMAbortHandle
 * - 收到 delta 时同步调用 handlers.onDelta
 * - 流结束后调用 handlers.onComplete(fullText)
 * - 出错时调用 handlers.onError(LLMError)
 * - signal.aborted 时立即停止并调用 handlers.onError(LLMError(aborted))
 */

import type { ILlmStreamHandlers } from "@wechat-rp/shared-types";
import type { ILLMAbortHandle, ILLMConfigInternal, ILLMRequest } from "./types";

/**
 * LLM 适配器抽象接口。
 * 每个具体适配器（OpenAI/Claude）实现此接口。
 */
export interface ILLMAdapter {
  /**
   * 启动流式请求。
   *
   * @param req 请求参数（messages/model/maxTokens/temperature）
   * @param handlers 流式回调（onDelta/onComplete/onError）
   * @param signal AbortSignal，用于中止正在进行的请求
   * @returns 中止句柄，调用 .abort() 会中断 SSE fetch
   */
  stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    signal: AbortSignal,
  ): ILLMAbortHandle;

  /**
   * 测试连接（健康检查）。
   *
   * 发送一个最小化的非流式请求，验证 baseURL/apiKey/model 是否可用。
   * 不抛异常即表示连接成功；失败时抛出 LLMError 包含错误详情。
   *
   * @returns 连接成功时的回执信息（如模型返回的首 token / 延迟 ms）
   * @throws LLMError 连接失败时
   */
  testConnection(): Promise<IConnectionTestResult>;
}

/**
 * 连接测试结果。
 */
export interface IConnectionTestResult {
  /** 是否成功。 */
  readonly ok: boolean;
  /** 响应延迟（ms）。 */
  readonly latencyMs: number;
  /** 模型返回的示例文本（通常取前几个字）。 */
  readonly sample?: string;
  /** 错误信息（失败时）。 */
  readonly error?: string;
  /** 错误分类（失败时）。 */
  readonly errorKind?: "network" | "auth" | "not-found" | "rate-limit" | "server" | "timeout" | "unknown";
}

/**
 * 适配器工厂配置。
 */
export interface ILLMAdapterFactoryOptions {
  readonly config: ILLMConfigInternal;
}

/**
 * 适配器类型标识。
 */
export type LLMAdapterKind = "openai" | "claude" | "mock";
