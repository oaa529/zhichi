/**
 * @file simulation.ts
 * 拟真度控制面板数据模型 + 引擎输出契约。
 *
 * - `ISimulationConfig`: 用户在"拟真度面板"调节的旋钮集合。
 * - `IRealismEngineOutput`: 引擎处理后的输出流格式，供 UI 层订阅消费。
 */

import type { CharacterEmotion } from "./character";
import type { IMessage } from "./message";

/**
 * 拟真度配置。由 UI 层"设置面板"写入，引擎实时读取。
 * 所有字段均可被独立开关——关闭后切回标准 AI 秒回模式。
 */
export interface ISimulationConfig {
  /** 总开关。false 时引擎直接透传 LLM 流，不做任何拟真处理。 */
  readonly realismEnabled: boolean;

  /** 打字速度档位。覆盖 `IPersonalityTraits.typingSpeedMultiplier`。 */
  readonly typingSpeedCpm: TypingSpeedPreset;
  /** 犹豫概率 0~1。 */
  readonly hesitationProbability: number;
  /** 错别字率 0~1。 */
  readonly typoRate: number;
  /**
   * 撤回概率 0~1：角色说完之后"反悔"，把刚发的那条撤回去。
   *
   * 可选字段（缺省视为 0）：老版本存档里没有这个旋钮，
   * 引擎按 0 处理即可，不必做数据迁移。
   * 只作用于文本气泡——撤回一条贴图/语音没有叙事价值。
   */
  readonly recallProbability?: number;
  /** 碎片化阈值：超过多少字符就尝试切分为多条气泡。 */
  readonly fragmentationThresholdChars: number;
  /** 是否启用作息感知（睡眠时段延迟回复）。 */
  readonly scheduleAwarenessEnabled: boolean;
  /** 是否启用"对方正在输入..."指示器。 */
  readonly typingIndicatorEnabled: boolean;
  /** 是否启用错别字自动纠错（错字显示 800ms 后自动替换为正字）。 */
  readonly typoAutoCorrectEnabled: boolean;
  /** 单条 chunk 之间的最大间隔（ms），防止拟真过度导致体验断裂。 */
  readonly maxInterChunkDelayMs: number;
}

/** 打字速度档位（characters per minute）。 */
export type TypingSpeedPreset =
  | "slow"      // ~120 cpm
  | "normal"    // ~200 cpm
  | "fast"      // ~300 cpm
  | "turbo";    // ~450 cpm

/** 引擎内部输出的事件类型。 */
export interface IRealismEngineOutput {
  /** 当前会话 ID。 */
  readonly sessionId: string;
  /** 当前角色 ID。 */
  readonly characterId: string;
  /** 事件序列号，单调递增。 */
  readonly sequence: number;
  /** 引擎内部时间戳。 */
  readonly emittedAt: number;
  /** 事件本体。 */
  readonly event: IEngineEvent;
}

/**
 * 引擎事件联合类型。UI Store 据此更新状态机。
 */
export type IEngineEvent =
  /** 角色"正在输入"状态变化。 */
  | ITypingIndicatorEvent
  /** 一条 chunk 即将到达，UI 应在 `delayMs` 后渲染。 */
  | IChunkScheduledEvent
  /** 一条 chunk 已就绪，可立即插入消息流。 */
  | IChunkDeliveredEvent
  /** 一条 chunk 的逐字延迟规划（供 UI 做打字机动画）。 */
  | ICharRevealPlanEvent
  /** 撤回通知。 */
  | IRecallEvent
  /** 角色在线/作息状态变化。 */
  | IPresenceEvent
  /** 引擎生命周期：开始/暂停/恢复/结束。 */
  | ILifecycleEvent
  /** 错误事件（非致命，UI 层决定是否降级为秒回）。 */
  | IEngineErrorEvent
  /** 本次请求的上下文占用快照（用于界面展示"钱花在哪了"）。 */
  | IContextUsageEvent;

/**
 * 一次请求的上下文占用快照。
 *
 * 由 PromptBuilder 在拼 prompt 时算出来：各部分占多少字符、是否触发了裁剪。
 * 之前这些信息只存在于引擎内部，界面上完全看不见——用户既不知道
 * "记忆到底注入了没有"，也不知道长会话已经开始丢历史了。
 */
export interface IContextUsage {
  /** 估算 token（中文约 1.3 token/字，含每条消息 +4 的固定开销）。 */
  readonly estimatedTokens: number;
  /** 实际发出去的消息条数。 */
  readonly messageCount: number;
  /** 各部分的字符数。 */
  readonly chars: {
    /** 角色卡 + 作息状态。 */
    readonly system: number;
    /** 人设模板。 */
    readonly template: number;
    /** 长期记忆。 */
    readonly memory: number;
    /** 世界书条目（社区卡设定）。 */
    readonly lore: number;
    /** 剧情摘要。 */
    readonly plot: number;
    /**
     * 「别重复」约束段。
     *
     * 可选字段：老存档里没有它，界面按 0 处理即可，不必做数据迁移。
     */
    readonly antiRepeat?: number;
    /** 对话历史。 */
    readonly history: number;
  };
  /** 是否因为超过软上限发生了裁剪。 */
  readonly trimmed: boolean;
  /** 是否因为超过硬上限把旧消息压成了「前情提要」。 */
  readonly summarized: boolean;
  /** 被裁剪掉的字符数。 */
  readonly removedChars: number;
}

/** 上下文占用事件。 */
export interface IContextUsageEvent {
  readonly kind: "context-usage";
  readonly usage: IContextUsage;
}

/** "对方正在输入..." 指示器事件。 */
export interface ITypingIndicatorEvent {
  readonly kind: "typing-indicator";
  /** true = 开始输入，false = 停止输入。 */
  readonly active: boolean;
  /** 预计剩余 ms（用于 UI 显示进度条/省略号）。 */
  readonly estimatedRemainingMs: number;
}

/** Chunk 已排期事件。UI 可据此预先插入"占位气泡"。 */
export interface IChunkScheduledEvent {
  readonly kind: "chunk-scheduled";
  readonly pendingMessageId: string;
  /** 距离实际送达还有多少 ms。 */
  readonly delayMs: number;
}

/** Chunk 已送达事件。携带最终消息对象。 */
export interface IChunkDeliveredEvent {
  readonly kind: "chunk-delivered";
  readonly message: IMessage;
}

/** 单条 chunk 内的逐字揭示计划。 */
export interface ICharRevealPlanEvent {
  readonly kind: "char-reveal-plan";
  readonly messageId: string;
  /** 每个字符的揭示延迟（ms，相对于该 chunk 的渲染起点）。 */
  readonly revealDelays: ReadonlyArray<number>;
  /** 是否包含错别字（UI 可在纠错时间点触发替换动画）。 */
  readonly containsTypo: boolean;
  /** 错别字纠正时间点（ms，从渲染起点计）。 */
  readonly typoCorrectAtMs?: number;
  /**
   * 纠错后的正确文本（含错别字时提供）。
   * UI 在 typoCorrectAtMs 到达后用它替换错字版本。
   */
  readonly correctedText?: string;
}

/** 撤回事件。 */
export interface IRecallEvent {
  readonly kind: "recall";
  readonly targetMessageId: string;
  readonly notice: string;
}

/** 在线状态事件。 */
export interface IPresenceEvent {
  readonly kind: "presence";
  readonly status: CharacterPresence;
  /** 当前情绪快照。 */
  readonly emotion: CharacterEmotion;
  /** 状态显示文案，如"在线"、"离开"、"已就寝"。 */
  readonly displayText: string;
}

/** 角色在场状态。 */
export type CharacterPresence =
  | "online"
  | "typing"
  | "away"
  | "sleeping"
  | "offline";

/** 引擎生命周期事件。 */
export interface ILifecycleEvent {
  readonly kind: "lifecycle";
  readonly phase: EngineLifecyclePhase;
  readonly reason?: string;
}

export type EngineLifecyclePhase =
  | "started"
  | "paused"
  | "resumed"
  | "completed"
  | "aborted";

/**
 * 会话阶段（store 持久化用，比 EngineLifecyclePhase 多 idle/streaming/interrupted）。
 */
export type SessionPhase =
  | "idle"
  | "streaming"
  | "paused"
  | "completed"
  | "aborted"
  | "interrupted";

/** 引擎错误事件。 */
export interface IEngineErrorEvent {
  readonly kind: "error";
  readonly code: EngineErrorCode;
  readonly message: string;
  /** 是否可恢复（UI 据此决定是否降级为秒回）。 */
  readonly recoverable: boolean;
}

export type EngineErrorCode =
  | "llm-stream-broken"
  /** 模型成功返回但正文为空（推理模型常见：思考占满输出预算）。 */
  | "llm-empty-reply"
  | "chunker-overflow"
  | "schedule-violation"
  | "timer-cancelled"
  | "llm-fallback-triggered"
  | "unknown";

/**
 * LLM 配置（跨层共享，但 API key 不包含在此接口中）。
 * API key 等敏感信息仅存于运行时内存（apps/web/src/llmRuntime.ts），
 * 不进入此接口，不持久化。
 */
export interface ILLMConfig {
  /** 适配器类型。 */
  readonly adapter: "openai" | "claude" | "mock";
  /** API 端点 base URL。 */
  readonly baseURL: string;
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
 * 引擎可序列化状态快照（用于 IndexedDB 持久化与 Hydration）。
 *
 * 持久化范围：messages / messageRuntimes / presence / simulationConfig / phase / lastError / deliveredChunkCount。
 * 不持久化：buffer / chunker / typer / presence 内部状态 / pendingTimers（瞬态，无法还原定时器）。
 *
 * Migration Guide：新增独立接口，不修改既有类型。
 * chatStore state 增加可选 `hydrated: boolean` 标记，不破坏现有 selector。
 */
export interface IEngineSnapshot {
  /** Schema 版本号（用于未来迁移）。 */
  readonly schemaVersion: number;
  /** 会话 ID。 */
  readonly sessionId: string;
  /** 角色 ID。 */
  readonly characterId: string;
  /** 消息列表（纯数据，可序列化）。 */
  readonly messages: ReadonlyArray<IMessage>;
  /** 消息运行时视图（揭示状态 + 揭示延迟计划）。 */
  readonly messageRuntimes: ReadonlyArray<{
    readonly revealed: boolean;
    readonly revealDelays?: ReadonlyArray<number>;
    readonly typoCorrectAtMs?: number;
    readonly pending: boolean;
  }>;
  /** 在场状态。 */
  readonly presence: CharacterPresence;
  /** 在场状态显示文本。 */
  readonly presenceText: string;
  /** 拟真配置。 */
  readonly simulationConfig: ISimulationConfig;
  /** 会话阶段（streaming 时刷新后标记为 interrupted）。 */
  readonly lastPhase: SessionPhase;
  /** 最后的错误信息。 */
  readonly lastError: { code: string; message: string } | null;
  /** 已交付 chunk 计数（用于 chunk ID 生成连续性）。 */
  readonly deliveredChunkCount: number;
  /** 快照保存时间戳。 */
  readonly savedAt: number;
}
