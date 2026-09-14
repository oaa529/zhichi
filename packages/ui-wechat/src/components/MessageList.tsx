/**
 * @file MessageList.tsx
 * 消息列表（原生滚动 + content-visibility 轻量虚拟化）。
 *
 * 这里刻意不引入第三方虚拟滚动库：本项目是"流式逐条追加 + 高度不固定气泡"
 * 的场景，虚拟滚动库的滚动模型与之不兼容——实测表现为新气泡到达时列表
 * 不跟随滚动（需手动点"新消息"回到底部），且外部主动滚动会被其内部
 * 高度估算逻辑撤销。
 *
 * - 普通 DOM 列表 + 原生滚动，滚动行为完全可控
 * - 每条消息用 CSS `content-visibility: auto` 跳过屏外渲染，
 *   保留大消息量下的渲染性能
 * - 滚动容器通过 `scrollerRef` 暴露给父组件，由父组件统一决定何时贴底
 */

import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { FC } from "react";

import type { ICharacterProfile, IMessageQuote } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import {
  formatDividerTime,
  shouldShowTimeDivider,
} from "../utils/timeDivider";
import { MessageBubble } from "./MessageBubble";
import type { IMessageBubbleProps } from "./MessageBubble";
import { TypingIndicatorBubble } from "./TypingIndicatorBubble";
import { findLastEditableUserMessage } from "../utils/regenerate";

export interface IMessageListProps {
  /** 会话标识。变化时重建列表 DOM（切换会话）。 */
  readonly sessionKey?: string;
  /** 排序后的消息运行时数组。 */
  readonly messages: ReadonlyArray<IMessageRuntime>;
  /** 角色头像 URL。 */
  readonly characterAvatarUrl: string;
  /** 完整角色档案（用于 AvatarWithSprite 立绘弹出）。 */
  readonly characterProfile?: ICharacterProfile;
  /** 是否显示"对方正在输入..."占位气泡。 */
  readonly typingActive: boolean;
  /** 自定义消息渲染器（可选）。 */
  readonly renderMessage?: (runtime: IMessageRuntime) => React.ReactNode;
  /** 滚动容器引用（父组件据此控制贴底与未读判定）。 */
  readonly scrollerRef?: (el: HTMLElement | null) => void;
  /** 需要高亮闪烁的消息 ID（从搜索结果跳转过来时用）。 */
  readonly highlightMessageId?: string | null;
  /** 提交"编辑后重发"（父组件负责撤回这条消息及其后的回复再重发）。 */
  readonly onEditSubmit?: (messageId: string, text: string) => void;
  /** 引用某条消息（父组件把引用放进输入栏）。 */
  readonly onQuote?: (quote: IMessageQuote) => void;
  /** 点击引用块跳到被引用的那条消息。 */
  readonly onJumpToQuote?: (messageId: string) => void;
  /** 删除单条消息。 */
  readonly onDeleteMessage?: (messageId: string) => void;
  /** 撤回单条消息（仅自己发的、两分钟内的消息会显示入口）。 */
  readonly onRecallMessage?: (messageId: string) => void;
  /**
   * "以下为新消息"分隔线的位置（第一条未读消息的 ID）。
   * 没有未读时传 null，不画那条线。
   */
  readonly unreadMarkerMessageId?: string | null;
}

const MessageListInner: FC<IMessageListProps> = ({
  sessionKey,
  messages,
  characterAvatarUrl,
  characterProfile,
  typingActive,
  renderMessage,
  scrollerRef,
  highlightMessageId,
  onEditSubmit,
  onQuote,
  onJumpToQuote,
  onDeleteMessage,
  onRecallMessage,
  unreadMarkerMessageId,
}) => {
  /** 正在编辑的消息 ID（同一时间只允许编辑一条）。 */
  const [editingId, setEditingId] = useState<string | null>(null);

  // 切换会话时退出编辑态，避免把编辑框带到另一个会话
  useEffect(() => {
    setEditingId(null);
  }, [sessionKey]);

  /** 只有最后一条用户消息可编辑。 */
  const editableId = useMemo(
    () => findLastEditableUserMessage(messages)?.messageId ?? null,
    [messages],
  );

  const attachScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef?.(el);
    },
    [scrollerRef],
  );

  const itemContent = useCallback(
    (runtime: IMessageRuntime) => {
      if (renderMessage) return renderMessage(runtime);

      const isSelf = runtime.message.senderId === "user";
      const props: IMessageBubbleProps = {
        runtime,
        avatarUrl: isSelf ? "" : characterAvatarUrl,
        characterProfile: isSelf ? undefined : characterProfile,
        currentEmotion: runtime.message.emotion ?? "neutral",
        isSelf,
        canEdit: onEditSubmit !== undefined && runtime.message.id === editableId,
        isEditing: runtime.message.id === editingId,
        onStartEdit: () => setEditingId(runtime.message.id),
        onSubmitEdit: (text) => {
          setEditingId(null);
          onEditSubmit?.(runtime.message.id, text);
        },
        onCancelEdit: () => setEditingId(null),
        onQuote,
        onJumpToQuote,
        onDelete: onDeleteMessage,
        onRecall: onRecallMessage,
      };
      return <MessageBubble {...props} />;
    },
    [
      renderMessage,
      characterAvatarUrl,
      characterProfile,
      editableId,
      editingId,
      onEditSubmit,
      onQuote,
      onJumpToQuote,
      onDeleteMessage,
      onRecallMessage,
    ],
  );

  return (
    <div
      key={sessionKey}
      ref={attachScroller}
      className="wechat-chat-session__scroller"
      data-testid="message-scroller"
    >
      <div>
        {messages.map((runtime, index) => {
          const prev = messages[index - 1];
          const showDivider = shouldShowTimeDivider(
            prev ? prev.message.timestamp : null,
            runtime.message.timestamp,
          );
          return (
            <Fragment key={runtime.message.id}>
              {showDivider && (
                <div className="wechat-time-divider">
                  {formatDividerTime(runtime.message.timestamp)}
                </div>
              )}
              {/* 微信里那条红字分隔线：从这里开始是离开期间的新消息 */}
              {unreadMarkerMessageId === runtime.message.id && (
                <div className="wechat-unread-divider" role="separator">
                  以下为新消息
                </div>
              )}
              <div
                className={`wechat-msg-row${
                  highlightMessageId === runtime.message.id
                    ? " wechat-msg-row--highlight"
                    : ""
                }`}
                data-message-id={runtime.message.id}
              >
                {itemContent(runtime)}
              </div>
            </Fragment>
          );
        })}
        {typingActive && (
          <TypingIndicatorBubble avatarUrl={characterAvatarUrl} />
        )}
      </div>
    </div>
  );
};

export const MessageList: FC<IMessageListProps> = memo(MessageListInner);

MessageList.displayName = "MessageList";
