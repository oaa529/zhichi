/**
 * @file ContextUsageBadge.tsx
 * 标题栏右侧的「上下文占用」指示器。
 *
 * 点一下展开明细：本次请求发出去多少 token、各部分占多少字、
 * 历史有没有被裁剪。之前这些都是黑盒——用户既不知道记忆注入没有，
 * 也不知道长会话已经在丢历史。
 *
 * 自己从 store 取数（按会话），因此不依赖上层透传。
 */

import { memo, useCallback, useState } from "react";
import type { FC } from "react";
import { useSessionStore } from "../store/sessionStore";
import {
  buildUsageRows,
  formatTokenCount,
  isContextTight,
} from "../utils/contextUsage";

export interface IContextUsageBadgeProps {
  /** 要展示哪个会话的占用（为空则不渲染）。 */
  readonly sessionId?: string;
}

export const ContextUsageBadge: FC<IContextUsageBadgeProps> = memo(
  ({ sessionId }) => {
    const usage = useSessionStore((s) =>
      sessionId ? s.contextUsageBySession[sessionId] : undefined,
    );
    const total = useSessionStore((s) =>
      sessionId ? s.tokenUsageBySession[sessionId] : undefined,
    );
    const [open, setOpen] = useState(false);
    const toggle = useCallback(() => setOpen((value) => !value), []);

    if (!usage) return null;

    const tight = isContextTight(usage);
    return (
      <div className="zhichi-context-usage">
        <button
          type="button"
          className="zhichi-context-usage__btn"
          data-tight={tight}
          aria-expanded={open}
          aria-label="查看上下文占用"
          title={tight ? "历史已触发裁剪，点开看明细" : "本次请求的上下文占用"}
          onClick={toggle}
        >
          {formatTokenCount(usage.estimatedTokens)} tok
        </button>

        {open && (
          <div
            className="zhichi-context-usage__panel"
            role="dialog"
            aria-label="上下文占用明细"
          >
            <p className="zhichi-context-usage__title">
              本次请求 {usage.messageCount} 条消息 · 约 {usage.estimatedTokens} token
            </p>
            <ul className="zhichi-context-usage__list">
              {buildUsageRows(usage).map((row) => (
                <li key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.chars} 字</span>
                </li>
              ))}
            </ul>
            {usage.trimmed && (
              <p className="zhichi-context-usage__warn">
                历史太长已裁剪：丢掉 {usage.removedChars} 字
                {usage.summarized ? "，并压缩成前情提要" : ""}
              </p>
            )}
            {total && (
              <p className="zhichi-context-usage__total">
                本会话累计约 {formatTokenCount(total.tokens)} tok
                （{total.requests} 次请求）
              </p>
            )}
            <p className="zhichi-context-usage__hint">
              token 为估算值（中文约 1.3 token/字），用于判断钱花在哪。
            </p>
          </div>
        )}
      </div>
    );
  },
);

ContextUsageBadge.displayName = "ContextUsageBadge";
