/**
 * @file types.ts
 * LLM 适配器层的请求/响应/配置类型定义。
 * 这些类型是 core 内部使用的，不暴露给 shared/types（除非是 ILLMConfig）。
 */

/**
 * LLM 消息角色。兼容 OpenAI 和 Claude 的消息格式。
 */
export type LLMMessageRole = "system" | "user" | "assistant";

/**
 * LLM 消息（最小公分母格式，适配器负责转换到各自 SDK 格式）。
 */
export interface ILLMMessage {
  readonly role: LLMMessageRole;
  readonly content: string;
}

/**
 * LLM 流式请求参数。
 */
export interface ILLMRequest {
  /** 完整消息历史（system + user/assistant 交替）。 */
  readonly messages: ReadonlyArray<ILLMMessage>;
  /** 模型名称（如 "gpt-4o-mini"、"claude-3-5-sonnet-20241022"）。 */
  readonly model: string;
  /** 最大输出 token 数。 */
  readonly maxTokens: number;
  /** 温度（0~2）。 */
  readonly temperature: number;
}

/**
 * 适配器中止句柄。调用 abort() 后，正在进行的 SSE fetch 会被中断。
 */
export interface ILLMAbortHandle {
  /** 中止正在进行的流式请求。 */
  abort(reason?: string): void;
}

/**
 * LLM 配置（运行时注入，API key 等敏感信息不进入 shared/types）。
 */
export interface ILLMConfigInternal {
  /** API 端点 base URL（如 "https://api.openai.com/v1"）。 */
  readonly baseURL: string;
  /** API key（仅存于运行时内存，不持久化）。 */
  readonly apiKey: string;
  /** 模型名称。 */
  readonly model: string;
  /** 超时 ms（默认 30000）。 */
  readonly timeoutMs: number;
  /** 最大重试次数（默认 3）。 */
  readonly maxRetries: number;
  /** 温度（默认 0.8，适合 RP）。 */
  readonly temperature: number;
  /** 最大输出 token 数。 */
  readonly maxTokens: number;
}

/**
 * LLM 错误分类，用于决定重试还是直接降级。
 */
export type LLMErrorKind =
  | "network"
  | "server-error"
  | "client-error"
  | "timeout"
  | "aborted"
  | "rate-limit"
  | "unknown";

/**
 * LLM 错误（适配器内部统一格式）。
 */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly statusCode?: number;
  /** 是否已开始接收 delta（true 时不可重试）。 */
  readonly deltaStarted: boolean;

  constructor(message: string, kind: LLMErrorKind, statusCode?: number, deltaStarted?: boolean) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.deltaStarted = deltaStarted ?? false;
  }

  /** 是否可重试：网络错误/5xx/429/超时，且未开始 delta。 */
  get retryable(): boolean {
    if (this.deltaStarted) return false;
    return (
      this.kind === "network" ||
      this.kind === "server-error" ||
      this.kind === "timeout" ||
      this.kind === "rate-limit"
    );
  }
}
