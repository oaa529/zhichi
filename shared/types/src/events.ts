/**
 * @file events.ts
 * 引擎与 UI 之间的订阅契约。引擎以 Observable 形式推送 IRealismEngineOutput，
 * UI Store 通过 subscribe / unsubscribe 管理生命周期。
 */

import type { IRealismEngineOutput } from "./simulation";

/**
 * 引擎事件订阅句柄。实现 RxJS `SubscriptionLike` 的子集，
 * 允许 UI 层使用 `unsubscribe()` 取消订阅并清理定时器。
 */
export interface IEngineSubscription {
  /** 取消订阅并取消所有挂起的定时器。 */
  unsubscribe(): void;
  /** 是否已取消订阅。 */
  readonly closed: boolean;
}

/**
 * 引擎事件回调。UI Store 注册此回调，逐条消费引擎输出。
 */
export type EngineEventCallback = (output: IRealismEngineOutput) => void;

/**
 * 引擎错误回调。与 `EngineEventCallback` 分离，便于 UI 区分降级路径。
 */
export type EngineErrorCallback = (error: unknown) => void;

/**
 * 引擎完成回调。流式响应正常结束后触发。
 */
export type EngineCompleteCallback = () => void;

/**
 * 引擎可观测接口。RealismEngine 实现此接口，
 * UI Store 通过 `subscribe()` 拿到 IEngineSubscription。
 */
export interface IEngineObservable {
  /**
   * 订阅引擎输出流。
   * @returns 订阅句柄，组件卸载时必须调用 `.unsubscribe()`。
   */
  subscribe(
    onNext: EngineEventCallback,
    onError?: EngineErrorCallback,
    onComplete?: EngineCompleteCallback,
  ): IEngineSubscription;
}

/**
 * LLM 流式 token 回调签名。引擎接收 LLM SDK 的流式增量时使用。
 * 兼容 OpenAI/Anthropic 风格的 `deltaText` 增量协议。
 */
export interface ILlmStreamHandlers {
  /** 收到 token 增量。 */
  onDelta: (deltaText: string) => void;
  /** 流正常结束。 */
  onComplete: (fullText: string) => void;
  /** 流出错。 */
  onError: (error: unknown) => void;
  /**
   * 流被主动中止（可选）。
   * 与 onError 不同：abort 是用户主动行为，非错误。
   * 旧实现可忽略此字段，向后兼容。
   */
  onAbort?: (reason: string) => void;
}
