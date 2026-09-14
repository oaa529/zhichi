/**
 * @file SessionList.tsx
 * 左侧会话列表（"聊天"页面）。
 *
 * 受控组件：数据从 useSessionStore 获取。
 * 点击会话项切换 activeSessionId。
 * 每个会话项右下角有三点菜单（置顶/标为已读/删除）。
 * 头像左上角有未读红点（非活跃会话收到消息时）。
 */

import { memo, useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";
import { useSessionStore } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import type { ISession } from "@wechat-rp/shared-types";
import { PresenceManager } from "@wechat-rp/core";
import { formatSessionTime } from "../utils/sessionTime";
import { Icon } from "./Icon";

/** 长按判定时长（ms），与"长按头像切换固定立绘"保持同一手感。 */
const LONG_PRESS_MS = 500;

export interface ISessionListProps {
  readonly onSelectSession?: (sessionId: string) => void;
  /** 导出某个会话的聊天记录（Markdown）。 */
  readonly onExportTranscript?: (sessionId: string) => void;
}

export const SessionList: FC<ISessionListProps> = memo(({ onSelectSession, onExportTranscript }) => {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const characters = useSessionStore((s) => s.characters);
  const switchSession = useSessionStore((s) => s.switchSession);
  const deleteSessions = useSessionStore((s) => s.deleteSessions);
  const markSessionsAsRead = useSessionStore((s) => s.markSessionsAsRead);
  /** 拟真配置决定"作息感知"是否生效（关了就不显示忙碌/就寝）。 */
  const simulationConfig = useChatStore((s) => s.simulationConfig);

  /**
   * 每分钟重算一次在场状态：它是"当前时刻"的函数，
   * 不定时刷新的话，列表会一直停在你打开页面那一刻的状态。
   */
  const [presenceTick, setPresenceTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setPresenceTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  /** 会话 → 非在线状态（在线的不显示，免得满屏噪声）。 */
  const presenceBySession = useMemo(() => {
    const map: Record<string, { presence: string; text: string }> = {};
    for (const session of Object.values(sessions)) {
      const characterId = session.participantIds.find((id) => id !== "user");
      const character = characterId ? characters[characterId] : undefined;
      if (!character) continue;
      const decision = new PresenceManager(character, simulationConfig).evaluate(
        presenceTick,
      );
      if (decision.presence === "online") continue;
      map[session.id] = {
        presence: decision.presence,
        text: decision.displayText,
      };
    }
    return map;
  }, [sessions, characters, simulationConfig, presenceTick]);

  // 多选管理：长按任一会话进入；进入后点击列表项 = 勾选/取消勾选，
  // 而不是切换会话。批量删除是不可逆操作，删除前仍然弹一次确认。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // 排序：置顶在前，然后按 updatedAt 降序
  const sorted = useMemo(() => {
    return Object.values(sessions).sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [sessions]);

  const handleClick = (id: string) => {
    switchSession(id);
    onSelectSession?.(id);
  };

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set<string>());
  }, []);

  const enterSelection = useCallback((sessionId: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const toggleSelected = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleMarkSelectedRead = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    markSessionsAsRead(ids);
    exitSelection();
  }, [selectedIds, markSessionsAsRead, exitSelection]);

  const handleDeleteSelected = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `确认删除选中的 ${ids.length} 个聊天？聊天记录会一起删除。`,
      )
    ) {
      return;
    }
    deleteSessions(ids);
    exitSelection();
  }, [selectedIds, deleteSessions, exitSelection]);

  return (
    <div className="zhichi-session-list-wrap">
      {selectionMode && (
        <div className="zhichi-session-list__bulk-head">
          <button
            type="button"
            className="zhichi-session-list__bulk-cancel"
            onClick={exitSelection}
          >
            取消
          </button>
          <span className="zhichi-session-list__bulk-count">
            已选 {selectedIds.size} 项
          </span>
        </div>
      )}
      <div className="zhichi-session-list" role="list">
        {sorted.length === 0 && (
          <div className="zhichi-session-list__empty">
            <p>还没有聊天</p>
            <p className="zhichi-session-list__empty-hint">去通讯录添加角色开始聊天</p>
          </div>
        )}
        {sorted.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            selectionMode={selectionMode}
            selected={selectedIds.has(session.id)}
            onClick={() =>
              selectionMode
                ? toggleSelected(session.id)
                : handleClick(session.id)
            }
            onLongPress={() => enterSelection(session.id)}
            onExportTranscript={
              onExportTranscript
                ? () => onExportTranscript(session.id)
                : undefined
            }
            presenceLabel={presenceBySession[session.id]}
          />
        ))}
      </div>
      {selectionMode && (
        <div className="zhichi-session-list__bulk-bar">
          <button
            type="button"
            className="zhichi-session-list__bulk-action"
            onClick={handleMarkSelectedRead}
            disabled={selectedIds.size === 0}
          >
            <Icon name="check" size={14} />
            标为已读
          </button>
          <button
            type="button"
            className="zhichi-session-list__bulk-action zhichi-session-list__bulk-action--danger"
            onClick={handleDeleteSelected}
            disabled={selectedIds.size === 0}
          >
            <Icon name="close" size={14} />
            删除{selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}
          </button>
        </div>
      )}
    </div>
  );
});

SessionList.displayName = "SessionList";

interface ISessionListItemProps {
  readonly session: ISession;
  readonly isActive: boolean;
  /** 是否处于多选管理模式（此时点击 = 勾选）。 */
  readonly selectionMode: boolean;
  /** 这一项是否被勾选。 */
  readonly selected: boolean;
  readonly onClick: () => void;
  /** 长按回调（进入多选模式并选中本项）。 */
  readonly onLongPress: () => void;
  /** 导出这个会话的聊天记录（没接就不显示菜单项）。 */
  readonly onExportTranscript?: () => void;
  /**
   * 这个角色的在场状态（"在上课""已就寝"这类）。
   *
   * 只显示**非在线**的状态：满屏"在线"是噪声，而"它现在在忙/睡了"
   * 正是决定"要不要现在发消息"的那条信息。
   */
  readonly presenceLabel?: { readonly presence: string; readonly text: string };
}

const SessionListItem: FC<ISessionListItemProps> = memo(({
  session,
  isActive,
  selectionMode,
  selected,
  onClick,
  onLongPress,
  onExportTranscript,
  presenceLabel,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const togglePinSession = useSessionStore((s) => s.togglePinSession);
  const markSessionAsRead = useSessionStore((s) => s.markSessionAsRead);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  /** 这个会话的对方是否"正在输入…"（会换掉预览那一行）。 */
  const typing = useSessionStore(
    (s) => s.typingBySession[session.id] === true,
  );

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // 卸载时清掉未触发的长按计时器
  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  const handlePointerDown = useCallback(() => {
    if (selectionMode) return;
    longPressFiredRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  }, [selectionMode, onLongPress, clearLongPressTimer]);

  const handleItemClick = useCallback(() => {
    // 长按进入多选后浏览器仍会补一次 click：这里吃掉它，避免顺带切换会话
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onClick();
  }, [onClick]);

  // 进入多选时收起三点菜单，避免两套操作叠在一起
  useEffect(() => {
    if (selectionMode) setMenuOpen(false);
  }, [selectionMode]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // 菜单内部点击不关闭
      if (menuRef.current?.contains(target)) return;
      // "更多"按钮自身交给 onClick 的 toggle 处理：
      // 若这里也关一次，紧接着的 click 又会把它打开，导致按钮无法关闭菜单。
      if (moreBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const handleMoreClick = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }, []);

  const handleTogglePin = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    togglePinSession(session.id);
    setMenuOpen(false);
  }, [session.id, togglePinSession]);

  const handleMarkRead = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    markSessionAsRead(session.id);
    setMenuOpen(false);
  }, [session.id, markSessionAsRead]);

  const handleDelete = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`确认删除与「${session.displayName}」的聊天记录？`)) {
      deleteSession(session.id);
    }
    setMenuOpen(false);
  }, [session.id, session.displayName, deleteSession]);

  return (
    <div
      className={`zhichi-session-list__item-wrap ${isActive && !selectionMode ? "zhichi-session-list__item--active" : ""}${selectionMode ? " zhichi-session-list__item-wrap--selection" : ""}`}
    >
      <button
        type="button"
        className={`zhichi-session-list__item${selected ? " zhichi-session-list__item--selected" : ""}`}
        role="listitem"
        onClick={handleItemClick}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPressTimer}
        onPointerLeave={clearLongPressTimer}
      >
        {selectionMode && (
          <span
            className={`zhichi-session-list__checkbox${selected ? " zhichi-session-list__checkbox--checked" : ""}`}
            aria-hidden="true"
          >
            {selected && <Icon name="check" size={12} />}
          </span>
        )}
        <div className="zhichi-session-list__avatar">
          {session.avatarUrl ? (
            <img src={session.avatarUrl} alt={session.displayName} />
          ) : (
            <span className="zhichi-session-list__avatar-placeholder">
              {session.displayName.slice(0, 1)}
            </span>
          )}
          {/* 未读红点（左上角） */}
          {session.unreadCount > 0 && !isActive && (
            <span className="zhichi-session-list__unread-dot" />
          )}
          {/* 未读数 badge（右上角） */}
          {session.unreadCount > 0 && (
            <span className="zhichi-session-list__badge">
              {session.unreadCount > 99 ? "99+" : session.unreadCount}
            </span>
          )}
        </div>
        <div className="zhichi-session-list__content">
          <div className="zhichi-session-list__header">
            <span className="zhichi-session-list__name">
              {session.isPinned && <span className="zhichi-session-list__pin-icon">📌</span>}
              {session.displayName}
              {presenceLabel && (
                <span
                  className="zhichi-session-list__presence"
                  data-presence={presenceLabel.presence}
                  title={presenceLabel.text}
                >
                  {presenceLabel.text}
                </span>
              )}
            </span>
            <span className="zhichi-session-list__time">
              {formatSessionTime(session.lastMessageTime)}
            </span>
          </div>
          <div className="zhichi-session-list__preview">
            {typing ? (
              <span className="zhichi-session-list__typing">对方正在输入…</span>
            ) : (
              session.lastMessagePreview || "开始聊天..."
            )}
          </div>
        </div>
      </button>
      {/* 三点菜单按钮 */}
      {!selectionMode && (
        <>
        <button
          ref={moreBtnRef}
          type="button"
          className="zhichi-session-list__more-btn"
        onClick={handleMoreClick}
        aria-label="更多操作"
      >
        <Icon name="more" size={16} />
      </button>
      {/* 下拉菜单 */}
      {menuOpen && (
        <div className="zhichi-session-menu" ref={menuRef}>
          <button
            type="button"
            className="zhichi-session-menu__item"
            onClick={handleTogglePin}
          >
            <Icon name="sparkles" size={14} />
            {session.isPinned ? "取消置顶" : "置顶"}
          </button>
          <button
            type="button"
            className="zhichi-session-menu__item"
            onClick={handleMarkRead}
            disabled={session.unreadCount === 0}
          >
            <Icon name="check" size={14} />
            标为已读
          </button>
          {onExportTranscript && (
            <button
              type="button"
              className="zhichi-session-menu__item"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                onExportTranscript();
              }}
            >
              <Icon name="download" size={14} />
              导出聊天记录
            </button>
          )}
          <button
            type="button"
            className="zhichi-session-menu__item zhichi-session-menu__item--danger"
            onClick={handleDelete}
          >
            <Icon name="close" size={14} />
            删除会话
          </button>
        </div>
      )}
        </>
      )}
    </div>
  );
});

SessionListItem.displayName = "SessionListItem";
