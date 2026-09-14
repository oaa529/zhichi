/**
 * @file chatStore.ts
 * Zustand 全局消息流 Store。
 *
 * 设计原则：
 * - 唯一消息流来源：引擎推送的 IRealismEngineOutput
 * - UI 组件通过 selector 订阅所需切片，避免全量重渲
 * - 引擎订阅句柄存储于此，组件卸载时自动 unsubscribe
 *
 * 关键状态机：
 *   idle → streaming → (paused) → completed
 *   idle ─────────────────────────────► idle (秒回模式直接交付)
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  CharacterEmotion,
  CharacterPresence,
  IEngineSubscription,
  IEngineSnapshot,
  IMessage,
  IMessageQuote,
  IRealismEngineOutput,
  ISimulationConfig,
  ITypingIndicatorEvent,
  IChunkScheduledEvent,
  IChunkDeliveredEvent,
  ICharRevealPlanEvent,
  IRecallEvent,
  IPresenceEvent,
  ILifecycleEvent,
  IEngineErrorEvent,
  SessionPhase,
} from "@wechat-rp/shared-types";
import type { RealismEngine } from "@wechat-rp/core";
import {
  SCHEMA_VERSION,
  migrateSnapshot,
  SELF_RECALL_NOTICE,
  toRecallMessage,
} from "@wechat-rp/core";
import { idbStorage, STORAGE_KEY } from "./persistMiddleware";
import { useSessionStore } from "./sessionStore";

/** 单条消息的运行时视图状态（包裹原始 IMessage + 揭示动画状态）。 */
export interface IMessageRuntime {
  readonly message: IMessage;
  /** 是否已完全揭示（逐字动画完成）。 */
  revealed: boolean;
  /** 揭示延迟计划（来自 char-reveal-plan 事件）。 */
  revealDelays?: ReadonlyArray<number>;
  /** 是否包含错别字，纠错时间点。 */
  typoCorrectAtMs?: number;
  /** 纠错后的正确文本（含错别字时提供，UI 在纠错时间点替换）。 */
  correctedText?: string;
  /** 是否处于"占位气泡"状态（chunk-scheduled 但未 delivered）。 */
  pending: boolean;
}

  /** 排队中的用户消息（引用信息随消息一起排队，不能丢）。 */
export interface IQueuedUserMessage {
  readonly text: string;
  readonly quote?: IMessageQuote;
}

export interface IChatSessionState {
  // ---------- 消息流 ----------
  readonly messages: ReadonlyArray<IMessageRuntime>;
  /**
   * 待发送队列：对方正在回复时用户又发出的消息。
   *
   * 微信式体验：回复中仍可继续说话，消息立即上屏，
   * 等当前回复结束后按顺序自动触发下一轮（不打断正在生成的内容）。
   */
  readonly queuedUserTexts: ReadonlyArray<IQueuedUserMessage>;
  /** 待揭示中的 chunk 数量（用于"对方正在输入..."状态）。 */
  readonly pendingCount: number;
  /**
   * 缓存 char-reveal-plan 事件。引擎在 chunk-delivered 之前 emit
   * char-reveal-plan，但此时消息尚未插入 messages 数组，
   * 无法更新 revealDelays。缓存到此处，chunk-delivered 到达时合并。
   */
  readonly pendingRevealPlans: Readonly<Record<string, ICharRevealPlanEvent>>;

  /**
   * "以下为新消息"分隔线的位置（第一条未读消息的 ID）。
   *
   * App 在切进会话时从 sessionStore 取一次（取完即清），
   * 只在这次浏览里画那条线——看过之后再切回来不该又画一遍。
   */
  readonly unreadMarkerMessageId: string | null;

  // ---------- 在场状态 ----------
  readonly presence: CharacterPresence;
  readonly presenceText: string;
  readonly typingIndicator: {
    readonly active: boolean;
    readonly estimatedRemainingMs: number;
  };

  // ---------- 生命周期 ----------
  readonly phase: SessionPhase;
  readonly lastError: { code: string; message: string } | null;

  // ---------- 拟真配置 ----------
  readonly simulationConfig: ISimulationConfig;

  // ---------- 持久化 ----------
  /** 是否已从 IndexedDB 完成 hydration。 */
  hydrated: boolean;

  // ---------- 引擎引用 ----------
  /** 当前活跃的引擎订阅，组件卸载时必须清理。 */
  engineSubscription: IEngineSubscription | null;
  /** 引擎实例引用（注入式，store 不负责创建引擎）。 */
  engine: RealismEngine | null;

  // ---------- Actions ----------
  /** 注入引擎并订阅其输出流。 */
  attachEngine: (engine: RealismEngine) => void;
  /** 注入后开始一次流（外部调用 engine.startStream 前需先 attach）。 */
  resetSession: () => void;
  /** 更新拟真配置。 */
  updateSimulationConfig: (patch: Partial<ISimulationConfig>) => void;
  /** 中止当前流。 */
  abortStream: () => void;
  /** 清理：组件卸载时调用，取消订阅。 */
  dispose: () => void;
  /** 从快照恢复状态（hydration 完成后调用）。 */
  hydrateFromSnapshot: (snapshot: IEngineSnapshot) => void;
  /** 设置/清除"以下为新消息"分隔线的位置。 */
  setUnreadMarker: (messageId: string | null) => void;
  /** 标记 hydration 完成。 */
  markHydrated: () => void;

  /**
   * 调试用：直接向消息流追加一条消息，绕过引擎。
   * 仅供闭环测试多态消息渲染使用（系统/撤回/图片/语音/贴图）。
   * 正式产品中消息只能由引擎通过 IRealismEngineOutput 推送。
   */
  appendDebugMessage: (message: IMessage) => void;

  /**
   * 添加用户发送的消息（立即显示在聊天界面）。
   * 在调用 engine.startStreamWithAdapter 之前调用。
   */
  addUserMessage: (text: string, sessionId: string, quote?: IMessageQuote) => void;

  /**
   * 追加一条用户发出的贴图（表情）。
   *
   * 与角色发的贴图共用同一套内置素材；发送后照样会请求模型，
   * 让角色对"用户发了个[微笑]"作出反应，而不是石沉大海。
   */
  addStickerMessage: (
    sessionId: string,
    sticker: {
      readonly stickerPackId: string;
      readonly stickerId: string;
      readonly fallbackText: string;
    },
  ) => void;

  /**
   * 追加一条角色消息（不经过引擎）。
   *
   * 用途：导入的社区角色卡自带开场白（SillyTavern 的 `first_mes`），
   * 新会话由角色先开口说第一句话。phase 保持 idle——这不是一次"回复"。
   */
  appendCharacterMessage: (params: {
    readonly text: string;
    readonly sessionId: string;
    readonly characterId: string;
    readonly emotion?: CharacterEmotion;
  }) => void;

  /** 回复进行中时排队一条用户消息（立即上屏，稍后自动发送）。 */
  enqueueUserMessage: (text: string, sessionId: string, quote?: IMessageQuote) => void;
  /**
   * 把一条排队消息塞回**队首**。
   *
   * 用在"轮到它了但引擎正忙（例如背景里那轮还没跑完）"的时候：
   * `shiftQueuedUserText` 已经把它取出来了，不塞回去就等于**悄悄丢掉**
   * 一条已经上屏的用户消息——用户只会看到自己说的话没人回。
   */
  unshiftQueuedUserText: (item: IQueuedUserMessage) => void;
  /** 取出队首消息（队列为空返回 null）。 */
  shiftQueuedUserText: () => IQueuedUserMessage | null;

  /**
   * 删除从指定消息开始到末尾的所有消息。
   * 用于「重新生成」：把这一轮 AI 回复整段撤掉再重发。
   */
  removeMessagesFrom: (messageId: string) => void;

  /**
   * 删除单条消息（微信式"删除这条"）。
   *
   * 删掉之后它会同时从 LLM 历史里消失（历史由消息列表实时转换），
   * 所以也可以用来"让角色忘记这一句"。
   */
  deleteMessage: (messageId: string) => void;

  /**
   * 撤回单条消息（微信式"撤回这条"）。
   *
   * 与删除的区别：删除是"自己看不见了"，撤回是"双方都看不见了"——
   * 气泡当场变成"你撤回了一条消息"的提示，正文连同 LLM 历史一起消失。
   */
  recallMessage: (messageId: string, notice?: string) => void;

  /** 内部：处理引擎事件。 */
  _handleEngineOutput: (output: IRealismEngineOutput) => void;
}

const DEFAULT_PRESENCE_TEXT = "在线";
const DEFAULT_TYPING_INDICATOR = { active: false, estimatedRemainingMs: 0 };

const DEFAULT_SIMULATION_CONFIG: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "normal",
  hesitationProbability: 0.15,
  typoRate: 0.05,
  recallProbability: 0.05,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: true,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 3500,
};

/**
 * 恢复存档时的合并策略。
 *
 * zustand persist 默认是浅合并：存档里的 `simulationConfig` 会**整体替换**
 * 掉默认值，于是后来新加的旋钮（如 recallProbability）对老用户永远是
 * undefined，功能默默失效。这里给配置对象补一层默认值——
 * 新旋钮开箱即生效，用户已经调过的值原样保留。
 */
export function mergePersistedChatState(
  persisted: unknown,
  current: IChatSessionState,
): IChatSessionState {
  const saved = (persisted ?? {}) as Partial<IChatSessionState>;
  return {
    ...current,
    ...saved,
    // 老存档里没有排队字段：一律归一化成数组，别让 undefined 漏进队列消费逻辑
    queuedUserTexts: Array.isArray(saved.queuedUserTexts)
      ? saved.queuedUserTexts
      : [],
    simulationConfig: {
      ...DEFAULT_SIMULATION_CONFIG,
      ...(saved.simulationConfig ?? {}),
    },
  };
}

/** 构造一条用户消息的运行时包装（上屏即完整显示）。 */
function makeUserMessageRuntime(
  text: string,
  sessionId: string,
  quote?: IMessageQuote,
): IMessageRuntime {
  const message: IMessage = {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "text",
    senderId: "user",
    recipientId: "character",
    sessionId,
    text,
    timestamp: Date.now(),
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
    ...(quote ? { quote } : {}),
  };
  return { message, revealed: true, pending: false };
}

/**
 * Zustand store 创建函数。
 * 引擎实例由外部注入，store 不负责 LLM 调用，仅做状态镜像。
 *
 * 使用 persist middleware 将可序列化状态持久化到 IndexedDB。
 * 不持久化：engine / engineSubscription / pendingRevealPlans（瞬态）。
 */
export const useChatStore = create<IChatSessionState>()(
  persist(
    (set, get) => ({
      messages: [],
      queuedUserTexts: [],
      pendingCount: 0,
      pendingRevealPlans: {},
      unreadMarkerMessageId: null,
      presence: "online",
      presenceText: DEFAULT_PRESENCE_TEXT,
      typingIndicator: DEFAULT_TYPING_INDICATOR,
      phase: "idle",
      lastError: null,
      simulationConfig: DEFAULT_SIMULATION_CONFIG,
      hydrated: false,
      engineSubscription: null,
      engine: null,

      attachEngine: (engine) => {
        const prev = get().engineSubscription;
        if (prev && !prev.closed) prev.unsubscribe();

        const sub = engine.subscribe(
          (output) => get()._handleEngineOutput(output),
          (error) => {
            set({
              phase: "aborted",
              lastError: { code: "engine-error", message: String(error) },
            });
          },
          () => {
            set({ phase: "completed" });
          },
        );
        // 同步恢复的 simulationConfig 到引擎（hydration 恢复的 config 可能与默认不同）
        const currentConfig = get().simulationConfig;
        engine.updateConfig(currentConfig);
        // 不覆盖 interrupted phase（hydration 标记的"上次回复未完成"）
        const currentPhase = get().phase;
        set({
          engine,
          engineSubscription: sub,
          phase: currentPhase === "interrupted" ? "interrupted" : "idle",
        });
      },

      resetSession: () => {
        const sub = get().engineSubscription;
        if (sub && !sub.closed) sub.unsubscribe();
        set({
          messages: [],
          queuedUserTexts: [],
          pendingCount: 0,
          phase: "idle",
          lastError: null,
          typingIndicator: DEFAULT_TYPING_INDICATOR,
          engineSubscription: null,
        });
      },

      updateSimulationConfig: (patch) => {
        const next = { ...get().simulationConfig, ...patch };
        set({ simulationConfig: next });
        get().engine?.updateConfig(patch);
      },

      abortStream: () => {
        get().engine?.abort("user-requested");
        set({
          phase: "aborted",
          typingIndicator: DEFAULT_TYPING_INDICATOR,
          // 中止后残留的占位计数会干扰"对方正在输入"派生状态，需一并清零
          pendingCount: 0,
        });
      },

      dispose: () => {
        const sub = get().engineSubscription;
        if (sub && !sub.closed) sub.unsubscribe();
        set({ engine: null, engineSubscription: null, phase: "idle" });
      },

      hydrateFromSnapshot: (snapshot) => {
        // 合并 messageRuntimes 与 messages
        const runtimes = snapshot.messageRuntimes;
        const messagesWithRuntimes: IMessageRuntime[] = snapshot.messages.map((msg) => {
          // 尝试匹配 runtime（按索引顺序，因为 messages 和 messageRuntimes 应一一对应）
          const idx = snapshot.messages.indexOf(msg);
          const rt = runtimes[idx];
          return {
            message: msg,
            revealed: rt?.revealed ?? true,
            revealDelays: rt?.revealDelays,
            typoCorrectAtMs: rt?.typoCorrectAtMs,
            pending: false,
          };
        });

        set({
          messages: messagesWithRuntimes,
          presence: snapshot.presence,
          presenceText: snapshot.presenceText,
          simulationConfig: snapshot.simulationConfig,
          lastError: snapshot.lastError,
          // streaming 状态刷新后标记为 interrupted
          phase: snapshot.lastPhase === "streaming" ? "interrupted" : snapshot.lastPhase,
          hydrated: true,
        });
      },

      markHydrated: () => set({ hydrated: true }),

      setUnreadMarker: (messageId) =>
        set({ unreadMarkerMessageId: messageId }),

      appendDebugMessage: (message) => {
        const runtime: IMessageRuntime = {
          message,
          revealed: true,
          pending: false,
        };
        set((state) => ({ messages: [...state.messages, runtime] }));
      },

      addUserMessage: (text, sessionId, quote) => {
        const runtime = makeUserMessageRuntime(text, sessionId, quote);
        set((state) => ({
          messages: [...state.messages, runtime],
          phase: "streaming",
        }));
      },

      addStickerMessage: (sessionId, sticker) => {
        const now = Date.now();
        const message: IMessage = {
          id: `sticker-${now}-${Math.random().toString(36).slice(2, 6)}`,
          type: "sticker",
          senderId: "user",
          recipientId: "character",
          sessionId,
          stickerPackId: sticker.stickerPackId,
          stickerId: sticker.stickerId,
          fallbackText: sticker.fallbackText,
          timestamp: now,
          chunkSequence: 0,
          emotion: "neutral",
        };
        set((state) => ({
          messages: [...state.messages, { message, revealed: true, pending: false }],
          phase: "streaming",
        }));
      },

      appendCharacterMessage: ({ text, sessionId, characterId, emotion = "neutral" }) => {
        const now = Date.now();
        const message: IMessage = {
          id: `greet-${now}-${Math.random().toString(36).slice(2, 6)}`,
          type: "text",
          senderId: characterId,
          recipientId: "user",
          sessionId,
          text,
          timestamp: now,
          chunkSequence: 0,
          emotion,
          sourceOffset: 0,
        };
        set((state) => ({
          messages: [...state.messages, { message, revealed: true, pending: false }],
        }));
      },

      enqueueUserMessage: (text, sessionId, quote) => {
        // 只上屏、不改 phase：此时引擎仍在处理上一条回复，
        // 若把 phase 置为 streaming，队列消费者会误判"引擎忙"
        // 而永不消费队列（消息就此卡住）。
        const runtime = makeUserMessageRuntime(text, sessionId, quote);
        set((state) => ({
          messages: [...state.messages, runtime],
          queuedUserTexts: [
            ...state.queuedUserTexts,
            quote ? { text, quote } : { text },
          ],
        }));
      },

      shiftQueuedUserText: () => {
        const queue = get().queuedUserTexts;
        const next = queue[0] ?? null;
        if (next === null) return null;
        set({ queuedUserTexts: queue.slice(1) });
        return next;

      },

      unshiftQueuedUserText: (item) => {
        set((state) => ({
          queuedUserTexts: [item, ...state.queuedUserTexts],
        }));
      },

      removeMessagesFrom: (messageId) => {
        set((state) => {
          const index = state.messages.findIndex(
            (runtime) => runtime.message.id === messageId,
          );
          // 找不到就什么都不做（例如刚好被其他路径清掉了）
          if (index < 0) return {};
          return {
            messages: state.messages.slice(0, index),
            // 撤掉消息后不该还挂着"正在输入"或占位计数
            pendingCount: 0,
            typingIndicator: DEFAULT_TYPING_INDICATOR,
          };
        });
      },

      deleteMessage: (messageId) => {
        set((state) => {
          const next = state.messages.filter(
            (runtime) => runtime.message.id !== messageId,
          );
          // 找不到就什么都不做（可能刚被别的路径清掉了）
          if (next.length === state.messages.length) return {};
          return { messages: next };
        });
      },

      recallMessage: (messageId, notice = SELF_RECALL_NOTICE) => {
        set((state) => {
          let hit = false;
          const next = state.messages.map((runtime) => {
            if (runtime.message.id !== messageId) return runtime;
            // 已经是撤回提示就别重复处理（重复触发不该覆盖提示文案）
            if (runtime.message.type === "recall") return runtime;
            hit = true;
            return {
              ...runtime,
              message: toRecallMessage(runtime.message, notice),
            };
          });
          if (!hit) return {};
          return { messages: next };
        });
      },

  _handleEngineOutput: (output) => {
    const event = output.event;
    switch (event.kind) {
      case "typing-indicator": {
        const e: ITypingIndicatorEvent = event;
        set({
          typingIndicator: {
            active: e.active,
            estimatedRemainingMs: e.estimatedRemainingMs,
          },
        });
        break;
      }
      case "context-usage": {
        // 上下文占用是按会话记的：切走再切回来还能看到上一次的数字。
        // 存进 sessionStore 的非持久化字段，刷新后重发一次自然就有了。
        const sessions = useSessionStore.getState();
        sessions.setContextUsage(output.sessionId, event.usage);
        // 同时累加"这个会话一共花了多少"（跨刷新保留）
        sessions.addTokenUsage(output.sessionId, event.usage.estimatedTokens);
        break;
      }
      case "chunk-scheduled": {
        const e: IChunkScheduledEvent = event;
        // 插入占位气泡
        set((state) => ({
          pendingCount: state.pendingCount + 1,
          // 占位气泡以 placeholder 形式存在；真实交付时替换
          // 此处不插入运行时，等待 chunk-delivered
        }));
        // 注：占位 ID 仅记录，UI 可选择渲染 loading 气泡
        void e;
        break;
      }
      case "char-reveal-plan": {
        const e: ICharRevealPlanEvent = event;
        set((state) => {
          // 消息可能尚未插入（char-reveal-plan 在 chunk-delivered 之前 emit）
          const exists = state.messages.some(
            (rt) => rt.message.id === e.messageId,
          );
          if (exists) {
            return {
              messages: state.messages.map((rt) =>
                rt.message.id === e.messageId
                  ? {
                      ...rt,
                      revealDelays: e.revealDelays,
                      typoCorrectAtMs: e.typoCorrectAtMs,
                      correctedText: e.correctedText,
                    }
                  : rt,
              ),
            };
          }
          // 缓存，等 chunk-delivered 到达时合并
          return {
            pendingRevealPlans: {
              ...state.pendingRevealPlans,
              [e.messageId]: e,
            },
          };
        });
        break;
      }
      case "chunk-delivered": {
        const e: IChunkDeliveredEvent = event;
        set((state) => {
          // 从缓存取 char-reveal-plan 信息
          const plan = state.pendingRevealPlans[e.message.id];
          const runtime: IMessageRuntime = {
            message: e.message,
            revealed: false,
            revealDelays: plan?.revealDelays,
            typoCorrectAtMs: plan?.typoCorrectAtMs,
            correctedText: plan?.correctedText,
            pending: false,
          };
          // 清除缓存
          const updatedPlans = { ...state.pendingRevealPlans };
          delete updatedPlans[e.message.id];
          return {
            messages: [...state.messages, runtime],
            pendingCount: Math.max(0, state.pendingCount - 1),
            pendingRevealPlans: updatedPlans,
            phase: "streaming",
          };
        });
        break;
      }
      case "recall": {
        const e: IRecallEvent = event;
        set((state) => ({
          messages: state.messages.map((rt) =>
            rt.message.id === e.targetMessageId
              // 用 toRecallMessage 重建而不是在原对象上改 type：
              // 否则被撤回的正文会继续留在内存/持久化里，刷新还能捞出来
              ? { ...rt, message: toRecallMessage(rt.message, e.notice) }
              : rt,
          ),
        }));
        break;
      }
      case "presence": {
        const e: IPresenceEvent = event;
        set({ presence: e.status, presenceText: e.displayText });
        break;
      }
      case "lifecycle": {
        const e: ILifecycleEvent = event;
        if (e.phase === "started") {
          // 新一轮开始：清除上一轮的错误提示
          set({ phase: "streaming", lastError: null });
        } else if (e.phase === "completed") {
          set({
            phase: "completed",
            typingIndicator: DEFAULT_TYPING_INDICATOR,
            // 收尾时占位气泡应已全部交付；防御性清零避免残留
            pendingCount: 0,
          });
        } else if (e.phase === "aborted") {
          set({
            phase: "aborted",
            typingIndicator: DEFAULT_TYPING_INDICATOR,
            pendingCount: 0,
          });
        } else if (e.phase === "paused") {
          set({ phase: "paused" });
        } else if (e.phase === "resumed") {
          set({ phase: "streaming" });
        }
        break;
      }
      case "error": {
        const e: IEngineErrorEvent = event;
        set({ lastError: { code: e.code, message: e.message } });
        if (!e.recoverable) {
          set({ phase: "aborted" });
        }
        break;
      }
      default: {
        // exhaustiveness check
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => idbStorage),
      version: SCHEMA_VERSION,
      // 只持久化可序列化字段，排除引擎引用/订阅/瞬态缓存
      partialize: (state) => ({
        messages: state.messages,
        // 排队中的用户消息也要存：它们已经上屏，丢了就永远等不到回复
        queuedUserTexts: state.queuedUserTexts,
        pendingCount: state.pendingCount,
        presence: state.presence,
        presenceText: state.presenceText,
        typingIndicator: state.typingIndicator,
        phase: state.phase,
        lastError: state.lastError,
        simulationConfig: state.simulationConfig,
      }),
      // 合并策略见 mergePersistedChatState（给新增旋钮补默认值）
      merge: mergePersistedChatState,
      // hydration 完成后标记（用 onRehydrateStorage 处理 streaming → interrupted 转换）
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.warn("[chatStore] hydration failed:", error);
        }
        if (state) {
          const mutable = state as { phase: SessionPhase };
          if (mutable.phase === "streaming") {
            mutable.phase = "interrupted";
          }
        }
        // hydrated 标记由 App.tsx 的 onFinishHydration 回调设置
        // 这里不设置，因为无存储数据时 state 可能不完整
      },
      // 迁移函数
      migrate: (persisted, version) => {
        return migrateSnapshot(persisted, version);
      },
    },
  ),
);
