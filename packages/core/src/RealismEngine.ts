/**
 * @file RealismEngine.ts
 * 拟真引擎主类。职责：
 *
 * 1. 接收 LLM 流式 token 增量（通过 ILlmStreamHandlers 注入）
 * 2. 经 SemanticBuffer 切分为 MessageChunk
 * 3. 经 TypingSimulator 为每个 chunk 计算时序规划
 * 4. 经 PresenceManager 判断作息状态并调整延迟
 * 5. 通过 IEngineObservable 把 IRealismEngineOutput 推送给 UI Store
 *
 * 关键设计：
 * - 引擎不持有任何 UI 引用，零 React 依赖。
 * - 所有 setTimeout 使用 AbortController 管理，组件卸载即取消。
 * - 关闭 realismEnabled 时直接透传 LLM 文本为单条消息（秒回模式）。
 *
 * 推送流程（伪代码）：
 *   LLM onDelta(delta)
 *     └─ SemanticBuffer.push(delta, onChunk)
 *          └─ for each chunk:
 *               plan = TypingSimulator.plan(chunk)
 *               scheduleTimers(plan, () => emit(chunk-delivered))
 *   LLM onComplete(fullText)
 *     └─ SemanticBuffer.complete(onChunk)  // flush 残余
 */

import type {
  CharacterEmotion,
  CharacterPresence,
  EngineErrorCode,
  ICharacterProfile,
  EngineCompleteCallback,
  EngineErrorCallback,
  IEngineEvent,
  IEngineObservable,
  IEngineSubscription,
  ILLMConfig,
  ILlmStreamHandlers,
  ILoreEntry,
  IMemory,
  IMessageQuote,
  IPromptTemplate,
  IRealismEngineOutput,
  ISimulationConfig,
  IStickerMessage,
  ITextMessage,
  IUserProfile,
} from "@wechat-rp/shared-types";

import { Chunker } from "./Chunker";
import { SemanticBuffer } from "./SemanticBuffer";
import { TypingSimulator } from "./TypingSimulator";
import { PresenceManager } from "./PresenceManager";
import type { IEngineRunContext, ITypingPlan, MessageChunk } from "./types";
import type { ILLMAdapter } from "./llm/LLMAdapter";
import type { ILLMMessage, ILLMAbortHandle, ILLMRequest } from "./llm/types";
import type { IPresenceDecision } from "./PresenceManager";
import { buildPrompt } from "./llm/PromptBuilder";
import { inferEmotion, parseEmotionTagHead } from "./EmotionInference";
import { moodEmotionForSprite, type IMoodState } from "./emotion/MoodTracker";
import {
  CharacterQuoteFilter,
  findQuoteTarget,
  type IQuoteCandidate,
} from "./llm/characterQuote";
import { pickSticker, STICKER_PACK_ID } from "./sticker/Stickers";
import { buildRecallNotice } from "./recall/Recall";
import { generateFallback } from "./llm/FallbackGenerator";
import { LLMError as LLMErrorClass } from "./llm/types";

/**
 * 订阅句柄实现。封装内部定时器集合，
 * unsubscribe 时统一 clear，避免内存泄漏。
 */
class EngineSubscription implements IEngineSubscription {
  private readonly cleanupFns: Array<() => void> = [];
  private _closed = false;

  constructor(
    private readonly onNext: (output: IRealismEngineOutput) => void,
    private readonly onError?: EngineErrorCallback,
    private readonly onComplete?: EngineCompleteCallback,
  ) {}

  public get closed(): boolean {
    return this._closed;
  }

  /** 注册一个清理函数，unsubscribe 时调用。 */
  public addCleanup(fn: () => void): void {
    this.cleanupFns.push(fn);
  }

  public emit(output: IRealismEngineOutput): void {
    if (this._closed) return;
    this.onNext(output);
  }

  public fail(error: unknown): void {
    if (this._closed) return;
    this.onError?.(error);
  }

  public done(): void {
    if (this._closed) return;
    this.onComplete?.();
  }

  public unsubscribe(): void {
    if (this._closed) return;
    this._closed = true;
    // 倒序调用清理
    for (let i = this.cleanupFns.length - 1; i >= 0; i -= 1) {
      const fn = this.cleanupFns[i];
      if (fn) fn();
    }
    this.cleanupFns.length = 0;
  }
}

export interface IRealismEngineOptions {
  readonly profile: ICharacterProfile;
  readonly config: ISimulationConfig;
  /** 当前会话 ID。 */
  readonly sessionId: string;
  /** 当前用户 ID（消息 recipientId 用）。 */
  readonly userId: string;
}

export class RealismEngine implements IEngineObservable {
  private profile: ICharacterProfile;
  private config: ISimulationConfig;
  private readonly sessionId: string;
  private readonly userId: string;

  private buffer: SemanticBuffer | null = null;
  private chunker: Chunker | null = null;
  private typer: TypingSimulator | null = null;
  private presence: PresenceManager | null = null;

  private activeSubscription: EngineSubscription | null = null;
  private runContext: IEngineRunContext | null = null;

  /** 已累计 chunk 数，用于 isFirst 判断。 */
  private deliveredChunkCount = 0;

  /** 排程计数器：scheduleChunkDelivery 被调用时立即递增（不等 setTimeout）。 */
  private scheduledChunkCount = 0;

  /** 下一个 chunk 最早可交付的时间戳（排队算法核心）。 */
  private nextDeliveryTime = 0;

  /**
   * 流是否正在运行。与 activeSubscription 解耦：
   * activeSubscription 是长期存活的输出订阅（store attach 时创建），
   * streamInProgress 是短期流状态（startStream 时 true，resetRunState 时 false）。
   */
  private streamInProgress = false;

  /** 挂起的定时器 ID 集合，供 abort。 */
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  /** 本轮是否由用户主动中止（用于区分超时中止与手动中止）。 */
  private userAborted = false;

  /** AbortController：组件卸载 / 取消时统一 abort。 */
  private abortController: AbortController | null = null;

  /** LLM 适配器中止句柄（流式请求进行时存在）。 */
  private adapterAbortHandle: ILLMAbortHandle | null = null;

  /** LLM 配置（可选，未注入时走旧 handlers 模式）。 */
  private llmConfig: ILLMConfig | null = null;

  /** 消息历史（用于 Prompt 构造的上下文）。 */
  private messageHistory: ILLMMessage[] = [];

  /** 角色人设模板（结构化提示词，来自提示词面板绑定）。 */
  private promptTemplate: IPromptTemplate | null = null;
  /** 本轮回复已产出的正文，用于逐个气泡推断情绪。 */
  private replyText = "";
  /**
   * 流开头攒着的文本：模型按约定第一行写情绪词，
   * 得等第一行完整（见到换行）或攒够一定长度才能判断。
   */
  private headBuffer = "";
  private headDecided = false;
  /**
   * 引用标记的流式过滤器。
   *
   * 模型写的 `【引用：你今天怎么没来上课？】` 必须整段摘掉——
   * 无论在开头、中间还是结尾（真机实测三种都出现过），
   * 既不能让它漏进气泡，也不能丢掉它前后的正文。
   */
  private quoteFilter = new CharacterQuoteFilter();
  /** 模型自己标的情绪（有的话，整轮都用它，不再靠关键词猜）。 */
  private tagEmotion: CharacterEmotion | null = null;
  /** 本轮解析出的引用块（挂到第一条交付的气泡上）。 */
  private pendingQuote: IMessageQuote | null = null;
  private quoteAttached = false;
  /** 可供引用的候选（App 在每次发送前注入：用户最近说过的话）。 */
  private quoteCandidates: ReadonlyArray<IQuoteCandidate> = [];

  /** 检索后的长期记忆（每次发送前由 App 层注入）。 */
  private memories: ReadonlyArray<IMemory> = [];

  /** 命中的世界书条目（每次发送前由 App 层检索后注入）。 */
  private loreEntries: ReadonlyArray<ILoreEntry> = [];

  /** 本轮最后一条消息的情绪（决定收尾时发哪张贴图）。 */
  private lastChunkEmotion: CharacterEmotion = "neutral";

  /** 本轮是否已经追加过贴图（每轮最多一张）。 */
  private stickerDeliveredThisRun = false;

  /**
   * 本轮最后交付的一条**文本**气泡的 ID（撤回的候选目标）。
   *
   * 只记文本：撤回一条贴图没有叙事价值，而且微信里"说漏嘴→撤回"
   * 针对的永远是自己刚打出来的那句话。
   */
  private lastTextMessageId: string | null = null;

  /** 剧情摘要段落（由 PlotKeeper.renderPlotSummary 渲染）。 */
  private plotSummary = "";

  /** 用户人设（"关于你"）：由 App 注入，每轮随人设一起下发。 */
  private userProfile: IUserProfile | null = null;

  /**
   * 角色当前的心情（App 在每次发送前用 MoodTracker 推导后注入）。
   *
   * 两个用途：写进 Prompt（语气要延续），以及**立绘兜底**——
   * 文本本身看不出情绪时，用心情选立绘，而不是一律回到 neutral。
   */
  private mood: IMoodState | null = null;

  /**
   * 对方上一条消息的时间戳（App 在发送前注入）。
   *
   * 只用来告诉角色"你们上一次说话隔了多久"——隔三小时和隔三天，
   * 开口方式完全不同。不注入（null）时 Prompt 里不出现【上一句】。
   */
  private lastMessageAt: number | null = null;

  constructor(opts: IRealismEngineOptions) {
    this.profile = opts.profile;
    this.config = opts.config;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
  }

  /** 动态更新拟真配置（UI 设置面板实时调节）。 */
  public updateConfig(patch: Partial<ISimulationConfig>): void {
    this.config = { ...this.config, ...patch };
    // 若 buffer 已存在，需重新创建以应用新阈值
    if (this.buffer && this.runContext) {
      // 保守起见，仅更新引用；运行中切分粒度变化不影响已交付 chunk
      // 实际生产中应在两条流之间切换配置
    }
  }

  /**
   * 更新角色档案（角色编辑器保存后由 EngineManager 推送）。
   *
   * PresenceManager 与 TypingSimulator 都在 startStream 时才按当前档案构造，
   * 因此这里只需替换引用，作息/性格/人设的改动能立刻作用于下一条消息。
   */
  public updateProfile(profile: ICharacterProfile): void {
    this.profile = profile;
  }

  /**
   * 当前是否处于睡眠时段。
   *
   * 供 UI 判断"是否该主动打扰"——角色睡着时不该主动发消息。
   * 复用 PresenceManager 的判定逻辑（纯函数，构造开销可忽略）。
   */
  public isSleeping(at: number = Date.now()): boolean {
    return this.describePresence(at).isSleeping;
  }

  /**
   * 当前是否处于忙碌时段（上课 / 上班）。
   *
   * 与 `isSleeping` 一样供 UI 判断"要不要主动打扰"：
   * 睡着时不打扰；忙着时也不该由角色主动开新话题——那是它自己没空的时候。
   */
  public isBusy(at: number = Date.now()): boolean {
    return this.describePresence(at).isBusy;
  }

  /**
   * 当前的在场状态（在线 / 忙碌 / 已就寝）。
   *
   * 供 UI 随时查询：引擎原本只在"开始一轮回复"时推送 presence 事件，
   * 于是刚打开会话时头部一直显示"在线"——哪怕角色此刻正在上课。
   */
  public describePresence(at: number = Date.now()): IPresenceDecision {
    const presence = new PresenceManager(this.profile, this.config);
    return presence.evaluate(at);
  }

  /** 注入 LLM 配置（运行时调用，非持久化）。 */
  public setLLMConfig(config: ILLMConfig): void {
    this.llmConfig = config;
  }

  /** 更新消息历史（用于 Prompt 上下文截断）。 */
  public setMessageHistory(history: ReadonlyArray<ILLMMessage>): void {
    this.messageHistory = [...history];
  }

  /**
   * 注入"角色可以引用的候选"（用户最近说过的话）。
   *
   * 模型的引用标记只抄了原文的一小段，要落到具体是哪条消息上
   * （引用块要能点击跳回去），必须有一份带 ID 的候选表。
   */
  public setQuoteCandidates(
    candidates: ReadonlyArray<IQuoteCandidate>,
  ): void {
    this.quoteCandidates = [...candidates];
  }

  /** 注入角色人设模板（null = 清除绑定）。 */
  public setPromptTemplate(template: IPromptTemplate | null): void {
    this.promptTemplate = template;
  }

  /** 注入检索后的长期记忆。 */
  public setMemories(memories: ReadonlyArray<IMemory>): void {
    this.memories = [...memories];
  }

  /** 注入本轮命中的世界书条目（空数组 = 不注入）。 */
  public setLoreEntries(entries: ReadonlyArray<ILoreEntry>): void {
    this.loreEntries = [...entries];
  }

  /** 注入剧情摘要段落（空字符串 = 不注入）。 */
  public setPlotSummary(summary: string): void {
    this.plotSummary = summary;
  }

  /**
   * 注入用户人设（"关于你"）。
   *
   * 空值或默认值（称呼"我"）时 PromptBuilder 会整段省略，不必在这里判断。
   */
  public setUserProfile(profile: IUserProfile | null): void {
    this.userProfile = profile;
  }

  /**
   * 注入"对方上一条消息的时间戳"（null = 没有历史）。
   *
   * 引擎拿不到消息时间戳：历史是裸的 `ILLMMessage`（只有 role/content），
   * 时间这份数据在 UI 层的消息列表里，所以由 App 每次发送前同步过来。
   */
  public setLastMessageAt(at: number | null): void {
    this.lastMessageAt = at;
  }

  /**
   * 注入角色当前的心情（null = 平静，不注入）。
   *
   * 由 App 在发送前用 `deriveMood` 从最近的对话推导——引擎不自己
   * 持有历史消息的情绪字段，那份数据在 UI 层的消息列表里。
   */
  public setMood(mood: IMoodState | null): void {
    this.mood = mood;
  }

  /**
   * 启动一次 LLM 流式响应处理。
   *
   * 返回的 `ILlmStreamHandlers` 应交给 LLM SDK 调用：
   *   const handlers = engine.startStream("你好");
   *   await llm.chat({ stream: true, onDelta: handlers.onDelta, ... });
   *
   * 同时引擎内部已开始订阅就绪，UI 层可通过 subscribe() 拿到流。
   *
   * 实现细节：
   * - 创建 buffer / chunker / typer / presence
   * - 注入 onDelta / onComplete / onError
   * - 通过 setTimeout + AbortController 排程每条 chunk 的交付
   */
  public startStream(userMessage: string): ILlmStreamHandlers {
    if (this.streamInProgress) {
      throw new Error("RealismEngine: stream already in progress");
    }
    this.streamInProgress = true;
    this.userAborted = false;
    this.replyText = "";
    this.headBuffer = "";
    this.headDecided = false;
    this.quoteFilter = new CharacterQuoteFilter();
    this.pendingQuote = null;
    this.quoteAttached = false;
    this.tagEmotion = null;

    this.abortController = new AbortController();
    this.chunker = new Chunker({
      sessionId: this.sessionId,
      characterId: this.profile.id,
    });
    this.buffer = new SemanticBuffer({
      sessionId: this.sessionId,
      characterId: this.profile.id,
      config: this.config,
      chunker: this.chunker,
    });
    this.typer = new TypingSimulator(this.profile, this.config);
    this.presence = new PresenceManager(this.profile, this.config);

    this.runContext = {
      sessionId: this.sessionId,
      characterId: this.profile.id,
      userMessage,
      startedAt: Date.now(),
      sequenceCounter: 0,
    };
    this.deliveredChunkCount = 0;

    // 初始推送生命周期 started
    this.emitLifecycle("started");

    // 立即推送 typing-indicator（对方正在输入...）
    this.emit({
      kind: "typing-indicator",
      active: true,
      estimatedRemainingMs: 0,
    });

    // ---- 睡眠检查 ----
    // 在开始流之前检查角色是否处于睡眠时段
    // silent 策略下完全不回复（不调 LLM，直接结束）
    // drowsy-burst 策略下正常处理但延迟更长
    const sleepDecision = this.presence.evaluate();
    if (sleepDecision.isSleeping && sleepDecision.policy === "silent") {
      // 推送系统消息：角色已就寝
      this.emitPresenceUpdate(sleepDecision);
      // 直接结束流，不等待 LLM
      this.finishRun();
      // 返回 no-op handlers（调用方喂入的 token 会被丢弃）
      return {
        onDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      };
    }

    // 睡眠（非 silent 策略）或忙碌时，推送一次在场状态，界面据此显示
    if (sleepDecision.isSleeping || sleepDecision.isBusy) {
      this.emitPresenceUpdate(sleepDecision);
    }

    return {
      onDelta: (deltaText: string) => this.handleDelta(deltaText),
      onComplete: (fullText: string) => this.handleComplete(fullText),
      onError: (error: unknown) => this.handleError(error),
    };
  }

  /**
   * 启动一次 LLM 流式响应处理（适配器模式）。
   *
   * 与 `startStream` 的区别：
   * - 内部调用 ILLMAdapter.stream() 发起真实 LLM 请求
   * - 自动构造 Prompt（注入 PresenceManager 状态）
   * - 自动重试（5xx/网络错误/超时，指数退避）
   * - 重试耗尽自动触发 fallback（角色拟真短句）
   * - AbortController 透传给 adapter，中止时中断 SSE fetch
   *
   * @param userMessage 用户消息文本
   * @param adapter LLM 适配器实例
   * @returns 是否成功启动（false = silent 策略下未启动 LLM）
   */
  public startStreamWithAdapter(
    userMessage: string,
    adapter: ILLMAdapter,
  ): boolean {
    if (this.streamInProgress) {
      throw new Error("RealismEngine: stream already in progress");
    }
    this.streamInProgress = true;
    this.userAborted = false;
    // 本轮已产出的正文（用来推断情绪）
    this.replyText = "";
    this.headBuffer = "";
    this.headDecided = false;
    this.quoteFilter = new CharacterQuoteFilter();
    this.pendingQuote = null;
    this.quoteAttached = false;
    this.tagEmotion = null;

    this.abortController = new AbortController();
    this.chunker = new Chunker({
      sessionId: this.sessionId,
      characterId: this.profile.id,
    });
    this.buffer = new SemanticBuffer({
      sessionId: this.sessionId,
      characterId: this.profile.id,
      config: this.config,
      chunker: this.chunker,
    });
    this.typer = new TypingSimulator(this.profile, this.config);
    this.presence = new PresenceManager(this.profile, this.config);

    this.runContext = {
      sessionId: this.sessionId,
      characterId: this.profile.id,
      userMessage,
      startedAt: Date.now(),
      sequenceCounter: 0,
    };
    this.deliveredChunkCount = 0;
    this.scheduledChunkCount = 0;
    this.stickerDeliveredThisRun = false;
    this.lastChunkEmotion = "neutral";
    this.lastTextMessageId = null;
    this.nextDeliveryTime = 0;

    this.emitLifecycle("started");

    // ---- 睡眠检查 ----
    const sleepDecision = this.presence.evaluate();
    if (sleepDecision.isSleeping && sleepDecision.policy === "silent") {
      this.emitPresenceUpdate(sleepDecision);
      this.finishRun();
      return false;
    }

    // 睡眠（非 silent 策略）或忙碌时，推送一次在场状态
    if (sleepDecision.isSleeping || sleepDecision.isBusy) {
      this.emitPresenceUpdate(sleepDecision);
    }

    // 进入生成阶段：推送 typing-indicator（"对方正在输入..."）
    // 首个 chunk 交付时关闭（见 scheduleChunkDelivery）
    this.emit({
      kind: "typing-indicator",
      active: true,
      estimatedRemainingMs: 0,
    });

    // ---- Prompt 构造 ----
    const promptResult = buildPrompt(
      this.profile,
      this.messageHistory,
      userMessage,
      sleepDecision,
      {
        promptTemplate: this.promptTemplate ?? undefined,
        lore: this.loreEntries,
        memories: this.memories,
        plotSummary: this.plotSummary || undefined,
        mood: this.mood,
        userProfile: this.userProfile,
        lastMessageAt: this.lastMessageAt,
      },
    );

    // ---- LLM 请求 ----
    const req: ILLMRequest = {
      messages: promptResult.messages,
      model: this.llmConfig?.model ?? "gpt-4o-mini",
      maxTokens: this.llmConfig?.maxTokens ?? 1024,
      temperature: this.llmConfig?.temperature ?? 0.8,
    };

    // 把这次请求的上下文占用推给 UI（各部分占多少、有没有触发裁剪）
    this.emit({ kind: "context-usage", usage: promptResult.usage });

    // ---- 带重试的流式调用 ----
    this.streamWithRetry(adapter, req, sleepDecision);

    return true;
  }

  /**
   * IEngineObservable.subscribe 实现。
   * UI Store 调用此方法获取订阅句柄，组件卸载时必须 unsubscribe()。
   */
  public subscribe(
    onNext: (output: IRealismEngineOutput) => void,
    onError?: EngineErrorCallback,
    onComplete?: EngineCompleteCallback,
  ): IEngineSubscription {
    const sub = new EngineSubscription(onNext, onError, onComplete);
    this.activeSubscription = sub;
    return sub;
  }

  /**
   * 主动中止当前流（如用户切走页面、点击"停止"按钮）。
   * 取消所有挂起定时器，推送 aborted 事件。
   * 透传调用 adapter.abortHandle.abort() 中断 SSE fetch。
   */
  public abort(reason?: string): void {
    this.userAborted = true;
    this.clearAllTimers();
    this.adapterAbortHandle?.abort(reason ?? "user-abort");
    this.adapterAbortHandle = null;
    this.abortController?.abort();
    this.emitLifecycle("aborted", reason);
    // 注意：abort 不调用 activeSubscription?.done()
    // done() 触发 onComplete 回调（语义为"流正常完成"），abort 是非正常终止
    // 状态转换由 lifecycle "aborted" 事件经 store 处理
    this.resetRunState();
  }

  // ---------- LLM 适配器重试与降级 ----------

  /**
   * 带重试的 LLM 流式调用。
   *
   * 重试策略：
   * - 仅对 retryable 错误重试（network/server-error/timeout/rate-limit）
   * - 已开始接收 delta 后不重试（避免重复输出）
   * - 指数退避：500ms / 1000ms / 2000ms
   * - 最大重试次数来自 llmConfig.maxRetries（默认 3）
   * - 重试耗尽 → triggerFallback
   */
  private streamWithRetry(
    adapter: ILLMAdapter,
    req: ILLMRequest,
    sleepDecision: IPresenceDecision | null,
  ): void {
    const maxRetries = this.llmConfig?.maxRetries ?? 3;
    const signal = this.abortController?.signal;
    if (!signal) return;

    let attempt = 0;
    let deltaStarted = false;

    const handlers: ILlmStreamHandlers = {
      onDelta: (delta) => {
        if (!deltaStarted) deltaStarted = true;
        this.handleDelta(delta);
      },
      onComplete: (fullText) => {
        this.adapterAbortHandle = null;

        // 模型「成功」返回但正文为空——实测常见于推理模型：思考过程吃掉
        // 输出预算（finish_reason=length、正文 0 字）。绝不能静默收尾，
        // 否则用户发完消息什么也看不到，只会以为卡住了。
        if (fullText.trim().length === 0) {
          if (attempt < maxRetries && !deltaStarted && !signal.aborted) {
            attempt += 1;
            const delayMs = 400 * Math.pow(2, attempt - 1); // 400 / 800 / 1600
            const timer = setTimeout(() => {
              if (signal.aborted) return;
              this.adapterAbortHandle = adapter.stream(req, handlers, signal);
            }, delayMs);
            this.trackTimer(timer);
            return;
          }

          this.emitError(
            "llm-empty-reply",
            "模型这次没有返回任何内容（推理模型常见：思考占满了输出预算）。点重试再试一次，或在设置里调大最大 token。",
            true,
          );
          this.finishRun();
          return;
        }

        this.handleComplete(fullText);
      },
      onError: (error) => {
        this.adapterAbortHandle = null;

        // abort 错误不重试
        const isAborted = error instanceof LLMErrorClass && error.kind === "aborted";
        if (isAborted) {
          if (this.userAborted) {
            // 用户主动中止：lifecycle aborted 已由 abort() 发出，这里不重复处理
            return;
          }
          // 非用户中止（例如底层流被超时/外部信号中断却归类为 aborted）：
          // 必须走降级路径收尾，否则 phase 会永久停在 streaming（需要手动中止才能继续）。
          this.triggerFallback(sleepDecision, error);
          return;
        }

        // 判断可重试
        const retryable = error instanceof LLMErrorClass
          ? error.retryable
          : false;

        if (retryable && attempt < maxRetries && !deltaStarted) {
          attempt += 1;
          const delayMs = 500 * Math.pow(2, attempt - 1); // 500 / 1000 / 2000
          const timer = setTimeout(() => {
            if (signal.aborted) return;
            // 重新发起请求
            this.adapterAbortHandle = adapter.stream(req, handlers, signal);
          }, delayMs);
          this.trackTimer(timer);
        } else if (deltaStarted) {
          // 已经交付过正文（例如流到一半超时）：保留用户看到的内容收尾，
          // 不要再追加罐头短句——实测那样会在真实回复后面接一句
          // "我在的，稍等一下。"，读起来驴唇不对马嘴。
          this.emitError(
            "llm-stream-broken",
            `回复被中断（${error instanceof Error ? error.message : String(error)}）。已保留收到的部分，可点重试重新生成。`,
            true,
          );
          this.finishPartialRun();
        } else {
          // 重试耗尽或不可重试 → fallback
          this.triggerFallback(sleepDecision, error);
        }
      },
    };

    // 首次发起
    this.adapterAbortHandle = adapter.stream(req, handlers, signal);
  }

  /**
   * 触发 fallback：生成角色拟真短句，走秒回路径。
   * 保证 UI 永不白屏/卡死。
   */
  private triggerFallback(
    sleepDecision: IPresenceDecision | null,
    error: unknown,
  ): void {
    const fallbackText = generateFallback(
      this.profile,
      sleepDecision ?? undefined,
    );

    // 推送错误事件（标记为 fallback 触发）
    this.emitError(
      "llm-fallback-triggered",
      `LLM failed, fallback triggered: ${String(error instanceof Error ? error.message : error)}`,
      false,
    );

    // 走秒回路径交付 fallback 文本
    this.deliverInstantMessage(fallbackText);

    this.finishRun();
  }

  /**
   * 关于「暂停 / 恢复」：这个能力**目前没有实现**。
   *
   * 之前这里有 pause()/resume() 两个方法，但它们只发一个生命周期事件、
   * 并不真的暂停定时器——看起来能用、实际是空壳（而且从没有调用方）。
   * 会话切换带来的真实需求由「引擎常驻 + 按会话路由输出」解决：
   * 切走之后引擎继续把这轮说完，消息落进该会话自己的运行时快照。
   *
   * lifecycle 契约里的 `paused` / `resumed` 阶段保留着，将来真要做暂停能力
   * （需要把待交付项排队、暂停期间不推进时间轴）可以直接用。
   */

  // ---------- LLM 流处理 ----------

  private handleDelta(deltaText: string): void {
    if (!this.buffer || !this.typer) return;

    // 秒回模式：不碎片化，delta 由 onComplete 一次交付
    if (!this.config.realismEnabled) {
      return;
    }

    const text = this.feedBody(this.resolveHead(deltaText));
    if (!text) return;

    // 情绪优先用模型自己标的（首行情绪词）；
    // 没标的时候退回关键词推断——情绪跟着内容走，影响接下来这些气泡的立绘。
    this.replyText += text;
    if (!this.tagEmotion) {
      this.buffer.setEmotion(this.inferEmotionWithMood(this.replyText));
    }

    this.buffer.push(text, (chunk) => {
      this.scheduleChunkDelivery(chunk);
    });
  }

  /**
   * 处理流开头：等第一行完整（或攒够长度）再决定怎么切。
   *
   * 模型按约定第一行只写情绪词，但流式分片可能把它切开
   * （"happ" / "y\n"），所以先攒着；判断完把标签行去掉，
   * 剩下的正文照常往下走。首行不是情绪词就原样保留，一个字都不丢。
   */
  private resolveHead(deltaText: string): string {
    if (this.headDecided) return deltaText;

    this.headBuffer += deltaText;
    // 先剥掉前导空白：模型常常先单独吐一个换行，直接拿它当"第一行结束"
    // 会当场判定"没有标签"，后面真正的情绪词就漏进正文了（真机实测踩到）
    const trimmed = this.headBuffer.replace(/^[\s\uFEFF]+/, "");
    const newlineIndex = trimmed.indexOf("\n");
    // 最长合法标签是 "surprised"（9 字符）+ 换行；超过这个长度还没换行，
    // 就说明模型没按约定写，立刻放行——否则短回复会一直卡在这里等到流结束。
    const tooLong = trimmed.length > 12;
    // 万一模型一直在吐空白，也要有个上限，不能无限等下去
    const rawTooLong = this.headBuffer.length > 40;
    if (newlineIndex < 0 && !tooLong && !rawTooLong) {
      // 还没法判断，先攒着
      return "";
    }

    const raw = this.headBuffer;
    this.headBuffer = "";
    this.headDecided = true;

    const { emotion, body } = parseEmotionTagHead(raw);
    if (emotion) {
      this.tagEmotion = emotion;
      this.buffer?.setEmotion(emotion);
    }
    return body;
  }

  /**
   * 正文进入 buffer 之前的统一入口：先过引用标记过滤器。
   *
   * @returns 过滤后可以交付的正文（可能为空——整段都还无法判定）
   */
  private feedBody(text: string): string {
    const filtered = this.quoteFilter.push(text);
    // 摘到片段就立刻匹配成引用块（匹配不上就不挂，正文照旧）
    const preview = this.quoteFilter.preview;
    if (preview !== null && !this.quoteAttached && !this.pendingQuote) {
      this.pendingQuote = findQuoteTarget(preview, this.quoteCandidates);
    }
    return filtered;
  }

  private handleComplete(fullText: string): void {
    if (!this.buffer || !this.typer) return;

    if (!this.config.realismEnabled) {
      // 秒回模式：单条消息立即交付
      this.deliverInstantMessage(fullText);
      this.finishRun();
      return;
    }

    // 流结束时开头还攒着（整条都很短、没有换行）：先把它交给 buffer，
    // 否则这段文本会凭空消失
    this.flushPendingHead();

    // flush 残余 buffer
    const flushed = this.buffer.complete((chunk) => {
      this.scheduleChunkDelivery(chunk);
    });

    // 正常路径：残余文本产生 terminal chunk，由 deliverChunk 在交付后收尾。
    // 边界路径：回复以标点结尾时残余 buffer 为空、或模型返回空文本，
    // 此时不会产生 terminal chunk —— 必须在交付队列末尾补一次收尾，
    // 否则 run 永远停在 streaming，UI 需要手动中止才能继续。
    const hasTerminalChunk = flushed.some((chunk) => chunk.isTerminal);
    if (!hasTerminalChunk) {
      this.scheduleRunCompletion();
    }
  }

  /**
   * 中断收尾：把 buffer 里剩下的文本交付掉，然后结束本次 run。
   *
   * 用在"已经交付过部分内容、随后请求失败"的场景——不能让半句话烂在
   * buffer 里，也不能用罐头短句覆盖用户已经读到的内容。
   */
  private finishPartialRun(): void {
    if (!this.buffer) {
      this.finishRun();
      return;
    }
    // 中断时同样不能把攒着的开头漏掉
    this.flushPendingHead();
    const flushed = this.buffer.complete((chunk) => {
      this.scheduleChunkDelivery(chunk);
    });
    if (!flushed.some((chunk) => chunk.isTerminal)) {
      this.scheduleRunCompletion();
    }
  }

  /**
   * 把还攒在开头的文本交给 buffer（流结束/中断时调用）。
   *
   * 没有它，短回复（一直没出现换行、又没到长度阈值）会被整段吞掉——
   * 这是实测出来的坑：三条既有测试同时挂掉。
   */
  private flushPendingHead(): void {
    if (!this.buffer) return;

    // 情绪头还没判定（整条回复短到没有换行）：先判定，再交给引用过滤器
    if (!this.headDecided) {
      const raw = this.headBuffer;
      this.headBuffer = "";
      this.headDecided = true;

      const { emotion, body } = parseEmotionTagHead(raw);
      if (emotion) {
        this.tagEmotion = emotion;
        this.buffer.setEmotion(emotion);
      }
      this.pushHeadText(this.feedBody(body));
    }

    // 无论走哪条路径：把过滤器扣着的尾巴交出来，一个字都不能烂在手里
    this.pushHeadText(this.quoteFilter.flush());
  }

  /**
   * 交付"还攒在开头的那段正文"。
   *
   * 与 handleDelta 的处理保持一致：模型没给情绪标签时按已产出的正文推断，
   * 再把文本交给 buffer 去切分。
   */
  private pushHeadText(text: string): void {
    if (!text || !this.buffer) return;
    if (!this.tagEmotion) {
      this.replyText += text;
      this.buffer.setEmotion(this.inferEmotionWithMood(this.replyText));
    }
    this.buffer.push(text, (chunk) => {
      this.scheduleChunkDelivery(chunk);
    });
  }

  /**
   * 推断这一条气泡的情绪：文本线索优先，看不出来时退回**当前心情**。
   *
   * 之前文本中性（"嗯，好"）就一律回到 neutral，立绘跟着"情绪归零"；
   * 而人是带着上一轮的情绪说话的——心情低落时，一句平淡的"嗯"也是低落的。
   */
  private inferEmotionWithMood(text: string): CharacterEmotion {
    const inferred = inferEmotion(text);
    if (inferred !== "neutral") return inferred;
    return moodEmotionForSprite(this.mood) ?? "neutral";
  }

  private handleError(error: unknown): void {
    this.emitError("llm-stream-broken", String(error), true);
    this.activeSubscription?.fail(error);
    this.resetRunState();
  }

  // ---------- Chunk 排程与交付 ----------

  /**
   * 为一个 chunk 排程定时器，按时推送 chunk-scheduled → char-reveal-plan → chunk-delivered。
   * 全程通过 AbortController 检查 signal，取消时立即停止。
   *
   * 简化版排队：去掉打字延迟，首个 chunk 立即交付，后续 chunk 间隔 300~600ms。
   * 不做逐字动画，消息直接完整显示。
   */
  private scheduleChunkDelivery(chunk: MessageChunk): void {
    const signal = this.abortController?.signal;

    // 立即递增排程计数器
    const isFirst = this.scheduledChunkCount === 0;
    this.scheduledChunkCount += 1;

    // 由 TypingSimulator 计算本条的打字节奏：
    // - preDeliveryDelayMs：距上一条打完后的停顿（含犹豫概率带来的长停顿）
    // - revealDelays：逐字揭示时间轴（UI 打字机动画）
    // - containsTypo / typoCorrectAtMs：错别字注入与纠错时间点
    const plan = this.typer?.plan(chunk, isFirst) ?? null;

    const now = Date.now();
    // 首条立即交付；后续使用 plan 计算的停顿
    const interChunkDelay = isFirst ? 0 : plan?.preDeliveryDelayMs ?? 300;
    const base = Math.max(now, this.nextDeliveryTime);
    const deliveryTime = base + interChunkDelay;
    // 下一条最早要等本条"打字完成"之后（逐字动画总时长）
    const typingDurationMs = plan
      ? plan.revealDelays[plan.revealDelays.length - 1] ?? 0
      : 0;
    this.nextDeliveryTime = deliveryTime + typingDurationMs;

    const actualDelay = Math.max(0, deliveryTime - now);

    const timer = setTimeout(() => {
      if (signal?.aborted) return;
      this.deliverScheduledChunk({ chunk, plan, isFirst });
    }, actualDelay);

    this.trackTimer(timer);
  }

  /**
   * 交付一条已经排程好的 chunk。
   *
   * 抽成独立方法是为了让"排程"与"交付"分开：定时器只负责到点触发，
   * 交付细节（错别字、逐字时间轴、typing-indicator）集中在一处。
   */
  private deliverScheduledChunk(pending: {
    readonly chunk: MessageChunk;
    readonly plan: ITypingPlan | null;
    readonly isFirst: boolean;
  }): void {
    const { chunk, plan, isFirst } = pending;

    // chunk-scheduled: 占位气泡可先插入
    this.emit({
      kind: "chunk-scheduled",
      pendingMessageId: chunk.id,
      delayMs: 0,
    });

    // 错别字：仅在确实替换成功时标记（避免"没有错字却显示已纠正"）
    const typoResult =
      plan?.containsTypo && this.typer ? this.typer.applyTypo(chunk.text) : null;
    const hasTypo =
      typoResult !== null && typoResult.typoText !== typoResult.correctedText;

    // char-reveal-plan: 逐字揭示时间轴（UI 据此播放打字机动画）
    this.emit({
      kind: "char-reveal-plan",
      messageId: chunk.id,
      revealDelays: plan?.revealDelays ?? [],
      containsTypo: hasTypo,
      typoCorrectAtMs: hasTypo ? plan?.typoCorrectAtMs ?? undefined : undefined,
      correctedText: hasTypo ? typoResult?.correctedText : undefined,
    });

    // chunk-delivered: 立即交付
    this.deliverChunk(chunk, hasTypo ? typoResult?.typoText : undefined);

    // 关闭 typing-indicator（首个 chunk 交付后）
    if (isFirst) {
      this.emit({
        kind: "typing-indicator",
        active: false,
        estimatedRemainingMs: 0,
      });
    }
  }

  /**
   * 取走"本轮待挂的引用块"。
   *
   * 只挂到本轮**第一条**气泡上：微信里引用是"这条消息是冲着哪句说的"，
   * 后续几条继续挂着同一段引用会显得唠叨。
   */
  private takePendingQuote(): IMessageQuote | null {
    if (this.quoteAttached || !this.pendingQuote) return null;
    this.quoteAttached = true;
    return this.pendingQuote;
  }

  /**
   * 将 MessageChunk 包装为 IMessage 并推送 chunk-delivered。
   * 末端 chunk 触发 lifecycle completed。
   */
  private deliverChunk(chunk: MessageChunk, displayText?: string): void {
    const quote = this.takePendingQuote();
    const message: ITextMessage = {
      id: chunk.id,
      type: "text",
      senderId: this.profile.id,
      recipientId: this.userId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      chunkSequence: chunk.chunkSequence,
      emotion: chunk.emotion,
      // 含错别字时交付错字版本，纠正时间点由 UI 替换为正确文本
      text: displayText ?? chunk.text,
      sourceOffset: chunk.sourceOffset,
      ...(quote ? { quote } : {}),
    };

    this.emit({ kind: "chunk-delivered", message });

    this.deliveredChunkCount += 1;
    this.lastChunkEmotion = chunk.emotion;
    this.lastTextMessageId = message.id;

    if (chunk.isTerminal) {
      this.finishRun();
    }
  }

  /**
   * 在交付队列末尾排程一次收尾（用于本轮没有 terminal chunk 的情况）。
   *
   * 时间点取"最后一个已排程 chunk 的交付时间 + 1ms"，
   * 保证 completed 一定晚于最后一条消息交付。
   */
  private scheduleRunCompletion(): void {
    if (this.scheduledChunkCount === 0) {
      // 本轮没有任何 chunk（空回复）：立即收尾
      this.finishRun();
      return;
    }

    const signal = this.abortController?.signal;
    const delay = Math.max(0, this.nextDeliveryTime - Date.now()) + 1;
    const timer = setTimeout(() => {
      if (signal?.aborted) return;
      this.finishRun();
    }, delay);
    this.trackTimer(timer);
  }

  /**
   * 统一的 run 终止出口：推送 completed → 通知订阅者 → 重置运行状态。
   * 所有正常结束路径（秒回 / terminal chunk / 队列末尾收尾）都必须走这里。
   */
  private finishRun(): void {
    // 撤回优先于贴图：若是"说漏嘴→撤回"，后面再跟一张表情很像在揶揄自己；
    // 这里直接走撤回路径，由撤回定时器负责本轮收尾。
    if (this.maybeScheduleRecall()) return;

    // 收尾时按概率补一张贴图：微信里贴图总是跟在文字后面，
    // 且不该打断正在逐条弹出的气泡，所以放在"这一轮说完了"之后。
    this.maybeDeliverSticker();
    this.completeRun();
  }

  /**
   * 统一的 run 正常结束（含撤回结束后）。
   *
   * 从 finishRun 里拆出来是因为撤回要"晚几秒才发生"：
   * 那几秒里 run 还不能算结束（气泡可能才刚弹出来），
   * 收尾动作得由撤回定时器在撤回事件之后再触发一次。
   */
  private completeRun(): void {
    this.emitLifecycle("completed");
    this.activeSubscription?.done();
    this.resetRunState();
  }

  /**
   * 按 `recallProbability` 概率把刚发的那条文本撤回。
   *
   * 返回 true 表示"已排程，本轮收尾交给撤回定时器"。
   *
   * 为什么要延迟几百毫秒到两秒多：真人撤回不是反射动作——
   * 发出去了、看一眼、觉得不妥、再点撤回。秒撤读起来像程序行为。
   */
  private maybeScheduleRecall(): boolean {
    const probability = this.config.recallProbability ?? 0;
    if (!(probability > 0)) return false;
    // 本轮没说过话（空回复/睡眠静默）：没有可撤回的目标
    if (this.deliveredChunkCount === 0) return false;
    const targetMessageId = this.lastTextMessageId;
    if (!targetMessageId) return false;
    if (Math.random() >= probability) return false;

    const notice = buildRecallNotice(this.profile.displayName);
    // 1.2s ~ 2.5s：够用户读完那句话，又不会长到让人以为界面卡住
    const delayMs = 1200 + Math.floor(Math.random() * 1300);
    const signal = this.abortController?.signal;
    const timer = setTimeout(() => {
      if (signal?.aborted) return;
      this.emit({ kind: "recall", targetMessageId, notice });
      this.completeRun();
    }, delayMs);
    this.trackTimer(timer);
    return true;
  }

  /**
   * 按 `stickerFrequency` 概率追加一条贴图消息。
   *
   * 为什么不放在流式过程中：拟真模式下气泡是逐条弹出的，
   * 中途插一张贴图会打断节奏；而且模型还没说完，情绪也未必定型。
   */
  private maybeDeliverSticker(): void {
    if (this.stickerDeliveredThisRun) return;
    // 本轮没有任何文字（空回复）：不发贴图，免得只剩一张表情更莫名其妙
    if (this.deliveredChunkCount === 0) return;

    const frequency = this.profile.personalityTraits.stickerFrequency ?? 0;
    if (!(frequency > 0)) return;
    if (Math.random() >= frequency) return;

    const sticker = pickSticker(this.lastChunkEmotion);
    const message: IStickerMessage = {
      id: `sticker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "sticker",
      senderId: this.profile.id,
      recipientId: this.userId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      chunkSequence: this.deliveredChunkCount,
      emotion: this.lastChunkEmotion,
      stickerPackId: STICKER_PACK_ID,
      stickerId: sticker.id,
      fallbackText: sticker.fallbackText,
    };
    this.emit({ kind: "chunk-delivered", message });
    this.stickerDeliveredThisRun = true;
  }

  /** 秒回模式下的单条消息交付。 */
  private deliverInstantMessage(fullText: string): void {
    if (!this.chunker) return;
    // 秒回/降级路径：同样先剥掉首行情绪词（模型可能照着约定写了）
    const { emotion, body } = parseEmotionTagHead(fullText);
    // 秒回模式没有流式攒字的过程：整段都到齐了，一次过滤就能收口
    const filter = new CharacterQuoteFilter();
    const visible = filter.push(body) + filter.flush();
    if (filter.preview !== null) {
      this.pendingQuote = findQuoteTarget(filter.preview, this.quoteCandidates);
    }
    const chunk = this.chunker.next(
      visible,
      emotion ?? this.inferEmotionWithMood(visible),
      true,
    );
    const quote = this.takePendingQuote();
    const message: ITextMessage = {
      id: chunk.id,
      type: "text",
      senderId: this.profile.id,
      recipientId: this.userId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      chunkSequence: chunk.chunkSequence,
      emotion: chunk.emotion,
      // 用剥离标签后的正文：秒回路径此前交付的是原始 fullText，
      // 首行的情绪词（如 "neutral"）会漏进气泡里
      text: chunk.text,
      sourceOffset: 0,
      ...(quote ? { quote } : {}),
    };
    this.emit({ kind: "chunk-delivered", message });
    // 秒回路径同样算"本轮交付了内容"：否则收尾时的贴图判断会误认为空回复
    this.deliveredChunkCount += 1;
    this.lastChunkEmotion = chunk.emotion;
    this.lastTextMessageId = message.id;
  }

  // ---------- 引擎事件工具 ----------

  private emit(event: IEngineEvent): void {
    const sub = this.activeSubscription;
    const ctx = this.runContext;
    if (!sub || !ctx) return;

    const output: IRealismEngineOutput = {
      sessionId: ctx.sessionId,
      characterId: ctx.characterId,
      sequence: ctx.sequenceCounter,
      emittedAt: Date.now(),
      event,
    };
    ctx.sequenceCounter += 1;
    sub.emit(output);
  }

  private emitLifecycle(phase: "started" | "paused" | "resumed" | "completed" | "aborted", reason?: string): void {
    this.emit({ kind: "lifecycle", phase, reason });
  }

  /**
   * 推送在场状态更新（在线 / 忙碌 / 已就寝）。
   *
   * 事件里的 emotion 之前恒为 "sleepy"——那是"只管睡眠"时代的写法，
   * 忙碌时带上"困倦"就不对了。现在的取值：睡着是 sleepy，
   * 其余情况用当前心情（心情也是角色的状态，两者本来就该一致）。
   */
  private emitPresenceUpdate(decision: {
    presence: CharacterPresence;
    displayText: string;
    isSleeping?: boolean;
  }): void {
    this.emit({
      kind: "presence",
      status: decision.presence,
      emotion: decision.isSleeping
        ? "sleepy"
        : moodEmotionForSprite(this.mood) ?? "neutral",
      displayText: decision.displayText,
    });
  }

  private emitError(code: EngineErrorCode, message: string, recoverable: boolean): void {
    this.emit({ kind: "error", code, message, recoverable });
  }

  // ---------- 定时器管理 ----------

  private trackTimer(timer: ReturnType<typeof setTimeout>): void {
    this.pendingTimers.add(timer);
    const signal = this.abortController?.signal;
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.pendingTimers.delete(timer);
        },
        { once: true },
      );
    }
  }

  private clearAllTimers(): void {
    for (const t of this.pendingTimers) {
      clearTimeout(t);
    }
    this.pendingTimers.clear();
  }

  private resetRunState(): void {
    this.buffer = null;
    this.chunker = null;
    this.typer = null;
    this.presence = null;
    this.runContext = null;
    this.deliveredChunkCount = 0;
    this.scheduledChunkCount = 0;
    this.lastTextMessageId = null;
    this.nextDeliveryTime = 0;
    // 引用相关状态一律清空：下一轮的开头要重新判定一遍
    this.quoteFilter = new CharacterQuoteFilter();
    this.pendingQuote = null;
    this.quoteAttached = false;
    this.pendingTimers.clear();
    this.abortController = null;
    this.adapterAbortHandle = null;
    this.streamInProgress = false;
  }
}
