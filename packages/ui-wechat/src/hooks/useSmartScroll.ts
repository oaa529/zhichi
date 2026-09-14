/**
 * @file useSmartScroll.ts
 *
 * ⚠️ 现状：本 hook 当前**没有内部使用方**——消息列表的"贴底跟随 / 翻阅历史不打断"
 * 逻辑已改为 `ChatSessionView` 内基于滚动容器的实现，判定部分抽到
 * `utils/scrollFollow.ts`（含单测）。保留此 hook 仅供外部复用参考。
 *
 * 智能滚动 hook。
 *
 * 职责：
 * - 监听容器 scroll 事件，判断用户是否在底部
 * - 新消息到来时，仅在用户处于底部时自动滚动
 * - 用户翻阅历史时不强制滚动，显示"新消息 N 条"提示
 *
 * 清理：unmount 时 removeEventListener + clearTimeout
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 判定"在底部"的阈值（px）。 */
const BOTTOM_THRESHOLD = 80;

export interface ISmartScrollResult {
  /** ref 绑定到滚动容器。 */
  readonly containerRef: React.RefObject<HTMLDivElement>;
  /** 当前是否在底部。 */
  readonly isAtBottom: boolean;
  /** 未读新消息数（不在底部时累计）。 */
  readonly unreadCount: number;
  /** 手动滚到底部。 */
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** 重置未读计数（用户点击 pill 时调用）。 */
  readonly clearUnread: () => void;
}

/**
 * 智能滚动 hook。
 *
 * @param deps 触发自动滚动检查的依赖（如 messages.length）
 */
export function useSmartScroll(deps: ReadonlyArray<unknown>): ISmartScrollResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 检查是否在底部
  const checkBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  // scroll 事件（passive + debounce）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(checkBottom, 50);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, [checkBottom]);

  // 依赖变化时：在底部则自动滚动，不在底部则增加未读
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (isAtBottomRef.current) {
      // 在底部 → 自动滚动
      el.scrollTo({ behavior: "smooth", top: el.scrollHeight });
      setUnreadCount(0);
    } else {
      // 不在底部 → 增加未读
      // deps 变化意味着新消息到来
      setUnreadCount((c) => c + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ behavior, top: el.scrollHeight });
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setUnreadCount(0);
  }, []);

  const clearUnread = useCallback(() => setUnreadCount(0), []);

  return {
    containerRef,
    isAtBottom,
    unreadCount,
    scrollToBottom,
    clearUnread,
  };
}
