/**
 * @file sessionStore.ts
 * 多会话顶层 Store。管理会话列表、通讯录、角色档案、API配置、提示词模板。
 *
 * chatStore 仍保留为活跃会话的运行时切片（messages/presence/phase）。
 * sessionStore 管理「有哪些会话/角色」的元数据。
 *
 * 切换会话时：
 * 1. sessionStore.saveActiveSessionRuntime(runtime) — 保存当前会话运行时
 * 2. sessionStore.switchSession(newId) — 切换 activeSessionId
 * 3. chatStore.loadSessionRuntime(runtime) — 从 sessionStore 恢复新会话运行时
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  ICharacterProfile,
  IApiConfig,
  IMessage,
  ISession,
  ISimulationConfig,
  IContact,
  IPromptTemplate,
  ApiProvider,
  IRealtimeAIConfig,
  IUserProfile,
  IMemory,
  ILoreEntry,
  IPlotEvent,
  IPlotState,
  IPlotStatePatch,
  IDigestConfig,
  IDigestReport,
  ISessionRuntimeSnapshot,
  IContextUsage,
} from "@wechat-rp/shared-types";
import { PROVIDER_PRESETS } from "@wechat-rp/shared-types";
import {
  SCHEMA_VERSION,
  createEmptyPlotState,
  forgetEventsFromTexts,
  forgetMemoriesFromTexts,
  migrateSnapshot,
  rollbackPlotState,
  sanitizeSessionSnapshot,
  toRecallMessage,
} from "@wechat-rp/core";
import type { DigestFailureReason } from "@wechat-rp/core";
import { idbStorage } from "./persistMiddleware";

// 会话运行时快照已上移到 shared/types（备份契约也需要它），
// 这里原样再导出，保持 `@wechat-rp/ui-wechat` 既有引用不破。
export type { ISessionRuntimeSnapshot } from "@wechat-rp/shared-types";

/**
 * 会话快照里的消息项。
 *
 * `ISessionRuntimeSnapshot.messages` 在 shared/types 里刻意留成
 * `ReadonlyArray<unknown>`（避免公共契约反向依赖 UI 的运行时类型），
 * 这里用最小形状断言回来，只取撤回需要的字段。
 */
interface ISessionMessageItem {
  readonly message: IMessage;
  readonly revealed?: boolean;
  readonly pending?: boolean;
}

export interface ISessionStoreState {
  // ---------- 会话 ----------
  readonly sessions: Record<string, ISession>;
  readonly activeSessionId: string | null;
  /** 每会话的运行时快照（切换时保存/恢复）。 */
  readonly sessionRuntimes: Record<string, ISessionRuntimeSnapshot>;
  /**
   * 每会话的输入草稿。
   *
   * 微信式体验：在 A 会话打了一半切走，草稿留在 A；切回来时恢复，
   * 而不是把半句话带到别的会话里。
   */
  readonly drafts: Record<string, string>;

  // ---------- 通讯录 ----------
  readonly contacts: Record<string, IContact>;

  // ---------- 角色 ----------
  readonly characters: Record<string, ICharacterProfile>;

  // ---------- 提示词模板 ----------
  readonly promptTemplates: Record<string, IPromptTemplate>;

  // ---------- API 配置 ----------
  readonly apiConfig: IApiConfig;
  /** 内存态 API Key（不持久化）。 */
  apiKey: string;

  // ---------- 实时 AI ----------
  readonly realtimeAIConfig: IRealtimeAIConfig;

  /**
   * 用户人设（"关于你"）：名字与一句话背景。
   *
   * 与记忆的区别：这是用户自己写的、每轮都注入的稳定背景，
   * 不依赖后台整理是否跑过——角色从第一句就知道在跟谁说话。
   */
  readonly userProfile: IUserProfile;

  // ---------- 长期记忆（按角色隔离） ----------
  readonly memories: Record<string, ReadonlyArray<IMemory>>;

  // ---------- 世界书（按角色隔离，来自社区角色卡或手动添加） ----------
  readonly loreEntries: Record<string, ReadonlyArray<ILoreEntry>>;

  // ---------- 剧情（按会话隔离） ----------
  readonly plotStates: Record<string, IPlotState>;
  /** 每会话已整理到第几条消息（后台整理游标）。 */
  readonly digestCursors: Record<string, number>;
  /** 后台整理配置。 */
  readonly digestConfig: IDigestConfig;

  /**
   * 每会话最近一次请求的上下文占用。
   *
   * 刻意**不持久化**：它是运行时观测值，刷新后重发一次就有，
   * 存进 IndexedDB 只会让每次请求都多写一次盘。
   */
  readonly contextUsageBySession: Record<string, IContextUsage>;

  /**
   * 每会话最近一次"后台整理失败"的原因。
   *
   * 同样不持久化：它是诊断信息，刷新后重试一次就知道还失不失败了。
   * 之前整理失败是全静默的，用户只看到"待整理 N 条"越积越多却不知道卡在哪。
   */
  readonly digestFailures: Record<
    string,
    { readonly at: number; readonly reason: DigestFailureReason }
  >;

  /**
   * 每会话最近一次整理的"变更摘要"（新增/取代/冲突/事件）。
   *
   * **会持久化**：用户刷新后仍想知道"上次整理动了什么"，
   * 而且它只在整理成功时写一次（每 20 条消息一次），写盘代价可忽略。
   */
  readonly digestReports: Record<string, IDigestReport>;

  /**
   * 每会话"第一条未读消息"的 ID（用来画"以下为新消息"那条分隔线）。
   *
   * 只在未读数从 0 变 1 时记一次——微信里那条线是"你离开期间的第一条"，
   * 不是每来一条都重画。用户点进会话时由 `consumeUnreadMarker` 取走并清掉。
   */
  readonly unreadMarkers: Record<string, string>;

  /**
   * 每会话"对方正在输入…"状态（会话列表用它换掉预览那行）。
   *
   * 只有活跃会话的 chatStore 知道输入状态，但用户切到列表/别的会话时，
   * 那个会话可能还在后台把回复说完——列表上要能看出来。
   * 不持久化：刷新后引擎本来就没了，这个状态也就没有意义。
   */
  readonly typingBySession: Record<string, boolean>;

  /**
   * 每会话的累计 token 用量（估算值）。
   *
   * 单次请求的占用只能回答"这一轮花了多少"，累计值才回答"这个会话一共花了多少"。
   * **会持久化**：跨刷新累计才有意义；估算规则变了顶多是数字略偏，
   * 不影响功能。
   */
  readonly tokenUsageBySession: Record<
    string,
    { readonly requests: number; readonly tokens: number }
  >;

  // ---------- 持久化 ----------
  /** 是否已从 IndexedDB 完成 hydration。 */
  hydrated: boolean;

  // ---------- Actions ----------
  /** 创建新会话（单聊）。 */
  createSession: (characterId: string) => string;
  /** 切换活跃会话（同时清除未读）。 */
  switchSession: (sessionId: string) => void;
  /** 删除会话。 */
  deleteSession: (sessionId: string) => void;
  /** 批量删除会话（会话列表多选管理）。 */
  deleteSessions: (sessionIds: ReadonlyArray<string>) => void;
  /** 保存会话运行时快照（切换前调用）。 */
  saveSessionRuntime: (sessionId: string, runtime: ISessionRuntimeSnapshot) => void;
  /** 获取会话运行时快照（切换后恢复）。 */
  getSessionRuntime: (sessionId: string) => ISessionRuntimeSnapshot | undefined;
  /**
   * 往指定会话的运行时快照里追加一条消息。
   *
   * 用途：**非活跃会话**在后台交付消息时（实时 AI 的主动消息），
   * chatStore 收不到——它只订阅当前活跃会话的引擎。消息必须有地方落，
   * 否则用户只看到未读红点和预览，点进去却是空的。
   */
  appendSessionMessage: (
    sessionId: string,
    message: IMessage,
    simulationConfig: ISimulationConfig,
  ) => void;
  /**
   * 撤回指定会话快照里的一条消息。
   *
   * 非活跃会话的引擎在后台跑完一轮后可能"反悔撤回"，
   * 而后台订阅只接 chunk-delivered——撤回事件得有地方落地，
   * 否则用户点进去还能看到那条本该消失的消息。
   */
  recallSessionMessage: (
    sessionId: string,
    messageId: string,
    notice: string,
  ) => void;
  /** 置顶/取消置顶会话。 */
  togglePinSession: (sessionId: string) => void;
  /** 标记会话为已读（清零 unreadCount）。 */
  markSessionAsRead: (sessionId: string) => void;
  /** 批量标记会话为已读（会话列表多选管理）。 */
  markSessionsAsRead: (sessionIds: ReadonlyArray<string>) => void;
  /** 增加未读计数（背景收到消息时调用）。 */
  incrementUnread: (
    sessionId: string,
    preview: string,
    messageId?: string,
  ) => void;
  /**
   * 取走并清掉"第一条未读消息"的标记（进入会话时调用）。
   *
   * 取走后这条线不会再出现——用户已经看过了，切走再切回来不该又画一次。
   */
  consumeUnreadMarker: (sessionId: string) => string | null;
  /** 设置某会话"对方正在输入…"状态（会话列表据此换掉预览那行）。 */
  setSessionTyping: (sessionId: string, typing: boolean) => void;
  /** 更新会话最后消息预览和时间。 */
  updateSessionPreview: (sessionId: string, preview: string) => void;
  /** 保存某会话的输入草稿（空字符串等于清除）。 */
  setDraft: (sessionId: string, text: string) => void;

  /** 创建角色。 */
  createCharacter: (profile: ICharacterProfile) => void;
  /** 更新角色。 */
  updateCharacter: (id: string, patch: Partial<ICharacterProfile>) => void;
  /** 删除角色（同时删除关联会话和通讯录）。 */
  deleteCharacter: (id: string) => void;

  /** 设置 API 配置。 */
  setApiConfig: (patch: Partial<IApiConfig>) => void;
  /** 切换供应商预设（自动填充 adapter/baseURL/model）。 */
  setProvider: (provider: ApiProvider) => void;
  /** 设置 API Key（内存态）。 */
  setApiKey: (key: string) => void;

  /** 创建提示词模板。 */
  createPromptTemplate: (tpl: IPromptTemplate) => void;
  /** 更新提示词模板。 */
  updatePromptTemplate: (id: string, patch: Partial<IPromptTemplate>) => void;
  /** 删除提示词模板。 */
  deletePromptTemplate: (id: string) => void;

  /** 设置实时 AI 配置。 */
  setRealtimeAIConfig: (patch: Partial<IRealtimeAIConfig>) => void;

  /** 更新用户人设（"关于你"）。 */
  setUserProfile: (patch: Partial<IUserProfile>) => void;

  // ---------- 长期记忆 Actions ----------
  /** 新增一条记忆。 */
  addMemory: (characterId: string, memory: IMemory) => void;
  /** 更新一条记忆。 */
  updateMemory: (
    characterId: string,
    memoryId: string,
    patch: Partial<IMemory>,
  ) => void;
  /** 删除一条记忆。 */
  deleteMemory: (characterId: string, memoryId: string) => void;
  /** 置顶/取消置顶记忆。 */
  togglePinMemory: (characterId: string, memoryId: string) => void;
  /** 批量替换某角色的记忆（后台整理合并结果落库）。 */
  applyMemories: (characterId: string, memories: ReadonlyArray<IMemory>) => void;

  /**
   * 让角色忘掉某几句话留下的**长期记忆**。
   *
   * 用在"删除单条消息"上：消息删了，但后台整理早就把它写进记忆库了，
   * 不一起抹掉的话，角色照样记得那句你想让它忘掉的话。
   *
   * @returns 被抹掉的记忆条数（调用方用于提示）
   */
  forgetMemoriesAbout: (
    characterId: string,
    texts: ReadonlyArray<string>,
    messageIds?: ReadonlyArray<string>,
  ) => number;

  // ---------- 世界书 Actions ----------
  /** 批量替换某角色的世界书条目（社区卡导入时整批落库）。 */
  setLoreEntries: (characterId: string, entries: ReadonlyArray<ILoreEntry>) => void;
  /** 新增一条世界书条目。 */
  addLoreEntry: (characterId: string, entry: ILoreEntry) => void;
  /** 更新一条世界书条目（含启用/禁用）。 */
  updateLoreEntry: (
    characterId: string,
    entryId: string,
    patch: Partial<ILoreEntry>,
  ) => void;
  /** 删除一条世界书条目。 */
  deleteLoreEntry: (characterId: string, entryId: string) => void;

  // ---------- 剧情 Actions ----------
  /** 覆盖某会话的剧情状态卡。 */
  setPlotState: (sessionId: string, state: IPlotState) => void;

  /**
   * 让剧情时间线忘掉某几句话留下的**事件**（状态卡不动，交给用户手动维护）。
   *
   * @returns 被抹掉的事件条数
   */
  forgetPlotEventsAbout: (
    sessionId: string,
    texts: ReadonlyArray<string>,
  ) => number;
  /** 手动编辑状态卡字段（自动压入快照）。 */
  updatePlotCard: (sessionId: string, patch: IPlotStatePatch) => void;
  /** 手动添加一条时间线事件。 */
  addPlotEvent: (sessionId: string, event: IPlotEvent) => void;
  /** 删除一条时间线事件。 */
  deletePlotEvent: (sessionId: string, eventId: string) => void;
  /** 回滚状态卡到上一个快照。 */
  rollbackPlot: (sessionId: string) => void;
  /** 清空某会话的剧情状态。 */
  clearPlotState: (sessionId: string) => void;

  // ---------- 整理 Actions ----------
  /** 推进某会话的整理游标。 */
  setDigestCursor: (sessionId: string, cursor: number) => void;
  /** 更新整理配置。 */
  setDigestConfig: (patch: Partial<IDigestConfig>) => void;

  /** 记录某会话最近一次请求的上下文占用。 */
  setContextUsage: (sessionId: string, usage: IContextUsage) => void;

  /** 记录/清除某会话的整理失败原因（传 null 表示这次成功了）。 */
  setDigestFailure: (
    sessionId: string,
    reason: DigestFailureReason | null,
  ) => void;
  /** 记录一次整理改了些什么（null = 清空）。 */
  setDigestReport: (sessionId: string, report: IDigestReport | null) => void;

  /** 累加一次请求的 token 估算值。 */
  addTokenUsage: (sessionId: string, tokens: number) => void;
}

const DEFAULT_API_CONFIG: IApiConfig = {
  adapter: "mock",
  provider: "mock",
  baseURL: "",
  model: "mock-1",
  temperature: 0.8,
  maxTokens: 1024,
  maxRetries: 3,
  timeoutMs: 30000,
};

const DEFAULT_REALTIME_AI_CONFIG: IRealtimeAIConfig = {
  enabled: false,
  intervalMs: 60000,
};

/** 用户人设默认值：没填就是不特别指定（Prompt 里也整段省略）。 */
const DEFAULT_USER_PROFILE: IUserProfile = {
  displayName: "我",
  bio: "",
};

const DEFAULT_DIGEST_CONFIG: IDigestConfig = {
  enabled: true,
  threshold: 20,
  maxWindow: 60,
  maxInject: 10,
  maxEvents: 100,
  maxHistory: 5,
};

const SESSION_STORAGE_KEY = "wechat-rp-sessions";

/**
 * 删除若干会话时，把**所有按会话归属的派生数据**一并摘掉。
 *
 * 收敛到一处的原因：这类清理原本散落在 deleteSession / deleteCharacter 里，
 * 每加一个会话级字段（上下文占用、整理失败原因…）就得记得改两处，
 * 而实际上两次都漏了。现在只有一个地方需要维护。
 *
 * @param shouldRemove 判断某个会话是否要被删除
 */
function pruneSessions(
  state: Pick<
    ISessionStoreState,
    | "sessions"
    | "sessionRuntimes"
    | "plotStates"
    | "digestCursors"
    | "drafts"
    | "contextUsageBySession"
    | "digestFailures"
    | "digestReports"
    | "unreadMarkers"
    | "typingBySession"
    | "tokenUsageBySession"
    | "activeSessionId"
  >,
  shouldRemove: (sessionId: string) => boolean,
): Pick<
  ISessionStoreState,
  | "sessions"
  | "sessionRuntimes"
  | "plotStates"
  | "digestCursors"
  | "drafts"
  | "contextUsageBySession"
  | "digestFailures"
  | "digestReports"
  | "unreadMarkers"
  | "typingBySession"
  | "tokenUsageBySession"
  | "activeSessionId"
> {
  const sessions = { ...state.sessions };
  const sessionRuntimes = { ...state.sessionRuntimes };
  const plotStates = { ...state.plotStates };
  const digestCursors = { ...state.digestCursors };
  const drafts = { ...state.drafts };
  const contextUsageBySession = { ...state.contextUsageBySession };
  const digestFailures = { ...state.digestFailures };
  const digestReports = { ...state.digestReports };
  const unreadMarkers = { ...state.unreadMarkers };
  const typingBySession = { ...state.typingBySession };
  const tokenUsageBySession = { ...state.tokenUsageBySession };
  let activeSessionId = state.activeSessionId;

  for (const sessionId of Object.keys(sessions)) {
    if (!shouldRemove(sessionId)) continue;
    delete sessions[sessionId];
    delete sessionRuntimes[sessionId];
    delete plotStates[sessionId];
    delete digestCursors[sessionId];
    delete drafts[sessionId];
    delete contextUsageBySession[sessionId];
    delete digestFailures[sessionId];
    delete digestReports[sessionId];
    delete unreadMarkers[sessionId];
    delete typingBySession[sessionId];
    delete tokenUsageBySession[sessionId];
    if (activeSessionId === sessionId) activeSessionId = null;
  }

  return {
    sessions,
    sessionRuntimes,
    plotStates,
    digestCursors,
    drafts,
    contextUsageBySession,
    digestFailures,
    digestReports,
    unreadMarkers,
    typingBySession,
    tokenUsageBySession,
    activeSessionId,
  };
}

export const useSessionStore = create<ISessionStoreState>()(
  persist(
    (set, get) => ({
      sessions: {},
      activeSessionId: null,
      sessionRuntimes: {},
      drafts: {},
      contacts: {},
      characters: {},
      promptTemplates: {},
      apiConfig: DEFAULT_API_CONFIG,
      apiKey: "",
      realtimeAIConfig: DEFAULT_REALTIME_AI_CONFIG,
      userProfile: DEFAULT_USER_PROFILE,
      memories: {},
      loreEntries: {},
      plotStates: {},
      digestCursors: {},
      digestConfig: DEFAULT_DIGEST_CONFIG,
      contextUsageBySession: {},
      digestFailures: {},
      digestReports: {},
      unreadMarkers: {},
      typingBySession: {},
      tokenUsageBySession: {},
      hydrated: false,

      createSession: (characterId) => {
        const character = get().characters[characterId];
        if (!character) {
          throw new Error(`Character ${characterId} not found`);
        }

        // 单聊复用：同一角色已存在会话时直接返回它（微信语义：
        // 一个联系人只有一个会话）。否则从通讯录反复点同一联系人会不断产生重复会话。
        const existing = Object.values(get().sessions).find(
          (session) =>
            session.type === "single" &&
            session.participantIds.includes(characterId),
        );
        if (existing) {
          get().switchSession(existing.id);
          return existing.id;
        }

        const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const session: ISession = {
          id: sessionId,
          type: "single",
          participantIds: [characterId, "user"],
          displayName: character.displayName,
          avatarUrl: character.visualMetadata.avatarUrl,
          lastMessagePreview: "",
          lastMessageTime: now,
          unreadCount: 0,
          isPinned: false,
          createdAt: now,
          updatedAt: now,
        };

        // 同时创建通讯录条目（如果不存在）
        const contact: IContact = {
          characterId,
          displayName: character.displayName,
          avatarUrl: character.visualMetadata.avatarUrl,
          bio: character.bio,
          isPinned: false,
        };

        set((state) => ({
          sessions: { ...state.sessions, [sessionId]: session },
          contacts: state.contacts[characterId]
            ? state.contacts
            : { ...state.contacts, [characterId]: contact },
          activeSessionId: sessionId,
        }));

        return sessionId;
      },

      switchSession: (sessionId) => {
        if (!get().sessions[sessionId]) return;
        set((state) => {
          const session = state.sessions[sessionId];
          if (!session) return { activeSessionId: sessionId };
          // 清零未读
          return {
            activeSessionId: sessionId,
            sessions: {
              ...state.sessions,
              [sessionId]: { ...session, unreadCount: 0 },
            },
          };
        });
      },

      deleteSession: (sessionId) => {
        set((state) => {
          return pruneSessions(state, (id) => id === sessionId);
        });
      },

      deleteSessions: (sessionIds) => {
        if (sessionIds.length === 0) return;
        // 一次 prune 处理全部目标：批量删除只写一次盘，也避免中途
        // activeSessionId 被反复重置。
        const targets = new Set(sessionIds);
        set((state) => pruneSessions(state, (id) => targets.has(id)));
      },

      setDraft: (sessionId, text) => {
        set((state) => {
          // 空草稿直接移除，避免持久化一堆空字符串
          if (!text) {
            if (!(sessionId in state.drafts)) return {};
            const drafts = { ...state.drafts };
            delete drafts[sessionId];
            return { drafts };
          }
          return { drafts: { ...state.drafts, [sessionId]: text } };
        });
      },

      togglePinSession: (sessionId) => {
        set((state) => {
          const session = state.sessions[sessionId];
          if (!session) return {};
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...session, isPinned: !session.isPinned },
            },
          };
        });
      },

      markSessionAsRead: (sessionId) => {
        set((state) => {
          const session = state.sessions[sessionId];
          if (!session || session.unreadCount === 0) return {};
          // 手动"标记已读"就是不打算回头看了：分隔线也一并清掉
          const markers = { ...state.unreadMarkers };
          delete markers[sessionId];
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...session, unreadCount: 0 },
            },
            unreadMarkers: markers,
          };
        });
      },

      markSessionsAsRead: (sessionIds) => {
        if (sessionIds.length === 0) return;
        const targets = new Set(sessionIds);
        set((state) => {
          const sessions = { ...state.sessions };
          const markers = { ...state.unreadMarkers };
          let changed = false;
          for (const sessionId of targets) {
            const session = sessions[sessionId];
            if (!session || session.unreadCount === 0) continue;
            sessions[sessionId] = { ...session, unreadCount: 0 };
            // 同上：手动标记已读也就不要那条分隔线了
            delete markers[sessionId];
            changed = true;
          }
          return changed ? { sessions, unreadMarkers: markers } : {};
        });
      },

      incrementUnread: (sessionId, preview, messageId) => {
        set((state) => {
          const session = state.sessions[sessionId];
          if (!session) return {};
          const now = Date.now();
          /**
           * 未读从 0 变 1 的那一刻记下"第一条未读消息"：
           * 这条线画的是"你离开期间的第一条"，不是每来一条都重画。
           */
          const shouldMark = session.unreadCount === 0 && messageId;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                unreadCount: session.unreadCount + 1,
                lastMessagePreview: preview,
                lastMessageTime: now,
                updatedAt: now,
              },
            },
            ...(shouldMark
              ? {
                  unreadMarkers: {
                    ...state.unreadMarkers,
                    [sessionId]: messageId,
                  },
                }
              : {}),
          };
        });
      },

      consumeUnreadMarker: (sessionId) => {
        const marker = get().unreadMarkers[sessionId] ?? null;
        if (!marker) return null;
        set((state) => {
          const markers = { ...state.unreadMarkers };
          delete markers[sessionId];
          return { unreadMarkers: markers };
        });
        return marker;
      },

      setSessionTyping: (sessionId, typing) => {
        set((state) => {
          // 已经一致就不写：这个状态会被高频切换（每个会话开始/结束各一次），
          // 无谓的 set 会白白触发一轮订阅者重渲
          if ((state.typingBySession[sessionId] ?? false) === typing) return {};
          const next = { ...state.typingBySession };
          if (typing) {
            next[sessionId] = true;
          } else {
            delete next[sessionId];
          }
          return { typingBySession: next };
        });
      },

      updateSessionPreview: (sessionId, preview) => {
        set((state) => {
          const session = state.sessions[sessionId];
          if (!session) return {};
          const now = Date.now();
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                lastMessagePreview: preview,
                lastMessageTime: now,
                updatedAt: now,
              },
            },
          };
        });
      },

      saveSessionRuntime: (sessionId, runtime) => {
        set((state) => ({
          sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime },
        }));
      },

      getSessionRuntime: (sessionId) => {
        return get().sessionRuntimes[sessionId];
      },

      appendSessionMessage: (sessionId, message, simulationConfig) => {
        set((state) => {
          const runtime = state.sessionRuntimes[sessionId];
          const messages = [
            ...(runtime?.messages ?? []),
            { message, revealed: true, pending: false },
          ];
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: {
                /**
                 * 先摊开旧快照再覆盖：这是**按字段逐个重建**最容易踩的坑——
                 * 漏写一个字段就等于把它清空。实测踩到过：后台投递回复时
                 * 把 `queuedUserTexts` 吃掉了，切回该会话时排队消息凭空消失。
                 */
                ...runtime,
                messages,
                presence: runtime?.presence ?? "online",
                presenceText: runtime?.presenceText ?? "在线",
                // 后台交付完就是这一轮结束，别让快照停在 streaming
                phase: "completed",
                typingIndicator: { active: false, estimatedRemainingMs: 0 },
                pendingCount: 0,
                simulationConfig: runtime?.simulationConfig ?? simulationConfig,
              },
            },
          };
        });
      },

      recallSessionMessage: (sessionId, messageId, notice) => {
        set((state) => {
          const runtime = state.sessionRuntimes[sessionId];
          if (!runtime) return {};
          let hit = false;
          const items = runtime.messages as ReadonlyArray<ISessionMessageItem>;
          const messages = items.map((item) => {
            if (item.message.id !== messageId) return item;
            // 已经是撤回提示就别重复处理
            if (item.message.type === "recall") return item;
            hit = true;
            return {
              ...item,
              message: toRecallMessage(item.message, notice),
            };
          });
          if (!hit) return {};
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: { ...runtime, messages },
            },
          };
        });
      },

      createCharacter: (profile) => {
        set((state) => ({
          characters: { ...state.characters, [profile.id]: profile },
          contacts: {
            ...state.contacts,
            [profile.id]: {
              characterId: profile.id,
              displayName: profile.displayName,
              avatarUrl: profile.visualMetadata.avatarUrl,
              bio: profile.bio,
              isPinned: false,
            },
          },
        }));
      },

      updateCharacter: (id, patch) => {
        set((state) => {
          const existing = state.characters[id];
          if (!existing) return {};
          const updated = { ...existing, ...patch };
          return {
            characters: { ...state.characters, [id]: updated },
            contacts: state.contacts[id]
              ? {
                  ...state.contacts,
                  [id]: {
                    ...state.contacts[id]!,
                    displayName: updated.displayName,
                    avatarUrl: updated.visualMetadata.avatarUrl,
                    bio: updated.bio,
                  },
                }
              : state.contacts,
          };
        });
      },

      deleteCharacter: (id) => {
        set((state) => {
          const characters = { ...state.characters };
          delete characters[id];
          const contacts = { ...state.contacts };
          delete contacts[id];
          // 删除关联会话（连同它们的剧情、游标、草稿、上下文占用与失败记录）
          const pruned = pruneSessions(state, (sid) =>
            state.sessions[sid]?.participantIds.includes(id) ?? false,
          );
          // 删除该角色的长期记忆
          const memories = { ...state.memories };
          delete memories[id];
          // 世界书同样按角色归属
          const loreEntries = { ...state.loreEntries };
          delete loreEntries[id];
          return {
            ...pruned,
            characters,
            contacts,
            memories,
            loreEntries,
          };
        });
      },

      setApiConfig: (patch) => {
        set((state) => ({ apiConfig: { ...state.apiConfig, ...patch } }));
      },

      setProvider: (provider) => {
        const preset = PROVIDER_PRESETS.find((p) => p.id === provider);
        if (!preset) return;
        set((state) => ({
          apiConfig: {
            ...state.apiConfig,
            provider: preset.id,
            adapter: preset.adapter,
            baseURL: preset.baseURL,
            model: preset.model,
            // 预设带推荐超时就一并应用，避免用户被默认 30s 卡掉长回复
            ...(preset.timeoutMs ? { timeoutMs: preset.timeoutMs } : {}),
          },
        }));
      },

      setApiKey: (key) => {
        set({ apiKey: key });
      },

      createPromptTemplate: (tpl) => {
        set((state) => ({
          promptTemplates: { ...state.promptTemplates, [tpl.id]: tpl },
        }));
      },

      updatePromptTemplate: (id, patch) => {
        set((state) => {
          const existing = state.promptTemplates[id];
          if (!existing) return {};
          return {
            promptTemplates: {
              ...state.promptTemplates,
              [id]: { ...existing, ...patch },
            },
          };
        });
      },

      deletePromptTemplate: (id) => {
        set((state) => {
          const promptTemplates = { ...state.promptTemplates };
          delete promptTemplates[id];
          return { promptTemplates };
        });
      },

      setRealtimeAIConfig: (patch) => {
        set((state) => ({
          realtimeAIConfig: { ...state.realtimeAIConfig, ...patch },
        }));
      },

      setUserProfile: (patch) => {
        set((state) => ({
          userProfile: { ...state.userProfile, ...patch },
        }));
      },

      // ---------- 长期记忆 ----------

      addMemory: (characterId, memory) => {
        set((state) => ({
          memories: {
            ...state.memories,
            [characterId]: [...(state.memories[characterId] ?? []), memory],
          },
        }));
      },

      updateMemory: (characterId, memoryId, patch) => {
        set((state) => {
          const list = state.memories[characterId];
          if (!list) return {};
          return {
            memories: {
              ...state.memories,
              [characterId]: list.map((memory) =>
                memory.id === memoryId
                  ? { ...memory, ...patch, updatedAt: patch.updatedAt ?? Date.now() }
                  : memory,
              ),
            },
          };
        });
      },

      deleteMemory: (characterId, memoryId) => {
        set((state) => {
          const list = state.memories[characterId];
          if (!list) return {};
          return {
            memories: {
              ...state.memories,
              [characterId]: list.filter((memory) => memory.id !== memoryId),
            },
          };
        });
      },

      togglePinMemory: (characterId, memoryId) => {
        set((state) => {
          const list = state.memories[characterId];
          if (!list) return {};
          return {
            memories: {
              ...state.memories,
              [characterId]: list.map((memory) =>
                memory.id === memoryId
                  ? { ...memory, pinned: !memory.pinned }
                  : memory,
              ),
            },
          };
        });
      },

      applyMemories: (characterId, memories) => {
        set((state) => ({
          memories: { ...state.memories, [characterId]: memories },
        }));
      },

      /**
       * 抹掉"来自某几句话"的记忆。
       *
       * 判定放在 core 的纯函数里（`forgetMemoriesFromTexts`）：测试不依赖 store，
       * 阈值调整也只改一处。
       */
      forgetMemoriesAbout: (characterId, texts, messageIds = []) => {
        const useful = texts.filter((text) => text.trim().length > 0);
        if (useful.length === 0) return 0;
        let removed = 0;
        set((state) => {
          const current = state.memories[characterId] ?? [];
          if (current.length === 0) return {};
          const { kept, forgotten } = forgetMemoriesFromTexts(
            current,
            useful,
            messageIds,
          );
          removed = forgotten.length;
          if (
            forgotten.length === 0 &&
            kept.length === current.length &&
            kept.every((memory, index) => memory === current[index])
          ) {
            return {};
          }
          return { memories: { ...state.memories, [characterId]: kept } };
        });
        return removed;
      },

      // ---------- 世界书 ----------

      setLoreEntries: (characterId, entries) => {
        set((state) => {
          // 空数组等于"这本世界书不存在"，直接删键，避免持久化一堆空数组
          if (entries.length === 0) {
            if (!(characterId in state.loreEntries)) return {};
            const loreEntries = { ...state.loreEntries };
            delete loreEntries[characterId];
            return { loreEntries };
          }
          return { loreEntries: { ...state.loreEntries, [characterId]: entries } };
        });
      },

      addLoreEntry: (characterId, entry) => {
        set((state) => ({
          loreEntries: {
            ...state.loreEntries,
            [characterId]: [...(state.loreEntries[characterId] ?? []), entry],
          },
        }));
      },

      updateLoreEntry: (characterId, entryId, patch) => {
        set((state) => {
          const list = state.loreEntries[characterId];
          if (!list) return {};
          return {
            loreEntries: {
              ...state.loreEntries,
              [characterId]: list.map((entry) =>
                entry.id === entryId ? { ...entry, ...patch } : entry,
              ),
            },
          };
        });
      },

      deleteLoreEntry: (characterId, entryId) => {
        set((state) => {
          const list = state.loreEntries[characterId];
          if (!list) return {};
          const next = list.filter((entry) => entry.id !== entryId);
          if (next.length === list.length) return {};
          if (next.length === 0) {
            const loreEntries = { ...state.loreEntries };
            delete loreEntries[characterId];
            return { loreEntries };
          }
          return { loreEntries: { ...state.loreEntries, [characterId]: next } };
        });
      },

      // ---------- 剧情 ----------

      setPlotState: (sessionId, state) => {
        set((prev) => ({
          plotStates: { ...prev.plotStates, [sessionId]: state },
        }));
      },

      forgetPlotEventsAbout: (sessionId, texts) => {
        const useful = texts.filter((text) => text.trim().length > 0);
        if (useful.length === 0) return 0;
        const current = get().plotStates[sessionId];
        if (!current || current.events.length === 0) return 0;
        const { kept, forgotten } = forgetEventsFromTexts(
          current.events,
          useful,
        );
        if (forgotten.length === 0) return 0;
        set((state) => {
          const latest = state.plotStates[sessionId];
          if (!latest) return {};
          return {
            plotStates: {
              ...state.plotStates,
              [sessionId]: { ...latest, events: kept, updatedAt: Date.now() },
            },
          };
        });
        return forgotten.length;
      },

      updatePlotCard: (sessionId, patch) => {
        set((state) => {
          const now = Date.now();
          // 无状态卡时创建（首次保存即建立状态卡）
          const existing =
            state.plotStates[sessionId] ?? createEmptyPlotState(sessionId, now);
          const hasContent = Boolean(
            existing.chapter ||
              existing.scene ||
              existing.timeLabel ||
              existing.location ||
              existing.synopsis ||
              existing.openThreads.length > 0 ||
              existing.relations.length > 0,
          );
          // 有内容时编辑前压入快照（与后台整理一致的语义）
          const snapshot = {
            chapter: existing.chapter,
            scene: existing.scene,
            timeLabel: existing.timeLabel,
            location: existing.location,
            synopsis: existing.synopsis,
            openThreads: existing.openThreads,
            relations: existing.relations,
            savedAt: now,
          };
          const updated: IPlotState = {
            ...existing,
            chapter: patch.chapter ?? existing.chapter,
            scene: patch.scene ?? existing.scene,
            timeLabel: patch.timeLabel ?? existing.timeLabel,
            location: patch.location ?? existing.location,
            synopsis: patch.synopsis ?? existing.synopsis,
            openThreads: patch.openThreads ?? existing.openThreads,
            relations: patch.relations ?? existing.relations,
            history: hasContent
              ? [...existing.history, snapshot].slice(-5)
              : existing.history,
            updatedAt: now,
          };
          return { plotStates: { ...state.plotStates, [sessionId]: updated } };
        });
      },

      addPlotEvent: (sessionId, event) => {
        set((state) => {
          const now = Date.now();
          // 没有状态卡时也要落事件：用户在时间线里手动记的第一条，
          // 常常发生在第一次后台整理之前（此前这里直接 return {}，事件被悄悄丢掉）。
          const existing =
            state.plotStates[sessionId] ??
            createEmptyPlotState(sessionId, now);
          // 与后台整理用同一个上限（设置面板可调），并兜住导入数据里的脏值
          const maxEvents = Math.max(1, Math.round(state.digestConfig.maxEvents) || 100);
          return {
            plotStates: {
              ...state.plotStates,
              [sessionId]: {
                ...existing,
                events: [...existing.events, event].slice(-maxEvents),
                updatedAt: now,
              },
            },
          };
        });
      },

      deletePlotEvent: (sessionId, eventId) => {
        set((state) => {
          const existing = state.plotStates[sessionId];
          if (!existing) return {};
          return {
            plotStates: {
              ...state.plotStates,
              [sessionId]: {
                ...existing,
                events: existing.events.filter((event) => event.id !== eventId),
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      rollbackPlot: (sessionId) => {
        set((state) => {
          const existing = state.plotStates[sessionId];
          if (!existing) return {};
          const rolled = rollbackPlotState(existing);
          if (!rolled) return {};
          return { plotStates: { ...state.plotStates, [sessionId]: rolled } };
        });
      },

      clearPlotState: (sessionId) => {
        set((state) => {
          const plotStates = { ...state.plotStates };
          delete plotStates[sessionId];
          return { plotStates };
        });
      },

      // ---------- 整理 ----------

      setDigestCursor: (sessionId, cursor) => {
        set((state) => ({
          digestCursors: { ...state.digestCursors, [sessionId]: cursor },
        }));
      },

      setDigestConfig: (patch) => {
        set((state) => ({
          digestConfig: { ...state.digestConfig, ...patch },
        }));
      },

      setContextUsage: (sessionId, usage) => {
        set((state) => ({
          contextUsageBySession: {
            ...state.contextUsageBySession,
            [sessionId]: usage,
          },
        }));
      },

      setDigestFailure: (sessionId, reason) => {
        set((state) => {
          const failures = { ...state.digestFailures };
          if (reason === null) {
            delete failures[sessionId];
          } else {
            failures[sessionId] = { at: Date.now(), reason };
          }
          return { digestFailures: failures };
        });
      },

      setDigestReport: (sessionId, report) => {
        set((state) => {
          const reports = { ...state.digestReports };
          if (report === null) {
            delete reports[sessionId];
          } else {
            reports[sessionId] = report;
          }
          return { digestReports: reports };
        });
      },

      addTokenUsage: (sessionId, tokens) => {
        if (!Number.isFinite(tokens) || tokens <= 0) return;
        set((state) => {
          const previous = state.tokenUsageBySession[sessionId] ?? {
            requests: 0,
            tokens: 0,
          };
          return {
            tokenUsageBySession: {
              ...state.tokenUsageBySession,
              [sessionId]: {
                requests: previous.requests + 1,
                tokens: previous.tokens + Math.round(tokens),
              },
            },
          };
        });
      },
    }),
    {
      name: SESSION_STORAGE_KEY,
      storage: createJSONStorage(() => idbStorage),
      version: SCHEMA_VERSION,
      // 不持久化 apiKey（敏感信息）和 hydrated（瞬态）
      partialize: (state) => ({
        sessions: state.sessions,
        contacts: state.contacts,
        characters: state.characters,
        promptTemplates: state.promptTemplates,
        apiConfig: state.apiConfig,
        sessionRuntimes: state.sessionRuntimes,
        drafts: state.drafts,
        activeSessionId: state.activeSessionId,
        realtimeAIConfig: state.realtimeAIConfig,
        userProfile: state.userProfile,
        memories: state.memories,
        loreEntries: state.loreEntries,
        plotStates: state.plotStates,
        digestCursors: state.digestCursors,
        digestConfig: state.digestConfig,
        digestReports: state.digestReports,
        unreadMarkers: state.unreadMarkers,
        tokenUsageBySession: state.tokenUsageBySession,
      }),
      migrate: (persisted, version) => {
        return migrateSnapshot(persisted, version);
      },
      /**
       * 进门先过安检。
       *
       * 注意不能放在 migrate 里：zustand 只在**版本号变化时**才调用 migrate，
       * 而坏数据往往出现在版本没变的情况下（写入中断、手工改过），
       * 那样清洗永远不会执行。merge 在每次 hydration 都跑，才是正确的位置。
       */
      merge: (persisted, current) => {
        const { value, report } = sanitizeSessionSnapshot<
          Partial<ISessionStoreState>
        >(persisted);
        if (report.dropped.length > 0) {
          console.warn(
            `[sessionStore] 已丢弃 ${report.dropped.length} 条损坏的持久化数据：`,
            report.dropped.slice(0, 10),
          );
        }
        return { ...current, ...(value ?? {}) } as ISessionStoreState;
      },
    },
  ),
);
