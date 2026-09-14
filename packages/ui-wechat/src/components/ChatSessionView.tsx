/**
 * @file ChatSessionView.tsx
 * 聊天会话主视图。受控组件，状态全部来自 useChatStore。
 *
 * 职责：
 * - 渲染消息列表（按 timestamp 稳定排序，原生滚动）
 * - 顶部显示角色名 + 在场状态（在线/正在输入/已就寝）
 * - 滚动到底部锚定最新消息
 * - 透传"对方正在输入..."占位气泡
 *
 * 性能优化：
 * - 消息行 `content-visibility: auto` 跳过屏外渲染，500+ 消息不帧率退化
 * - Zustand selector 拆细：messages.length 单独数字比较；messages 用 shallow
 * - 排序移到 useMemo
 *
 * 不直接调用引擎，不直接接收 LLM 流。
 */

import {
  memo,
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import type { FC } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  CharacterPresence,
  ICharacterProfile,
  IMessageQuote,
  SessionPhase,
} from "@wechat-rp/shared-types";

import { useChatStore } from "../store/chatStore";
import type { IMessageRuntime } from "../store/chatStore";
import { sortMessagesForDisplay } from "../utils/messageOrder";
import { findLastReplyTurn } from "../utils/regenerate";
import { shouldFollowBottom } from "../utils/scrollFollow";
import { MessageList } from "./MessageList";
import { PinnedSprite } from "./PinnedSprite";
import { NewMessagePill } from "./NewMessagePill";
import { ErrorRetryBubble } from "./ErrorRetryBubble";

/**
 * "贴底"判定阈值（px）。
 *
 * 滚动位置距底部在该范围内即视为用户仍想跟随最新消息；
 * 用户主动向上翻阅超过该距离后，新消息只累计未读、不强行拉回。
 */
const SCROLL_STICKY_THRESHOLD_PX = 120;

/**
 * 消息列表一次渲染多少条（往上滚再加载更早的）。
 *
 * 为什么需要它：`content-visibility` 只省绘制，React 仍要为每条消息创建
 * 真实 DOM。实测 3000 条会话切进去 **首帧要 856ms、其中 788ms 是一个长任务**
 * ——界面整整卡住将近一秒。限制渲染窗口后这段开销与消息总量脱钩。
 */
const VISIBLE_WINDOW_STEP = 300;
/** 距离顶部多少像素内触发"加载更早"。 */
const LOAD_EARLIER_THRESHOLD_PX = 240;

export interface IChatSessionViewProps {
  /** 当前会话 ID（切换会话时重建列表 DOM 并复位未读）。 */
  readonly sessionId?: string;
  /** 重试上一条用户消息（LLM 失败后显示重试气泡）。 */
  readonly onRetry?: () => void;
  /** 当前角色显示名（顶部标题栏）。 */
  readonly characterDisplayName: string;
  /** 角色头像 URL。 */
  readonly characterAvatarUrl: string;
  /** 完整角色档案（用于 AvatarWithSprite 立绘弹出）。 */
  readonly characterProfile?: ICharacterProfile;
  /** 自定义消息渲染器（可选，用于自定义气泡样式）。 */
  readonly renderMessage?: (runtime: IMessageRuntime) => React.ReactNode;
  /** 需要定位并高亮的消息 ID（从聊天记录搜索跳转过来）。 */
  readonly jumpToMessageId?: string;
  /** 定位完成回调（父组件据此清空待跳转状态）。 */
  readonly onJumpHandled?: () => void;
  /**
   * 重新生成最后一条回复。
   * 只有"末尾确实是本角色的回复、且能找到触发它的用户消息"时父组件才传，
   * 因此这里是可选属性——不满足条件就整个不显示入口。
   */
  readonly onRegenerate?: () => void;
  /** 提交"编辑后重发"（撤回这条用户消息及其后的回复，再按新文本发送）。 */
  readonly onEditSubmit?: (messageId: string, text: string) => void;
  /** 引用某条消息（父组件把引用放进输入栏，随下一条消息一起发出）。 */
  readonly onQuote?: (quote: IMessageQuote) => void;
  /**
   * 删除某条消息。
   *
   * 不传时用 store 里的默认实现（只从消息列表里摘掉）。组装层传进来的话
   * 可以顺手做更多：删除意味着"让角色忘掉这一句"，所以 App 会同时抹掉
   * 记忆与剧情里由这句话衍生出来的条目。
   */
  readonly onDeleteMessage?: (messageId: string) => void;
}

interface IChatSessionViewInternalProps extends IChatSessionViewProps {
  readonly messages: ReadonlyArray<IMessageRuntime>;
  readonly presence: CharacterPresence;
  readonly presenceText: string;
  readonly typingActive: boolean;
  /** 会话阶段（streaming/paused 表示这一轮还没交付完）。 */
  readonly phase: SessionPhase;
  readonly lastError: { code: string; message: string } | null;
  /** 删除单条消息（来自 store）。 */
  readonly onDeleteMessage: (messageId: string) => void;
  /** 撤回单条消息（来自 store）。 */
  readonly onRecallMessage: (messageId: string) => void;
  /** "以下为新消息"分隔线的位置（来自 store）。 */
  readonly unreadMarkerMessageId: string | null;
}

const ChatSessionViewInner: FC<IChatSessionViewInternalProps> = ({
  sessionId,
  characterDisplayName,
  characterAvatarUrl,
  characterProfile,
  messages,
  presence,
  presenceText,
  typingActive,
  phase,
  lastError,
  onDeleteMessage,
  onRecallMessage,
  unreadMarkerMessageId,
  onRetry,
  renderMessage,
  jumpToMessageId,
  onJumpHandled,
  onRegenerate,
  onEditSubmit,
  onQuote,
}) => {
  // 智能滚动（原生滚动容器 + 贴底黏性判定）
  const [unreadCount, setUnreadCount] = useState(0);
  /** 从聊天记录搜索跳转过来时高亮的消息 ID（随后自动淡出）。 */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 渲染窗口的大小（往上滚会变大）。 */
  const [windowSize, setWindowSize] = useState(VISIBLE_WINDOW_STEP);
  /**
   * 窗口右端在消息数组里的下标（不含）。
   *
   * `null` = 跟着最新消息走（聊天时的常态）。跳到很老的消息时会被设成
   * 一个具体下标，窗口就"平移"过去——只渲染目标附近那一段，
   * 而不是把从目标到今天的几千条全渲染出来（实测那样要 800ms）。
   */
  const [windowEnd, setWindowEnd] = useState<number | null>(null);
  /**
   * 会话内部的跳转目标（点击引用块跳到被引用的消息）。
   *
   * 与 `jumpToMessageId`（跨会话搜索跳转，由父组件驱动）走同一套定位逻辑，
   * 区别只是这里不需要切会话。
   */
  const [localJumpId, setLocalJumpId] = useState<string | null>(null);
  const prevMsgCountRef = useRef(messages.length);
  /** 滚动容器（由 Virtuoso 的 scrollerRef 注入，用于精确判断是否贴底）。 */
  const scrollerElRef = useRef<HTMLElement | null>(null);
  /**
   * "跟随底部"黏性标志。
   *
   * 只由真实滚动事件维护：内容增高不会触发 scroll 事件，
   * 因此不会像"实时测量 gap"那样被新气泡自身撑开的距离误判。
   */
  const stickyBottomRef = useRef(true);
  /** 滚动监听里回调"加载更早"，避免把监听绑到会频繁变化的闭包上。 */
  const loadEarlierRef = useRef<(() => void) | null>(null);
  /** 平移窗口时，滚到底部继续往下加载。 */
  const loadLaterRef = useRef<(() => void) | null>(null);
  /** 加载更早消息前的视口锚点（scrollHeight − scrollTop），用于补偿。 */
  const pendingAnchorRef = useRef<number | null>(null);
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    scrollerElRef.current = (el as HTMLElement | null) ?? null;
  }, []);

  /**
   * 绑定滚动监听维护"贴底黏性"。
   *
   * 用 effect 而非 ref 回调：ref 回调在 key 变化/严格模式下会经历
   * attach→detach→attach 顺序，容易在重挂载时丢失监听。
   * 会话切换时列表 DOM 会重建（sessionKey），故依赖 sessionId 重新绑定。
   */
  useEffect(() => {
    const element = scrollerElRef.current;
    if (!element) return;

    const onScroll = (): void => {
      const gap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      stickyBottomRef.current = gap <= SCROLL_STICKY_THRESHOLD_PX;
      // 滚到接近顶部就往上加载更早的消息
      if (element.scrollTop <= LOAD_EARLIER_THRESHOLD_PX) {
        loadEarlierRef.current?.();
      }
      // 在"平移后的窗口"里滑到底部，继续往下放一段
      if (gap <= SCROLL_STICKY_THRESHOLD_PX) {
        loadLaterRef.current?.();
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
    };
  }, [sessionId]);

  /** 主动滚动到底部（跳过 smooth，避免恢复时可见的跳动）。 */
  const scrollToBottomNow = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickyBottomRef.current = true;
    setUnreadCount(0);
  }, []);

  // 消息数变化时判断：在底部则清零未读，不在底部则累加
  // 注意：必须放在 effect 中 —— 渲染期间 setState 在 StrictMode 下会被双调用
  // 导致未读计数翻倍。
  const messageCount = messages.length;
  useEffect(() => {
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = messageCount;
    const lastSenderId = messages[messages.length - 1]?.message.senderId;

    if (
      shouldFollowBottom({
        prevCount: prev,
        messageCount,
        lastSenderId,
        stickyBottom: stickyBottomRef.current,
      })
    ) {
      requestAnimationFrame(() => scrollToBottomNow());
      return;
    }

    // 走到这里必然是"用户在翻阅历史时收到的新消息"（见 shouldFollowBottom）
    // → 不打扰阅读，只累计未读提示
    const delta = messageCount - prev;
    setUnreadCount((count) => count + delta);
  }, [messageCount, messages, scrollToBottomNow]);

  // 切换会话：复位未读与计数基准（虚拟列表由 sessionKey 重建）
  useEffect(() => {
    // 基准归零：下一个消息 effect 会把"已恢复的历史"当作首次填充并贴底
    prevMsgCountRef.current = 0;
    setUnreadCount(0);
    // 渲染窗口复位，不然切走的会话留下的窗口会带到新会话
    setWindowSize(VISIBLE_WINDOW_STEP);
    setWindowEnd(null);
    // Virtuoso 因 sessionKey 变化重建，等重建后再贴底
    requestAnimationFrame(() => scrollToBottomNow());
    // 仅在会话切换时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 排序用 useMemo 避免每次渲染都创建新数组
  const sorted = useMemo(
    () => sortMessagesForDisplay(messages),
    [messages],
  );

  /** 窗口右端（null 表示贴住最新）。 */
  const resolvedEnd = windowEnd === null ? sorted.length : Math.min(windowEnd, sorted.length);
  const windowStart = Math.max(0, resolvedEnd - windowSize);
  const atTail = resolvedEnd >= sorted.length;

  /** 实际交给列表渲染的那一段。 */
  const visibleMessages = useMemo(
    () => (windowStart === 0 && windowSize >= sorted.length
      ? sorted
      : sorted.slice(windowStart, resolvedEnd)),
    [sorted, windowStart, resolvedEnd, windowSize],
  );

  /**
   * 往上加载更早的消息。
   *
   * 前插 DOM 会把当前视口整体往下顶，所以要按"加载前后 scrollHeight 的差值"
   * 把 scrollTop 补回去，用户视野才不会跳。
   */
  const loadEarlier = useCallback(() => {
    if (windowStart <= 0) return;
    // 正在加载就别重复触发（滚动事件会连发）
    if (pendingAnchorRef.current !== null) return;
    const el = scrollerElRef.current;
    pendingAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setWindowSize((size) => size + VISIBLE_WINDOW_STEP);
  }, [windowStart]);

  loadEarlierRef.current = loadEarlier;

  /**
   * 窗口右端往下扩（用户在"平移后的窗口"底部继续往下翻）。
   * 追加在下方不会顶动视口，所以不需要补偿。
   */
  const loadLater = useCallback(() => {
    if (atTail) return;
    setWindowEnd((end) => {
      const current = end ?? sorted.length;
      return Math.min(sorted.length, current + VISIBLE_WINDOW_STEP);
    });
  }, [atTail, sorted.length]);

  loadLaterRef.current = loadLater;

  /**
   * 视口补偿必须在 **DOM 更新之后**做。
   *
   * 一开始写成 requestAnimationFrame，结果它在 React 提交之前就跑了，
   * 拿到的还是旧的 scrollHeight，scrollTop 被算回 0——用户视野直接跳到
   * 刚加载出来的那批老消息上（实测 scrollTopAfterLoad=0）。
   */
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (anchor === null) return;
    pendingAnchorRef.current = null;
    const el = scrollerElRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchor;
  }, [windowSize]);

  /**
   * 是否显示「换一条」入口：末尾必须是本角色的回复，且能找到触发它的
   * 用户消息（角色主动发的消息没有可重发内容，不显示）。
   */
  const canRegenerate = useMemo(
    () =>
      characterProfile
        ? findLastReplyTurn(sorted, characterProfile.id) !== null
        : false,
    [sorted, characterProfile],
  );

  /**
   * 从搜索结果跳转到指定消息：滚到可视区中部并高亮。
   *
   * 有三个坑：
   * 1. 切换会话时列表 DOM 会重建、消息随后才灌进 store，所以找不到目标要重试；
   * 2. 贴底逻辑会在消息数变化时把视图拉回底部，跳转前必须先解除黏性；
   * 3. 消息行开了 `content-visibility: auto`，屏外行的高度是估算值，
   *    滚过去之后真实高度才算出来——因此定位分两拍，第二拍做一次校正。
   */
  useEffect(() => {
    const target = jumpToMessageId ?? localJumpId;
    if (!target) return;

    // 目标可能在渲染窗口之外（比如搜到很久以前的消息）：
    // 把窗口"平移"过去，让目标落在中间——只渲染一段，
    // 而不是把从目标到今天的几千条全渲染出来（实测那样要 800ms）
    const targetIndex = sorted.findIndex((m) => m.message.id === target);
    if (targetIndex >= 0) {
      const half = Math.floor(VISIBLE_WINDOW_STEP / 2);
      // 让目标落在窗口中间；靠近末尾时窗口自然贴回尾部
      setWindowEnd(
        Math.min(sorted.length, Math.max(targetIndex + half, VISIBLE_WINDOW_STEP)),
      );
      setWindowSize(VISIBLE_WINDOW_STEP);
    }

    let cancelled = false;
    let retryTimer: number | undefined;
    let settleTimer: number | undefined;

    /**
     * 把目标行滚到滚动容器垂直中央，返回滚动后的残余偏移（px）。
     * 不用 scrollIntoView：它会连带滚动祖先元素，可能把整个布局顶飞。
     */
    const centerOn = (row: HTMLElement, scroller: HTMLElement): number => {
      const scrollerRect = scroller.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const delta = rowRect.top - scrollerRect.top;
      scroller.scrollTop += delta - scroller.clientHeight / 2 + rowRect.height / 2;
      // 滚动后重新测量：内容还没渲染完时，实际落点与目标会有偏差
      const after = row.getBoundingClientRect();
      const afterScroller = scroller.getBoundingClientRect();
      return (
        after.top +
        after.height / 2 -
        (afterScroller.top + afterScroller.height / 2)
      );
    };

    const findRow = (): { scroller: HTMLElement; row: HTMLElement } | null => {
      const scroller = scrollerElRef.current;
      if (!scroller) return null;
      const row = scroller.querySelector<HTMLElement>(
        `[data-message-id="${target}"]`,
      );
      return row ? { scroller, row } : null;
    };

    const attempt = (retriesLeft: number): void => {
      if (cancelled) return;
      const found = findRow();
      if (!found) {
        if (retriesLeft > 0) {
          retryTimer = window.setTimeout(() => attempt(retriesLeft - 1), 120);
        } else {
          onJumpHandled?.();
        }
        return;
      }

      // 解除贴底黏性：否则下一条新消息会把视图拉回底部
      stickyBottomRef.current = false;
      setHighlightId(target);

      /**
       * 收敛循环：屏外消息行开了 `content-visibility`，高度是估算值，
       * 滚过去之后真实高度才算出来，会把目标顶偏。这里反复微调几次，
       * 偏到 4px 以内就停；最多 6 轮，避免无限修正。
       */
      const settle = (remaining: number): void => {
        if (cancelled) return;
        const current = findRow();
        if (!current) {
          onJumpHandled?.();
          setLocalJumpId(null);
          return;
        }
        const residual = centerOn(current.row, current.scroller);
        if (remaining > 0 && Math.abs(residual) > 4) {
          settleTimer = window.setTimeout(() => settle(remaining - 1), 120);
          return;
        }
        onJumpHandled?.();
        setLocalJumpId(null);
      };

      settle(6);
    };

    const raf = requestAnimationFrame(() => attempt(4));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    };
  }, [jumpToMessageId, localJumpId, onJumpHandled]);

  // 高亮 2 秒后自动淡出
  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), 2200);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  // 点击新消息 pill → 滚到底
  /** 点击引用块：跳到被引用的那条消息（复用搜索跳转的定位与高亮）。 */
  const handleJumpToQuote = useCallback((messageId: string) => {
    setLocalJumpId(messageId);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickyBottomRef.current = true;
    setUnreadCount(0);
  }, []);

  return (
    <section
      className="wechat-chat-session"
      role="log"
      aria-live="polite"
      aria-label={`与 ${characterDisplayName} 的聊天`}
    >
      <header className="wechat-chat-session__header">
        <span className="wechat-chat-session__name">{characterDisplayName}</span>
        <span className="wechat-chat-session__presence" data-presence={presence}>
          {presenceText}
        </span>
      </header>

      <div className="wechat-chat-session__list">
        <MessageList
          sessionKey={sessionId}
          messages={visibleMessages}
          characterAvatarUrl={characterAvatarUrl}
          characterProfile={characterProfile}
          typingActive={typingActive}
          renderMessage={renderMessage}
          scrollerRef={handleScrollerRef}
          highlightMessageId={highlightId}
          onEditSubmit={onEditSubmit}
          onQuote={onQuote}
          onJumpToQuote={handleJumpToQuote}
          onDeleteMessage={onDeleteMessage}
          onRecallMessage={onRecallMessage}
          unreadMarkerMessageId={unreadMarkerMessageId}
        />
      </div>
      {/*
        固定立绘：屏幕级图层，整个会话视图只渲染一份。
        情绪取"最后一条角色消息"的情绪，没有就中性。
      */}
      <PinnedSprite
        profile={characterProfile}
        emotion={
          [...sorted].reverse().find((m) => m.message.senderId !== "user")
            ?.message.emotion ?? "neutral"
        }
      />
      {unreadCount > 0 && (
        <NewMessagePill
          unreadCount={unreadCount}
          onClick={scrollToBottom}
        />
      )}
      {/*
        窗口平移走了（在看很久以前的消息）时，给一个回最新的出口。
        否则用户只能靠往上翻把窗口滑回去。
      */}
      {!atTail && (
        <div className="wechat-chat-session__back-to-latest">
          <button
            type="button"
            className="wechat-chat-session__back-to-latest-btn"
            onClick={() => {
              setWindowEnd(null);
              setWindowSize(VISIBLE_WINDOW_STEP);
              requestAnimationFrame(() => scrollToBottomNow());
            }}
          >
            回到最新 ↓
          </button>
        </div>
      )}
      {/*
        重新生成：只在"末尾是本角色的回复、且能找到触发它的用户消息"时出现
        （父组件据此决定传不传 onRegenerate）。回复进行中不显示。
      */}
      {onRegenerate &&
        canRegenerate &&
        !typingActive &&
        phase !== "streaming" &&
        phase !== "paused" && (
        <div className="wechat-chat-session__regenerate">
          <button
            type="button"
            className="wechat-chat-session__regenerate-btn"
            onClick={onRegenerate}
            title="撤掉这条回复，用同样的问题重新生成一次"
          >
            ↻ 换一条
          </button>
        </div>
      )}
      {/*
        错误重试气泡：LLM 请求失败（非流式中）时显示，
        让用户可以重发上一条消息，而不必手动重新输入。
      */}
      {lastError && !typingActive && onRetry && (
        <div className="wechat-chat-session__error">
          <ErrorRetryBubble
            errorMessage={lastError.message || "发送失败"}
            onRetry={onRetry}
            isSelf
          />
        </div>
      )}
    </section>
  );
};

/**
 * 受控包装组件：从 store 取状态注入内部组件。
 * 外部直接使用 <ChatSessionView /> 即可。
 *
 * Selector 优化：
 * - messages: 用 useShallow 比较数组内容（内部元素引用不变时不触发重渲染）
 * - 其他字段: 各自单独 selector，避免不相关字段变化触发重渲染
 */
export const ChatSessionView: FC<IChatSessionViewProps> = memo((props) => {
  // messages 用 useShallow：数组内容变化时才触发重渲染。
  // 注意不能用 `useChatStore(selector, shallow)` 的三参形式——zustand v4.5
  // 已弃用该写法，会在控制台打印 [DEPRECATED] 警告。
  const messages = useChatStore(useShallow((s) => s.messages));
  const presence = useChatStore((s) => s.presence);
  const presenceText = useChatStore((s) => s.presenceText);
  const phase = useChatStore((s) => s.phase);
  const typingActive = useChatStore((s) => s.typingIndicator.active);
  const lastError = useChatStore((s) => s.lastError);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const recallMessage = useChatStore((s) => s.recallMessage);
  const unreadMarkerMessageId = useChatStore((s) => s.unreadMarkerMessageId);

  return (
    <ChatSessionViewInner
      {...props}
      messages={messages}
      presence={presence}
      presenceText={presenceText}
      typingActive={typingActive}
      phase={phase}
      lastError={lastError}
      onDeleteMessage={props.onDeleteMessage ?? deleteMessage}
      onRecallMessage={recallMessage}
      unreadMarkerMessageId={unreadMarkerMessageId}
    />
  );
});

ChatSessionView.displayName = "ChatSessionView";
