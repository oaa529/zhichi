/**
 * @file App.tsx
 * 状态组装层。
 *
 * 使用 WeChatShell 三栏布局：
 * 左侧：会话列表/通讯录/设置
 * 中间：ChatSessionView + InputBar
 *
 * 通过 EngineManager 管理多会话引擎。
 * 首次启动时注入种子角色数据（DEMO_PROFILE）。
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type {
  ICharacterProfile,
  ICharacterSprite,
  CharacterEmotion,
  ISimulationConfig,
  ISession,
  IChunkDeliveredEvent,
  IMessageQuote,
  SessionPhase,
} from "@wechat-rp/shared-types";
import { EngineManager } from "@wechat-rp/core";
import {
  ChatSessionView,
  ErrorBoundary,
  InputBar,
  WeChatShell,
  PromptPanel,
  findLastReplyTurn,
  pickNextProactiveSession,
  useChatStore,
  useSessionStore,
} from "@wechat-rp/ui-wechat";
import {
  buildPlaceholderAvatar,
  buildPlaceholderSprite,
} from "@wechat-rp/ui-wechat";
import type { IBackupActionResult, IMessageRuntime } from "@wechat-rp/ui-wechat";
import {
  buildPlotAdvancePrompt,
  buildProactivePrompt,
  buildProactiveQuery,
  buildQuoteCandidates,
  collectRecentSaid,
  deriveMood,
  formatQuotedText,
  getMessagePlainText,
  renderPlotSummary,
  retrieveMemories,
  selectLoreEntries,
  toLLMHistory,
} from "@wechat-rp/core";
import type { RealismEngine } from "@wechat-rp/core";
import { getLLMAdapter, getLLMConfig, recreateAdapter, testLLMConnection } from "./llmRuntime";
import {
  cancelAllDigests,
  maybeRunDigest,
  resetDigestRunnerState,
  runDigestNow,
} from "./digestRunner";
import {
  buildBackupText,
  exportBackupToFile,
  importBackupFromFile,
} from "./backupRunner";
import {
  exportCharacterCardToFile,
  importCharacterCardFile,
} from "./characterCardRunner";
import { generateCharacterDraft } from "./characterGenRunner";
import { exportSessionTranscript } from "./transcriptRunner";
import { downloadTextFile } from "./download";

/** 最近 N 条消息的文本（用于记忆检索的查询扩展）。 */
function recentMessageTexts(
  messages: ReadonlyArray<IMessageRuntime>,
  count = 2,
): ReadonlyArray<string> {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i -= 1) {
    const message = messages[i]?.message;
    if (!message) continue;
    if (message.type === "text" && message.text.trim()) {
      texts.push(message.text.trim());
    } else if (message.type === "sticker" && message.fallbackText.trim()) {
      texts.push(message.fallbackText.trim());
    }
  }
  return texts;
}

/**
 * 把当前会话的上下文注入引擎（历史 / 人设模板 / 检索后的记忆 / 剧情摘要）。
 *
 * 必须在每次 startStreamWithAdapter 之前调用：
 * 否则 Prompt 只有当前一句，角色"失忆"。
 */
function syncEngineContext(
  engine: RealismEngine,
  sessionId: string,
  userMessage: string,
): void {
  const state = useSessionStore.getState();
  const session = state.sessions[sessionId];
  if (!session) return;

  const characterId = session.participantIds.find((id) => id !== "user");
  if (!characterId) return;
  const character = state.characters[characterId];

  // 1. 消息历史（活跃会话读 chatStore，后台会话读运行时快照）
  const messages: ReadonlyArray<IMessageRuntime> =
    state.activeSessionId === sessionId
      ? useChatStore.getState().messages
      : ((state.sessionRuntimes[sessionId]?.messages ?? []) as ReadonlyArray<IMessageRuntime>);
  engine.setMessageHistory(toLLMHistory(messages.map((item) => item.message)));

  // 1.2 "上一句隔了多久"：给模型一个时间参照，
  //     否则隔三天再聊，角色还是会像上一句刚说完那样接话。
  //     注意调用点都在**本条消息上屏之前**，所以这里取到的就是"上一条"。
  const lastMessageAt = messages.reduce(
    (latest, item) => Math.max(latest, item.message?.timestamp ?? 0),
    0,
  );
  engine.setLastMessageAt(lastMessageAt > 0 ? lastMessageAt : null);

  // 1.5 角色可以引用"你最近说过的话"：候选必须带消息 ID，
  //     引用块才能点击跳回那条消息（只带文本就只能干看着）
  engine.setQuoteCandidates(
    buildQuoteCandidates(messages.map((item) => item.message), {
      // 角色引用自己之前那句话时，引用块上要写它的名字
      characterName: character?.displayName,
    }),
  );

  // 2. 人设模板（按角色的 promptTemplateId 绑定）
  const template =
    character && character.promptTemplateId
      ? state.promptTemplates[character.promptTemplateId] ?? null
      : null;
  engine.setPromptTemplate(template);

  // 3. 长期记忆（按当前输入 + 最近消息检索）
  const memories = state.memories[characterId] ?? [];
  const query = [userMessage, ...recentMessageTexts(messages)].join("\n");
  engine.setMemories(
    retrieveMemories(query, memories, {
      maxItems: state.digestConfig.maxInject,
    }),
  );

  // 4. 世界书（社区卡设定）：与记忆同源检索，但分开注入
  engine.setLoreEntries(
    selectLoreEntries(query, state.loreEntries[characterId] ?? []).entries,
  );

  // 5. 剧情摘要
  engine.setPlotSummary(renderPlotSummary(state.plotStates[sessionId] ?? null));

  // 6. 心情：由最近的对话推导（不落库），让语气跨轮次连贯
  engine.setMood(deriveMood(messages.map((item) => item.message), Date.now()));

  // 7. 用户人设（"关于你"）：稳定背景，每轮都带，不等整理提炼
  engine.setUserProfile(state.userProfile);
}

/**
 * 归一化恢复出来的会话阶段。
 *
 * 引擎随页面一起销毁，恢复出的 streaming / paused 都是"上次未完成的现场"，
 * 必须转成 interrupted，否则输入框会永久禁用（需要手动中止才能继续）。
 */
function normalizeRestoredPhase(phase: string): SessionPhase {
  if (phase === "streaming" || phase === "paused") return "interrupted";
  return phase as SessionPhase;
}

// ---------- 种子角色数据 ----------

/**
 * 演示角色的头像与立绘用**内置生成的 SVG**，不再指向第三方图床。
 *
 * 之前这里拼的是图床链接，实测那个域名已经不可达：新装用户打开就是一堆破图，
 * 角色卡导出后也不自包含。占位素材本来就是可以当场画出来的东西，
 * 没有必要依赖外部服务。
 */
const DEMO_EMOTIONS: ReadonlyArray<CharacterEmotion> = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "shy",
  "surprised",
  "thinking",
  "sleepy",
];

function buildDemoSprites(
  name: string,
  hue: number,
): ReadonlyArray<ICharacterSprite> {
  return DEMO_EMOTIONS.map((emotion) => ({
    emotion,
    url: buildPlaceholderSprite(name, emotion, hue),
  }));
}

const SEED_PROFILES: ReadonlyArray<ICharacterProfile> = [
  {
    id: "char-su-wanqing",
    displayName: "苏晚晴",
    bio: "温润如水的邻家姐姐",
    visualMetadata: {
      avatarUrl: buildPlaceholderAvatar("苏晚晴", 210),
      sprites: buildDemoSprites("苏晚晴", 210),
      supportsPinSprite: true,
      defaultSpriteAnchor: "left",
    },
    schedule: {
      wakeTime: "07:30",
      sleepTime: "23:30",
      scheduleEnabled: true,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "drowsy-burst",
    },
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 0.85,
      fragmentationBias: 0.6,
      hesitationProbability: 0.18,
      typoRate: 0.04,
      stickerFrequency: 0.2,
    },
    promptTemplateId: "tpl-su-wanqing-v1",
  },
  {
    id: "char-lin-xiaoxiao",
    displayName: "林笑笑",
    bio: "活泼爱闹的同桌",
    visualMetadata: {
      avatarUrl: buildPlaceholderAvatar("林笑笑", 28),
      sprites: buildDemoSprites("林笑笑", 28),
      supportsPinSprite: true,
      defaultSpriteAnchor: "left",
    },
    schedule: {
      wakeTime: "06:00",
      sleepTime: "00:30",
      scheduleEnabled: true,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "drowsy-burst",
    },
    personalityTraits: {
      archetype: "energetic",
      typingSpeedMultiplier: 1.5,
      fragmentationBias: 0.7,
      hesitationProbability: 0.05,
      typoRate: 0.08,
      stickerFrequency: 0.3,
    },
    promptTemplateId: "tpl-lin-xiaoxiao-v1",
  },
];

const DEFAULT_CONFIG: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "normal",
  hesitationProbability: 0.15,
  typoRate: 0.05,
  // 角色撤回：约 5% 的轮次里会"说漏嘴→反悔"，太高就变成闹剧了
  recallProbability: 0.05,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: true,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  // 气泡间隔上限：拟真但不过度——超过 ~3.5 秒的停顿会明显像"卡住"
  maxInterChunkDelayMs: 3500,
};

export function App() {
  const attachEngine = useChatStore((s) => s.attachEngine);
  const dispose = useChatStore((s) => s.dispose);
  const abortStream = useChatStore((s) => s.abortStream);
  const phase = useChatStore((s) => s.phase);
  const chatHydrated = useChatStore((s) => s.hydrated);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const addStickerMessage = useChatStore((s) => s.addStickerMessage);

  // Session store
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const characters = useSessionStore((s) => s.characters);
  const sessionHydrated = useSessionStore((s) => s.hydrated);
  const saveSessionRuntime = useSessionStore((s) => s.saveSessionRuntime);
  const getSessionRuntime = useSessionStore((s) => s.getSessionRuntime);
  const realtimeAIConfig = useSessionStore((s) => s.realtimeAIConfig);
  const incrementUnread = useSessionStore((s) => s.incrementUnread);
  const updateSessionPreview = useSessionStore((s) => s.updateSessionPreview);

  // 两个 store 都 hydrate 完成后才渲染
  const hydrated = chatHydrated && sessionHydrated;

  const [inputValue, setInputValue] = useState("");
  const [promptPanelOpen, setPromptPanelOpen] = useState(false);
  /**
   * 正在引用的消息（微信式"引用回复"）。
   *
   * 只驻留内存、不跨会话保留：切换会话时清空。引用会在发送时
   * 拼进给模型的 Prompt，同时作为消息元数据渲染成气泡上方的引用块。
   */
  const [quoting, setQuoting] = useState<IMessageQuote | null>(null);
  /** 输入框内容的最新值（供会话切换时保存草稿，避免把 inputValue 加进 effect 依赖）。 */
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // EngineManager 单例
  const engineManagerRef = useRef<EngineManager | null>(null);
  if (!engineManagerRef.current) {
    engineManagerRef.current = new EngineManager({
      userId: "user",
      defaultConfig: DEFAULT_CONFIG,
    });
  }
  const engineManager = engineManagerRef.current;

  // 注入 store 引用到 window（llmRuntime 读取用）
  useEffect(() => {
    const w = window as unknown as {
      __sessionStore: typeof useSessionStore;
      __chatStore: typeof useChatStore;
      __exportBackup?: () => string;
    };
    w.__sessionStore = useSessionStore;
    // 调试入口：便于在控制台/自动化中注入消息验证滚动与渲染
    w.__chatStore = useChatStore;
    // 调试入口：控制台里 `copy(__exportBackup())` 可手工取一份备份 JSON
    if (import.meta.env.DEV) {
      w.__exportBackup = buildBackupText;
    }
  }, []);

  // 首次启动注入种子角色。
  //
  // 必须等 sessionStore 完成 hydration 再判断：否则这里读到的是"初始空状态"，
  // 写入种子会触发 persist 把初始状态（sessions: {}）写回 IndexedDB，
  // 覆盖掉磁盘上已有的会话——实测表现为刷新后会话列表清空、
  // 聊天记录变成找不到会话的孤儿数据。hydration 是异步的（IndexedDB），
  // 而 useEffect 在首帧后就执行，两者之间存在竞态。
  const seededRef = useRef(false);
  useEffect(() => {
    if (!sessionHydrated) return;
    if (seededRef.current) return;
    seededRef.current = true;
    // 如果 store 中没有角色数据，注入种子
    if (Object.keys(useSessionStore.getState().characters).length === 0) {
      for (const profile of SEED_PROFILES) {
        useSessionStore.getState().createCharacter(profile);
      }
    }
  }, [sessionHydrated]);

  // 监听 persist hydration（chatStore + sessionStore 都要等）
  useEffect(() => {
    const checkHydrated = () => {
      if (useChatStore.persist.hasHydrated()) {
        useChatStore.setState({ hydrated: true });
      }
      if (useSessionStore.persist?.hasHydrated()) {
        useSessionStore.setState({ hydrated: true });
      }
    };
    checkHydrated();
    const unsubChat = useChatStore.persist.onFinishHydration(() => {
      useChatStore.setState({ hydrated: true });
    });
    const unsubSession = useSessionStore.persist?.onFinishHydration(() => {
      useSessionStore.setState({ hydrated: true });
    });
    return () => {
      unsubChat();
      unsubSession?.();
    };
  }, []);

  // 当 activeSessionId 变化时，保存旧会话状态，恢复新会话状态，切换引擎
  // 注意：依赖 activeSessionId 而非 sessions，避免 session 对象引用变化导致误覆盖
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const prevId = prevSessionIdRef.current;
    const newId = activeSessionId;

    // 同一会话：不执行切换逻辑（防止 sessions 引用变化导致误覆盖）
    if (prevId === newId) return;

    // 引用属于会话内的临时状态，切走就作废
    setQuoting(null);

    // 保存旧会话运行时（仅当该会话仍存在——删除会话后不应再写回孤儿快照）
    if (prevId && useSessionStore.getState().sessions[prevId]) {
      // 同时把输入框内容存为该会话的草稿：草稿属于会话，不跟着人走
      useSessionStore.getState().setDraft(prevId, inputValueRef.current);
      const currentState = useChatStore.getState();
      saveSessionRuntime(prevId, {
        messages: currentState.messages,
        presence: currentState.presence,
        presenceText: currentState.presenceText,
        phase: currentState.phase,
        typingIndicator: currentState.typingIndicator,
        pendingCount: currentState.pendingCount,
        simulationConfig: currentState.simulationConfig,
        // 排队消息已经上屏了，切走时必须跟着会话走，否则它们永远等不到回复
        queuedUserTexts: currentState.queuedUserTexts,
      });
    }

    /**
     * 只解绑界面订阅，**不销毁旧引擎**。
     *
     * 拟真模式下一条长回复可能铺十几秒；切走时如果 abort 掉，
     * 用户切回来只剩半截回复。现在让它在后台继续说完：
     * 输出会被 App 的"背景订阅器"接住，写进那个会话自己的运行时快照
     * （见下方 background 订阅 effect）。
     */
    if (prevId) {
      dispose();
    }

    // 恢复新会话
    if (newId) {
      // 恢复该会话的草稿（没有则清空输入框）
      setInputValue(useSessionStore.getState().drafts[newId] ?? "");
      const session = sessions[newId];
      if (session) {
        const characterId = session.participantIds.find((id) => id !== "user");
        const character = characterId ? characters[characterId] : null;
        if (character) {
          // 恢复会话运行时快照（如果有）
          const savedRuntime = getSessionRuntime(newId);
          const persistedMessages = useChatStore.getState().messages;
          // 刷新场景：chatStore 持久化的消息可能就属于该会话（上次的活跃会话）
          const persistedBelongsToSession =
            persistedMessages.length > 0 &&
            persistedMessages[0]?.message.sessionId === newId;

          if (savedRuntime && savedRuntime.messages.length > 0) {
            useChatStore.setState({
              messages: savedRuntime.messages as never,
              presence: savedRuntime.presence as never,
              presenceText: savedRuntime.presenceText,
              phase: normalizeRestoredPhase(savedRuntime.phase),
              // 引擎已随页面销毁，恢复时必须清掉"正在输入"指示与占位计数
              typingIndicator: { active: false, estimatedRemainingMs: 0 },
              pendingCount: 0,
              simulationConfig: savedRuntime.simulationConfig,
              // 上次切走时还在排队的消息：接着回，别让它们石沉大海
              queuedUserTexts: savedRuntime.queuedUserTexts ?? [],
            });
          } else if (persistedBelongsToSession) {
            // 持久化的消息就是本会话现场：保留消息，只归一化阶段与瞬态字段，
            // 并回写运行时快照供后续切换会话使用。
            const current = useChatStore.getState();
            const restoredPhase = normalizeRestoredPhase(current.phase);
            const typingIndicator = { active: false, estimatedRemainingMs: 0 };
            useChatStore.setState({
              phase: restoredPhase,
              typingIndicator,
              pendingCount: 0,
            });
            saveSessionRuntime(newId, {
              messages: current.messages,
              presence: current.presence,
              presenceText: current.presenceText,
              phase: restoredPhase,
              typingIndicator,
              pendingCount: 0,
              simulationConfig: current.simulationConfig,
              queuedUserTexts: current.queuedUserTexts,
            });
          } else {
            // 真正的空会话（或持久化数据属于其他会话），清空状态
            useChatStore.setState({
              messages: [],
              queuedUserTexts: [],
              pendingCount: 0,
              phase: "idle",
              lastError: null,
              typingIndicator: { active: false, estimatedRemainingMs: 0 },
            });
            /**
             * 社区卡开场白：新会话由角色先说第一句话。
             * 卡片作者写的第一句话是角色给人的第一印象，丢掉它等于丢了一半设定。
             */
            const greeting = character.greeting?.trim();
            if (greeting) {
              useChatStore.getState().appendCharacterMessage({
                text: greeting,
                sessionId: newId,
                characterId: character.id,
              });
              useSessionStore.getState().updateSessionPreview(newId, greeting);
            }
          }

          // 创建/获取引擎
          const engine = engineManager.getOrCreate(newId, character);
          engine.setLLMConfig(getLLMConfig());
          attachEngine(engine);
          /**
           * "以下为新消息"分隔线：取走这个会话的第一条未读标记。
           *
           * 取走即清（sessionStore 里不再留），所以只画这一次——
           * 用户看过之后再切回来不该又画一遍。没有未读时是 null，不画。
           */
          useChatStore
            .getState()
            .setUnreadMarker(
              useSessionStore.getState().consumeUnreadMarker(newId),
            );
          // 切换会话时同步上下文（历史 / 模板 / 记忆 / 剧情）
          syncEngineContext(engine, newId, "");
        }
      }
    }

    // 没有活跃会话（例如刚删除了当前会话）：清空运行时，
    // 避免已删除会话的消息残留在内存与 IndexedDB 中。
    if (!newId) {
      useChatStore.setState({
        messages: [],
        queuedUserTexts: [],
        pendingCount: 0,
        phase: "idle",
        lastError: null,
        typingIndicator: { active: false, estimatedRemainingMs: 0 },
      });
    }

    prevSessionIdRef.current = newId;
    // 只依赖 activeSessionId 和 hydrated，不依赖 sessions/characters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, hydrated, attachEngine, dispose, engineManager, saveSessionRuntime, getSessionRuntime]);

  // 组件卸载时清理所有引擎
  useEffect(() => {
    return () => {
      engineManager.disposeAll();
      cancelAllDigests();
    };
  }, [engineManager]);

  /**
   * 活跃会话的"正在输入"也要写进会话列表用的那份状态。
   *
   * 后台会话由订阅器直接写（见下面的背景订阅器），
   * 活跃会话的输入状态在 chatStore 里，这里镜像过去，
   * 让列表只有一处数据来源、不用同时读两个 store。
   */
  const activeTyping = useChatStore(
    (s) => s.phase === "streaming" && s.typingIndicator.active,
  );
  useEffect(() => {
    if (!activeSessionId) return;
    useSessionStore.getState().setSessionTyping(activeSessionId, activeTyping);
  }, [activeSessionId, activeTyping]);

  /**
   * 在场状态的定时刷新（在线 / 在上课 / 已就寝）。
   *
   * 引擎只在"开始一轮回复"时推送 presence 事件，所以刚打开会话时头部
   * 一直显示"在线"——哪怕角色此刻正在上课。这里按固定节奏问一次引擎，
   * 把状态补上；回复进行中不插手（那时以引擎事件为准）。
   *
   * 依赖 characters：角色卡里改了作息/忙碌时段，头部要马上跟着变。
   */
  useEffect(() => {
    if (!hydrated || !activeSessionId) return;

    const sync = () => {
      const chat = useChatStore.getState();
      if (chat.phase === "streaming" || chat.phase === "paused") return;
      const state = useSessionStore.getState();
      const session = state.sessions[activeSessionId];
      const characterId = session?.participantIds.find((id) => id !== "user");
      const character = characterId ? state.characters[characterId] : null;
      if (!character) return;
      const engine = engineManager.getOrCreate(activeSessionId, character);
      const decision = engine.describePresence();
      useChatStore.setState({
        presence: decision.presence,
        presenceText: decision.displayText,
      });
    };

    sync();
    const timer = setInterval(sync, 30_000);
    return () => clearInterval(timer);
  }, [hydrated, activeSessionId, engineManager, characters]);

  /**
   * 会话被删掉后，收掉它的引擎。
   *
   * 引擎常驻（切会话不再销毁）之后，必须有人负责收口——否则删了会话，
   * 它的引擎会一直留在池子里。
   */
  const sessionIdsKey = Object.keys(sessions).sort().join("|");
  useEffect(() => {
    if (!hydrated) return;
    engineManager.retainOnly(sessionIdsKey ? sessionIdsKey.split("|") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey, hydrated, engineManager]);

  // 活跃会话收到新消息时，更新会话列表预览（不增加未读，因为用户正在查看）
  const messagesLength = useChatStore((s) => s.messages.length);
  /**
   * 这里直接订阅 messages 数组本身，而不是"长度 + 最后一条"。
   *
   * 撤回是**原地替换**：数组长度不变，被替换的那条又未必是最后一条
   * （用户撤回中间某句时，末尾还是角色的回复）。用长度当触发条件，
   * 快照就不会更新，刷新后撤回的那条原文又回来了——实测踩到过。
   */
  const runtimeMessages = useChatStore((s) => s.messages);
  /** 排队中的用户消息（跟着快照一起存，切会话/刷新都不能丢）。 */
  const queuedUserTexts = useChatStore((s) => s.queuedUserTexts);
  useEffect(() => {
    if (!activeSessionId || !hydrated) return;
    /**
     * 预览要用**当前 store 里**的最后一条，不能用渲染时闭包里的那份。
     *
     * 切会话时这个 effect 会在同一次提交里跟着跑：此时 activeSessionId 已经是
     * 新会话，而闭包里的 lastMessage 还是**上一个会话**的——于是新会话的列表
     * 预览会短暂显示别人家的最后一句话（浏览器实测撞到过）。
     * 直接读 store 拿到的才是切完之后的消息。
     */
    const current = useChatStore.getState();
    const last = current.messages[current.messages.length - 1];
    if (last && last.message.type === "text") {
      updateSessionPreview(activeSessionId, last.message.text ?? "");
    } else if (last && last.message.type === "recall") {
      /**
       * 撤回也要反映到会话列表。
       *
       * 微信里最后一条被撤回后，列表上显示的就是"XX撤回了一条消息"；
       * 否则预览会停留在**已经被撤回的那句话**上，等于把内容漏出来了。
       */
      updateSessionPreview(activeSessionId, last.message.notice);
    }
    // 持续保存当前会话运行时快照：
    // 不能只在"切换会话"时保存，否则刷新页面会丢失当前会话的消息。
    saveSessionRuntime(activeSessionId, {
      messages: current.messages,
      presence: current.presence,
      presenceText: current.presenceText,
      phase: current.phase,
      typingIndicator: current.typingIndicator,
      pendingCount: current.pendingCount,
      simulationConfig: current.simulationConfig,
      queuedUserTexts: current.queuedUserTexts,
    });
  }, [
    runtimeMessages,
    queuedUserTexts,
    activeSessionId,
    hydrated,
    updateSessionPreview,
    saveSessionRuntime,
  ]);

  // 背景订阅器：为非活跃会话的引擎建立轻量订阅，收到消息时增加未读
  useEffect(() => {
    if (!hydrated) return;
    const unsubscribers: Array<() => void> = [];

    for (const [sid, session] of Object.entries(sessions)) {
      if (sid === activeSessionId) continue; // 活跃会话由 chatStore 处理
      const characterId = session.participantIds.find((id) => id !== "user");
      if (!characterId) continue;
      const character = characters[characterId];
      if (!character) continue;

      const engine = engineManager.getOrCreate(sid, character);
      engine.setLLMConfig(getLLMConfig());

      const sub = engine.subscribe((output) => {
        /**
         * "对方正在输入…"也要反映到会话列表。
         *
         * 后台会话的那一轮还在跑，用户切到列表时应该看得出"它还在回"，
         * 而不是只看到上一条消息预览。
         */
        if (output.event.kind === "typing-indicator") {
          useSessionStore
            .getState()
            .setSessionTyping(sid, output.event.active);
          return;
        }
        // 一轮结束（正常结束/中止）时兜底清掉：中途出错时不会再收到 typing=false
        if (output.event.kind === "lifecycle" && output.event.phase !== "started") {
          useSessionStore.getState().setSessionTyping(sid, false);
          return;
        }
        /**
         * 撤回事件也要在这条路径上处理。
         *
         * 前面交付的是"消息"，撤回是"把刚才那条消息抹掉"——
         * 只接 chunk-delivered 的话，后台会话里撤回过的消息会留在快照里，
         * 点进去还能看到它，与"已撤回"的状态自相矛盾。
         */
        if (output.event.kind === "recall") {
          const e = output.event;
          useSessionStore
            .getState()
            .recallSessionMessage(sid, e.targetMessageId, e.notice);
          // 会话列表的预览也跟着换成提示（微信就是这个表现）
          useSessionStore.getState().updateSessionPreview(sid, e.notice);
          return;
        }
        if (output.event.kind !== "chunk-delivered") return;
        const e = output.event as IChunkDeliveredEvent;
        const msg = e.message;
        const preview = msg.type === "text" ? (msg.text ?? "") : `[${msg.type}]`;

        /**
         * 消息要落进**这个会话自己的**运行时快照。
         *
         * chatStore 只订阅当前活跃会话的引擎，非活跃会话在后台交付的消息
         * 没有别的地方接着——此前只加了未读红点与会话预览，
         * 用户看到"对方发来一条消息"，点进去却是空的。
         */
        useSessionStore.getState().appendSessionMessage(sid, msg, DEFAULT_CONFIG);

        // 带上消息 ID：未读从 0 变 1 时，会话里要画"以下为新消息"
        incrementUnread(sid, preview, msg.id);
      });
      unsubscribers.push(() => sub.unsubscribe());
    }

    return () => {
      for (const fn of unsubscribers) fn();
    };
  }, [sessions, activeSessionId, characters, hydrated, engineManager, incrementUnread]);

  /**
   * 实时 AI 定时器：跨会话轮转触发主动消息。
   *
   * 每次心跳挑一个"最久没有消息"的会话（最早 lastMessageTime）主动发消息：
   * - 活跃会话 → 直接显示在聊天区
   * - 非活跃会话 → 由背景订阅器累计未读，红点/未读数才会出现
   * 睡眠中的角色（scheduling 窗口内）不打扰；正在流式输出的会话跳过。
   */
  useEffect(() => {
    if (!realtimeAIConfig.enabled || !hydrated) return;

    const interval = setInterval(() => {
      const state = useSessionStore.getState();
      const activeId = state.activeSessionId;
      const candidates: ISession[] = [];

      for (const session of Object.values(state.sessions)) {
        const characterId = session.participantIds.find((id) => id !== "user");
        const character = characterId
          ? state.characters[characterId]
          : undefined;
        if (!character) continue;

        // 活跃会话正在回复时跳过（非活跃会话忙则交给引擎抛错兜底）
        if (session.id === activeId) {
          const phase = useChatStore.getState().phase;
          if (phase === "streaming" || phase === "paused") continue;
        }

        const engine = engineManager.getOrCreate(session.id, character);
        engine.setLLMConfig(getLLMConfig());
        // 睡着不打扰；正在上课/上班也不该由它主动开新话题
        if (engine.isSleeping() || engine.isBusy()) continue;

        candidates.push(session);
      }

      const target = pickNextProactiveSession(candidates);
      if (!target) return;

      const characterId = target.participantIds.find((id) => id !== "user");
      const character = characterId
        ? useSessionStore.getState().characters[characterId]
        : undefined;
      if (!character) return;

      const engine = engineManager.getOrCreate(target.id, character);
      // 主动消息的上下文：最近聊了什么、还有什么没聊完、现在几点
      const sessionState = useSessionStore.getState();
      const runtimeMessages = (sessionState.sessionRuntimes[target.id]
        ?.messages ?? []) as ReadonlyArray<IMessageRuntime>;
      const plot = sessionState.plotStates[target.id] ?? null;
      const promptInput = {
        characterName: character.displayName,
        now: Date.now(),
        lastMessageAt: target.lastMessageTime,
        // 时段按**角色所在时区**算：跨时区角色的"深夜"不该由你的钟点决定
        timeZone: character.schedule.timezone,
        // recentMessageTexts 返回的是"由新到旧"，提示词里按时间正序更好读
        recentTexts: [...recentMessageTexts(runtimeMessages, 4)].reverse(),
        // "别重复"要给具体清单：只说一句"不要重复"模型不知道最近说过什么
        recentSaid: collectRecentSaid(
          toLLMHistory(runtimeMessages.map((item) => item.message)),
        ),
        openThreads: plot?.openThreads ?? [],
        synopsis: plot?.synopsis || undefined,
      };
      const proactivePrompt = buildProactivePrompt(promptInput);
      // 记忆检索要用"最近聊了什么"，而不是拿提示词本身去检索（那样没有关键词）
      const proactiveQuery =
        buildProactiveQuery(promptInput) || character.displayName;

      try {
        // 主动消息同样需要带上历史 / 模板 / 记忆 / 剧情
        syncEngineContext(engine, target.id, proactiveQuery);
        engine.startStreamWithAdapter(proactivePrompt, getLLMAdapter());
      } catch {
        // 引擎忙，跳过本次
      }
    }, realtimeAIConfig.intervalMs);

    return () => clearInterval(interval);
  }, [realtimeAIConfig.enabled, realtimeAIConfig.intervalMs, hydrated, engineManager]);

  // ---------- 记忆 / 剧情整理 ----------

  const [isDigesting, setIsDigesting] = useState(false);
  const digestCursor = useSessionStore((s) =>
    activeSessionId ? s.digestCursors[activeSessionId] ?? 0 : 0,
  );
  const digestEnabled = useSessionStore((s) => s.digestConfig.enabled);

  // 待整理条数（消息总数 − 整理游标）
  const pendingDigestCount = Math.max(0, messagesLength - digestCursor);

  // 自动整理：消息数变化且空闲时尝试（runner 内部有阈值、单飞与冷却保护）
  useEffect(() => {
    if (!hydrated || !activeSessionId || !digestEnabled) return;
    if (phase === "streaming" || phase === "paused") return;
    void maybeRunDigest(activeSessionId);
  }, [
    messagesLength,
    digestCursor,
    activeSessionId,
    hydrated,
    phase,
    digestEnabled,
  ]);

  const handleRunDigest = useCallback(async () => {
    if (!activeSessionId) return;
    setIsDigesting(true);
    try {
      await runDigestNow(activeSessionId);
    } finally {
      setIsDigesting(false);
    }
  }, [activeSessionId]);

  /**
   * 启动一次回复（不做排队判断）。
   *
   * @param text 用户消息
   * @param skipAdd 消息是否已经上屏（排队消息在入队时已上屏，避免重复插入）
   * @param quote 引用的消息（可选）：一方面随消息落库用于渲染引用块，
   *              另一方面拼进本次 Prompt，让角色知道引用的是哪句话
   */
  const startReply = (
    text: string,
    skipAdd = false,
    quote?: IMessageQuote,
  ): boolean => {
    if (!activeSessionId) return false;
    const state = useSessionStore.getState();
    const session = state.sessions[activeSessionId];
    if (!session) return false;

    const characterId = session.participantIds.find((id) => id !== "user");
    const character = characterId ? state.characters[characterId] : null;
    if (!character) return false;

    const engine = engineManager.getOrCreate(activeSessionId, character);
    // 引用信息进 Prompt：模型才知道"你刚才说的那句"具体是哪句
    const promptText = quote ? formatQuotedText(text, quote) : text;
    // 先用"不含本条"的历史注入上下文（历史 / 模板 / 记忆 / 剧情）
    syncEngineContext(engine, activeSessionId, promptText);

    // 再把用户消息显示到聊天界面（排队消息已提前上屏）
    if (!skipAdd) addUserMessage(text, activeSessionId, quote);

    const adapter = getLLMAdapter();
    try {
      engine.startStreamWithAdapter(promptText, adapter);
      return true;
    } catch (error) {
      // 引擎忙 / 启动失败：回退 UI 状态，避免输入框被永久锁在"正在回复"
      console.warn("[App] 启动回复失败：", error);
      useChatStore.setState({
        phase: "idle",
        typingIndicator: { active: false, estimatedRemainingMs: 0 },
        pendingCount: 0,
        lastError: {
          code: "engine-busy",
          message: "上一次回复尚未结束，请稍候再试",
        },
      });
      return false;
    }
  };

  const handleSubmit = (text: string) => {
    setInputValue("");
    if (!activeSessionId) return;

    // 引用只对"这一条"生效：取走后立刻清空，避免连发时每条都带上引用
    const quote = quoting ?? undefined;
    setQuoting(null);

    // 消息已发出：该会话的草稿随之清空
    useSessionStore.getState().setDraft(activeSessionId, "");

    // 微信式体验：对方正在回复时也允许继续发消息——
    // 消息立即上屏并进入队列，等当前回复结束后自动发送。
    const currentPhase = useChatStore.getState().phase;
    if (currentPhase === "streaming" || currentPhase === "paused") {
      useChatStore
        .getState()
        .enqueueUserMessage(text, activeSessionId, quote);
      return;
    }

    startReply(text, false, quote);
  };

  /**
   * 发一个表情。
   *
   * 与发文本一致：先上屏，再让角色对这条消息作出反应——模型看到的是
   * "[微笑]" 这样的占位文本（`toLLMHistory` 一直在做这件事），
   * 所以角色会针对表情回一句，而不是石沉大海。
   *
   * 对方正在回复时只上屏、不排队：贴图是即时表达，
   * 为它专门排一轮回复反而怪。
   */
  const handleSendSticker = (sticker: {
    readonly stickerPackId: string;
    readonly stickerId: string;
    readonly fallbackText: string;
  }) => {
    const sessionId = useSessionStore.getState().activeSessionId;
    if (!sessionId) return;

    // 先看当前是不是在回复中（addStickerMessage 会把 phase 置为 streaming，
    // 之后再判断就永远是"忙"，角色不会回应）
    const currentPhase = useChatStore.getState().phase;
    const busy = currentPhase === "streaming" || currentPhase === "paused";

    addStickerMessage(sessionId, sticker);
    if (busy) return;

    startReply(sticker.fallbackText, true);
  };

  /**
   * 重新生成最后一条回复：撤掉整轮 AI 气泡，用同一句用户消息重发。
   *
   * 轮次定位交给 findLastReplyTurn（末尾必须是角色消息、且紧邻它的是一条
   * 用户消息），所以"角色主动发的消息"不会走到这里。
   */
  const handleRegenerate = useCallback(() => {
    if (!activeSessionId) return;
    const chat = useChatStore.getState();
    if (chat.phase === "streaming" || chat.phase === "paused") return;

    const session = useSessionStore.getState().sessions[activeSessionId];
    const characterId = session?.participantIds.find((id) => id !== "user");
    if (!characterId) return;

    const target = findLastReplyTurn(chat.messages, characterId);
    if (!target) return;

    // 先撤掉这一轮回复，再用同样的内容重新生成（用户消息已在屏上，不重复插入）
    chat.removeMessagesFrom(target.fromMessageId);
    startReply(target.userText, true, target.quote);
    // startReply 依赖当前会话数据，这里只在会话切换时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  /**
   * 编辑后重发：撤回这条用户消息及其之后的全部回复，再按新文本发送。
   *
   * 只允许改最后一条用户消息（入口由 MessageList 控制），
   * 所以这里不需要再判断位置——改中间会让后面的对话失去前提。
   */
  const handleEditSubmit = useCallback((messageId: string, text: string) => {
    if (!activeSessionId) return;
    const chat = useChatStore.getState();
    if (chat.phase === "streaming" || chat.phase === "paused") return;
    if (!text.trim()) return;

    // 引用来自被改的那条消息本身（编辑不改引用）
    const original = chat.messages.find(
      (item) => item.message.id === messageId,
    );
    const quote = original?.message.quote;
    chat.removeMessagesFrom(messageId);
    startReply(text.trim(), false, quote);
    // startReply 依赖当前会话数据，这里只在会话切换时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  /**
   * 删除单条消息：**连同它留下的痕迹一起抹掉**。
   *
   * 只从消息列表里摘掉是不够的：后台整理早就把这句话提炼成了长期记忆与
   * 剧情事件，删完再聊角色照样"记得"。所以这里顺手让记忆库与时间线也忘掉
   * 来自这句话的条目（相似度比对，宁可少删不可错删，详见 core 的
   * `forgetMemoriesFromTexts`）。
   *
   * 撤回**不**走这条路：真人撤回一条消息，对方脑子里那段记忆是撤不掉的。
   */
  const handleDeleteMessage = useCallback((messageId: string) => {
    const chat = useChatStore.getState();
    const target = chat.messages.find(
      (item) => item.message.id === messageId,
    )?.message;
    const text = target ? getMessagePlainText(target) : null;

    chat.deleteMessage(messageId);
    if (!text) return;

    const store = useSessionStore.getState();
    const sessionId = store.activeSessionId;
    if (!sessionId) return;
    const session = store.sessions[sessionId];
    const characterId = session?.participantIds.find((id) => id !== "user");

    const forgottenMemories = characterId
      ? store.forgetMemoriesAbout(characterId, [text], [messageId])
      : 0;
    const forgottenEvents = store.forgetPlotEventsAbout(sessionId, [text]);
    if (forgottenMemories > 0 || forgottenEvents > 0) {
      console.info(
        `[删除] 已让角色忘掉这条消息：记忆 ${forgottenMemories} 条、剧情事件 ${forgottenEvents} 条`,
      );
    }
  }, []);

  /**
   * 队列消费：当前没有进行中的回复且队列非空时，自动发出队首消息。
   */
  const queuedCount = useChatStore((s) => s.queuedUserTexts.length);
  /**
   * 队列消费失败后的冷却时间。
   *
   * 场景：切回一个"上次没聊完"的会话时，后台可能还有一轮在跑，这时排队
   * 消息取出来也发不出去。把它塞回队首并等几秒再试——没有这个冷却就会
   * 变成"取出→塞回→再取出"的死循环。
   */
  const queueRetryAtRef = useRef(0);
  useEffect(() => {
    if (!hydrated || !activeSessionId) return;
    if (queuedCount === 0) return;
    const state = useChatStore.getState();
    if (state.phase === "streaming" || state.phase === "paused") return;
    if (Date.now() < queueRetryAtRef.current) return;

    const next = state.shiftQueuedUserText();
    if (next === null) return;
    const started = startReply(next.text, true, next.quote);
    if (!started) {
      // 发不出去就还给队首：它已经上屏了，不能凭空消失
      useChatStore.getState().unshiftQueuedUserText(next);
      queueRetryAtRef.current = Date.now() + 2000;
    }
    // startReply 依赖当前会话数据，这里只需在队列/阶段变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedCount, phase, hydrated, activeSessionId]);

  /** 推进剧情：AI 基于状态卡主动推进一步。 */
  const handleAdvancePlot = useCallback(() => {
    if (!activeSessionId) return;
    const currentPhase = useChatStore.getState().phase;
    if (currentPhase === "streaming" || currentPhase === "paused") return;

    const state = useSessionStore.getState();
    const session = state.sessions[activeSessionId];
    if (!session) return;
    const characterId = session.participantIds.find((id) => id !== "user");
    const character = characterId ? state.characters[characterId] : null;
    if (!character) return;

    const engine = engineManager.getOrCreate(activeSessionId, character);
    engine.setLLMConfig(getLLMConfig());
    syncEngineContext(engine, activeSessionId, "");

    const prompt = buildPlotAdvancePrompt(
      character.displayName,
      state.plotStates[activeSessionId] ?? null,
    );
    try {
      engine.startStreamWithAdapter(prompt, getLLMAdapter());
    } catch {
      // 引擎忙，忽略本次推进
    }
  }, [activeSessionId, engineManager]);

  /** 重试上一条用户消息：移除它再走正常发送流程（避免历史里重复一条）。 */
  const handleRetryLast = () => {
    if (!activeSessionId) return;
    const messages = useChatStore.getState().messages;
    const lastUser = [...messages]
      .reverse()
      .find(
        (runtime) =>
          runtime.message.senderId === "user" &&
          runtime.message.type === "text",
      );
    if (!lastUser || lastUser.message.type !== "text") return;

    const text = lastUser.message.text;
    // 移除失败的那条用户消息，交给 handleSubmit 重新插入并发送
    useChatStore.setState({
      messages: messages.filter((runtime) => runtime !== lastUser),
      lastError: null,
      pendingCount: 0,
    });
    handleSubmit(text);
  };

  const handleRecreateAdapter = useCallback(() => {
    recreateAdapter(engineManager);
    // 刚在设置里改完 key/模型：把整理失败后的冷却清掉，让它能立刻重试
    resetDigestRunnerState();
  }, [engineManager]);

  const handleTestConnection = useCallback(() => testLLMConnection(), []);

  /** 导出全部数据为 JSON 备份文件。 */
  const handleExportBackup = useCallback((): IBackupActionResult => {
    try {
      const counts = exportBackupToFile();
      return {
        ok: true,
        message:
          `已导出：${counts.sessions} 个会话 / ${counts.messages} 条消息 / ` +
          `${counts.characters} 个角色 / ${counts.memories} 条记忆`,
      };
    } catch (error) {
      console.warn("[App] 导出备份失败：", error);
      return { ok: false, message: "导出失败，请检查浏览器是否拦截了下载。" };
    }
  }, []);

  /** 从备份文件导入（合并模式）。 */
  const handleImportBackup = useCallback(
    (file: File) => importBackupFromFile(file),
    [],
  );

  /**
   * 界面崩溃时的"抢救导出"：直接读 store 拼备份，不依赖已经崩掉的渲染树。
   * 平时走设置页的导出，这里是白屏时的最后一条退路。
   */
  const handleRescueExport = useCallback(() => {
    downloadTextFile(
      buildBackupText(),
      `zhichi-backup-rescue-${Date.now()}.json`,
    );
  }, []);

  /** 导出单个角色为角色卡（不含记忆与聊天记录）。 */
  const handleExportCharacterCard = useCallback((characterId: string) => {
    const result = exportCharacterCardToFile(characterId);
    if (!result.ok) console.warn("[App] 导出角色卡失败：", result.message);
  }, []);

  /** 导入角色卡（新增角色，不覆盖已有）。 */
  const handleImportCharacterCard = useCallback(
    (file: File) => importCharacterCardFile(file),
    [],
  );

  /**
   * AI 生成角色草稿。
   *
   * 生成是"写一张人设"，与当前会话无关，所以不进引擎；
   * 结果由角色编辑器填进表单，用户确认后才落库。
   */
  const handleGenerateCharacter = useCallback(
    (
      description: string,
      hooks?: {
        readonly onProgress?: (progress: {
          readonly receivedChars: number;
          readonly name: string | null;
        }) => void;
        readonly signal?: AbortSignal;
      },
    ) => generateCharacterDraft(description, hooks),
    [],
  );

  /**
   * 导出某个会话的聊天记录（Markdown）。
   *
   * 导出成功/失败只写控制台提示——菜单里点一下就下载，
   * 不需要再弹一层确认。
   */
  const handleExportTranscript = useCallback((sessionId: string) => {
    const result = exportSessionTranscript(sessionId);
    if (!result.ok) console.warn("[transcript] " + result.message);
  }, []);

  /**
   * 聊天记录搜索 → 点击结果：切到该会话，并记下要定位的消息。
   *
   * 定位留给 ChatSessionView：它需要等会话切换后列表重建、消息灌入完成，
   * 才能找到那一行 DOM。
   */
  const [pendingJump, setPendingJump] = useState<{
    readonly sessionId: string;
    readonly messageId: string;
  } | null>(null);

  const handleJumpToMessage = useCallback(
    (sessionId: string, messageId: string) => {
      useSessionStore.getState().switchSession(sessionId);
      setPendingJump({ sessionId, messageId });
    },
    [],
  );

  const handleJumpHandled = useCallback(() => setPendingJump(null), []);

  const isStreaming = phase === "streaming" || phase === "paused";

  // Hydration 未完成
  if (!hydrated) {
    return (
      <div className="wechat-app wechat-app--loading">
        <p>正在恢复聊天记录…</p>
      </div>
    );
  }

  // 获取当前会话角色信息
  const currentSession = activeSessionId ? sessions[activeSessionId] : null;
  const currentCharacterId = currentSession?.participantIds.find((id) => id !== "user");
  const currentCharacter = currentCharacterId ? characters[currentCharacterId] : null;

  return (
    <ErrorBoundary onExportData={handleRescueExport}>
      <WeChatShell
      title="咫尺"
      onRecreateAdapter={handleRecreateAdapter}
      onTestConnection={handleTestConnection}
      onExportBackup={handleExportBackup}
      onImportBackup={handleImportBackup}
      onJumpToMessage={handleJumpToMessage}
      onImportCharacterCard={handleImportCharacterCard}
      onExportCharacterCard={handleExportCharacterCard}
      onGenerateCharacter={handleGenerateCharacter}
      onExportTranscript={handleExportTranscript}
    >
      {activeSessionId && currentCharacter ? (
        <>
          <ChatSessionView
            sessionId={activeSessionId ?? undefined}
            characterDisplayName={currentCharacter.displayName}
            characterAvatarUrl={currentCharacter.visualMetadata.avatarUrl}
            characterProfile={currentCharacter}
            onRetry={handleRetryLast}
            onRegenerate={handleRegenerate}
            onEditSubmit={handleEditSubmit}
            jumpToMessageId={
              pendingJump && pendingJump.sessionId === activeSessionId
                ? pendingJump.messageId
                : undefined
            }
            onJumpHandled={handleJumpHandled}
            onQuote={setQuoting}
            onDeleteMessage={handleDeleteMessage}
          />
          <InputBar
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            disabled={isStreaming}
            onOpenPrompts={() => setPromptPanelOpen(true)}
            onAdvancePlot={handleAdvancePlot}
            onSendSticker={handleSendSticker}
            quote={quoting ?? undefined}
            onCancelQuote={() => setQuoting(null)}
            placeholder={
              isStreaming
                ? "对方正在回复…（仍可继续发消息）"
                : "输入消息..."
            }
          />
          {isStreaming && (
            <button
              type="button"
              onClick={abortStream}
              style={{
                position: "absolute",
                bottom: "70px",
                right: "16px",
                background: "#fa5151",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                padding: "4px 12px",
                fontSize: "12px",
                cursor: "pointer",
                zIndex: 10,
              }}
            >
              中止
            </button>
          )}
        </>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
          <div style={{ textAlign: "center" }}>
            <p style={{ fontSize: "16px", marginBottom: "8px" }}>选择一个聊天开始对话</p>
            <p style={{ fontSize: "13px" }}>或去通讯录添加新角色</p>
          </div>
        </div>
      )}
      {promptPanelOpen && (
        <PromptPanel
          onClose={() => setPromptPanelOpen(false)}
          onApply={(content) => setInputValue(content)}
          onRunDigest={handleRunDigest}
          pendingDigestCount={pendingDigestCount}
          isDigesting={isDigesting}
        />
      )}
      </WeChatShell>
    </ErrorBoundary>
  );
}
