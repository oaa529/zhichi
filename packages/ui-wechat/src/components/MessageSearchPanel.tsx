/**
 * @file MessageSearchPanel.tsx
 * 左侧「聊天」页的搜索框 + 跨会话消息搜索结果。
 *
 * 交互：
 * - 输入关键词 → 结果替换会话列表（由 WeChatShell 决定显隐）
 * - 点击结果 → 切到该会话并高亮那条消息
 * - 结果按时间倒序，最多展示 60 条，超出时提示"还有 N 条"
 *
 * 纯展示组件：数据从 useSessionStore 读取，检索交给 utils/messageSearch。
 */

import { memo, useMemo } from "react";
import type { FC } from "react";
import { useSessionStore } from "../store/sessionStore";
import { searchMessages } from "../utils/messageSearch";
import { formatSessionTime } from "../utils/sessionTime";
import { Icon } from "./Icon";

export interface IMessageSearchPanelProps {
  /** 当前关键词（受控）。 */
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  /** 点击某条结果：切到该会话并定位到这条消息。 */
  readonly onJumpToMessage?: (sessionId: string, messageId: string) => void;
}

/**
 * 渲染片段：把所有命中区间包成 <mark>。
 *
 * 多词查询会有好几处命中，所以按区间逐段拼——
 * 之前只能高亮一处（整串查询当一个词）。
 */
function renderSnippet(
  snippet: string,
  matches: ReadonlyArray<{ readonly index: number; readonly length: number }>,
): React.ReactNode {
  if (matches.length === 0) return snippet;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((span, index) => {
    if (span.index > cursor) parts.push(snippet.slice(cursor, span.index));
    parts.push(
      <mark key={index} className="zhichi-message-search__mark">
        {snippet.slice(span.index, span.index + span.length)}
      </mark>,
    );
    cursor = span.index + span.length;
  });
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return <>{parts}</>;
}

export const MessageSearchPanel: FC<IMessageSearchPanelProps> = memo(
  ({ query, onQueryChange, onJumpToMessage }) => {
    const sessions = useSessionStore((s) => s.sessions);
    const sessionRuntimes = useSessionStore((s) => s.sessionRuntimes);

    const keyword = query.trim();
    const result = useMemo(
      () => searchMessages(query, sessions, sessionRuntimes),
      [query, sessions, sessionRuntimes],
    );

    return (
      <div className="zhichi-message-search">
        <div className="zhichi-message-search__box">
          <Icon name="search" size={14} />
          <input
            type="search"
            className="zhichi-message-search__input"
            value={query}
            placeholder="搜索聊天记录"
            aria-label="搜索聊天记录"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onQueryChange("");
            }}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="zhichi-message-search__clear"
              aria-label="清空搜索"
              onClick={() => onQueryChange("")}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        {keyword.length > 0 && (
          <div className="zhichi-message-search__results" role="list">
            {result.total === 0 ? (
              <p className="zhichi-message-search__empty">
                没有找到包含「{keyword}」的消息
              </p>
            ) : (
              <>
                {result.hits.map((hit) => (
                  <button
                    key={hit.messageId}
                    type="button"
                    role="listitem"
                    className="zhichi-message-search__hit"
                    onClick={() =>
                      onJumpToMessage?.(hit.sessionId, hit.messageId)
                    }
                  >
                    <span className="zhichi-message-search__hit-head">
                      <span className="zhichi-message-search__hit-name">
                        {hit.sessionName || "已删除的会话"}
                      </span>
                      <span className="zhichi-message-search__hit-time">
                        {formatSessionTime(hit.timestamp)}
                      </span>
                    </span>
                    <span className="zhichi-message-search__hit-text">
                      {hit.senderId === "user" && (
                        <span className="zhichi-message-search__hit-self">我</span>
                      )}
                      {renderSnippet(hit.snippet, hit.matches)}
                    </span>
                  </button>
                ))}
                {result.total > result.hits.length && (
                  <p className="zhichi-message-search__more">
                    还有 {result.total - result.hits.length} 条 —— 试试更具体的词
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);

MessageSearchPanel.displayName = "MessageSearchPanel";
