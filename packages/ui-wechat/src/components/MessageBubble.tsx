/**
 * @file MessageBubble.tsx
 * 多态消息气泡。根据 IMessage.type 分发到不同子渲染器。
 *
 * 关键钩子：useTypewriterAnimation
 * - 当 runtime.revealDelays 存在时，按延迟逐字揭示 text
 * - 当 runtime.typoCorrectAtMs 存在时，到达时间点自动纠错
 * - 动画结束后将 runtime.revealed 标记为 true（通过 store action）
 *
 * 受控组件：revealDelays / typoCorrectAtMs / revealed 均来自 store。
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { FC, PointerEvent as ReactPointerEvent } from "react";
import { motion } from "framer-motion";
import type {
  ICharacterProfile,
  IImageMessage,
  IMessage,
  IMessageQuote,
  IRecallMessage,
  IStickerMessage,
  ISystemMessage,
  ITextMessage,
  IVoiceMessage,
} from "@wechat-rp/shared-types";
import { MessageGuard } from "@wechat-rp/shared-types";
import {
  buildQuotePreview,
  canRecall,
  getMessagePlainText,
} from "@wechat-rp/core";

import type { IMessageRuntime } from "../store/chatStore";
import { useRafTypewriter } from "../hooks/useRafTypewriter";
import { copyTextToClipboard } from "../utils/clipboard";
import { buildPlaceholderSticker } from "../utils/placeholderSticker";
import { useSessionStore } from "../store/sessionStore";
import { AvatarWithSprite } from "./AvatarWithSprite";
import { MessageStatusIndicator, type MessageStatus } from "./MessageStatus";

export interface IMessageBubbleProps {
  readonly runtime: IMessageRuntime;
  readonly avatarUrl: string;
  /** 完整角色档案（存在时用 AvatarWithSprite 替代原生 img）。 */
  readonly characterProfile?: ICharacterProfile;
  /** 当前情绪（用于选取立绘）。 */
  readonly currentEmotion?: string;
  /** 是否为当前用户发送（决定气泡靠右/靠左）。 */
  readonly isSelf?: boolean;
  /** 揭示完成回调（store 据此把 revealed 置 true）。 */
  readonly onRevealComplete?: (messageId: string) => void;
  /**
   * 是否允许"编辑后重发"。父组件只给**最后一条用户消息**传 true
   * （改中间某条会让它之后的对话失去前提）。
   */
  readonly canEdit?: boolean;
  /** 是否正处于编辑态（由父组件持有，便于同一时间只编辑一条）。 */
  readonly isEditing?: boolean;
  readonly onStartEdit?: () => void;
  readonly onSubmitEdit?: (text: string) => void;
  readonly onCancelEdit?: () => void;
  /**
   * 引用这条消息（微信式"引用回复"）。
   *
   * 父组件负责把引用放进输入栏，发送时随消息一起进入 Prompt，
   * 让角色知道"你刚才说的那句"具体是哪句。
   */
  readonly onQuote?: (quote: IMessageQuote) => void;
  /** 点击引用块跳到被引用的那条消息（同会话内）。 */
  readonly onJumpToQuote?: (messageId: string) => void;
  /** 删除这条消息（微信式"删除"，删掉后也会从 LLM 历史里消失）。 */
  readonly onDelete?: (messageId: string) => void;
  /**
   * 撤回这条消息（微信式"撤回"，两分钟内、只能撤回自己发的）。
   *
   * 父组件只在自己发的消息上传这个回调；是否在时限内由气泡自己判断，
   * 这样菜单里不会出现点了没反应的"撤回"。
   */
  readonly onRecall?: (messageId: string) => void;
}

/** 消息气泡入口组件。 */
export const MessageBubble: FC<IMessageBubbleProps> = memo(
  ({
    runtime,
    avatarUrl,
    characterProfile,
    currentEmotion = "neutral",
    isSelf = false,
    onRevealComplete,
    canEdit = false,
    isEditing = false,
    onStartEdit,
    onSubmitEdit,
    onCancelEdit,
    onQuote,
    onJumpToQuote,
    onDelete,
    onRecall,
  }) => {
    const message = runtime.message;
    const characterName = characterProfile?.displayName;
    /**
     * 操作菜单（复制 / 引用）。
     *
     * 之前是"右键或长按直接复制"，问题是用户想引用时没有任何入口，
     * 而且误触即写剪贴板、没有二次确认的机会。改成长按/右键弹菜单，
     * 与微信一致。
     */
    const [actionMenuOpen, setActionMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 可读文本；系统/撤回消息为 null，不提供复制与引用。 */
    const plainText = getMessagePlainText(message);

    useEffect(() => {
      return () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      };
    }, []);

    // 点击菜单外部关闭
    useEffect(() => {
      if (!actionMenuOpen) return;
      const handleOutside = (event: MouseEvent) => {
        if (actionsRef.current?.contains(event.target as Node)) return;
        setActionMenuOpen(false);
      };
      document.addEventListener("mousedown", handleOutside);
      return () => document.removeEventListener("mousedown", handleOutside);
    }, [actionMenuOpen]);

    const handleCopy = useCallback(async () => {
      if (plainText === null) return;
      const ok = await copyTextToClipboard(plainText);
      setActionMenuOpen(false);
      if (!ok) return;
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
    }, [plainText]);

    const handleQuote = useCallback(() => {
      if (!onQuote || plainText === null) return;
      onQuote({
        messageId: message.id,
        senderName: isSelf ? "我" : characterName ?? "对方",
        preview: buildQuotePreview(plainText),
      });
      setActionMenuOpen(false);
    }, [onQuote, plainText, message.id, isSelf, characterName]);

    /** 删除这条消息：菜单收起、消息随之消失（调用方负责落库）。 */
    const handleDelete = useCallback(() => {
      if (!onDelete) return;
      setActionMenuOpen(false);
      onDelete(message.id);
    }, [onDelete, message.id]);

    /** 撤回这条消息：正文当场换成"你撤回了一条消息"。 */
    const handleRecall = useCallback(() => {
      if (!onRecall) return;
      setActionMenuOpen(false);
      onRecall(message.id);
    }, [onRecall, message.id]);

    const handlePointerDown = useCallback(
      (event: ReactPointerEvent) => {
        // 编辑框、按钮上的长按交给它们自己处理
        const target = event.target as HTMLElement;
        if (target.closest("button, textarea, input")) return;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          setActionMenuOpen(true);
        }, 500);
      },
      [],
    );

    const clearLongPress = useCallback(() => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }, []);
    const updateCharacter = useSessionStore((s) => s.updateCharacter);
    /**
     * 固定立绘开关写在**角色档案**里，而不是每个气泡各存一份本地 state。
     *
     * 后者的问题：从两个气泡各点一次就会各渲染一个常驻立绘（屏幕级图层重复），
     * 而且刷新后状态丢失。放进档案后全应用只有一份状态，也能随角色卡带走。
     */
    const pinSpriteEnabled = characterProfile?.visualMetadata.spritePinned ?? false;
    const handleTogglePin = useCallback(
      (enabled: boolean) => {
        if (!characterProfile) return;
        updateCharacter(characterProfile.id, {
          visualMetadata: {
            ...characterProfile.visualMetadata,
            spritePinned: enabled,
          },
        });
      },
      [characterProfile, updateCharacter],
    );

    return (
      <motion.article
        className="wechat-msg"
        data-self={isSelf}
        data-msg-type={message.type}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onContextMenu={(event) => {
          if (plainText === null) return;
          event.preventDefault();
          clearLongPress();
          setActionMenuOpen(true);
        }}
        initial={isSelf ? { opacity: 0, y: 8, scale: 0.96 } : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={isSelf
          ? { duration: 0.2, ease: "easeOut" }
          : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
        }
      >
        {characterProfile && !isSelf ? (
          <AvatarWithSprite
            profile={characterProfile}
            currentEmotion={currentEmotion}
            pinSpriteEnabled={pinSpriteEnabled}
            onTogglePinSprite={handleTogglePin}
          />
        ) : isSelf ? (
          <div className="wechat-msg__avatar wechat-msg__avatar--self" aria-hidden>
            <span>我</span>
          </div>
        ) : (
          <img
            className="wechat-msg__avatar"
            src={avatarUrl}
            alt=""
            loading="lazy"
          />
        )}
        <div className="wechat-msg__body">
          {message.quote && (
            <QuoteBlock
              quote={message.quote}
              onJump={
                onJumpToQuote
                  ? () => onJumpToQuote(message.quote!.messageId)
                  : undefined
              }
            />
          )}
          {isEditing && MessageGuard.isText(message) ? (
            <EditBubbleBody
              initialText={message.text}
              onSubmit={(text) => onSubmitEdit?.(text)}
              onCancel={() => onCancelEdit?.()}
            />
          ) : (
            renderMessageBody(message, runtime, onRevealComplete)
          )}
          {/* 编辑入口：只出现在最后一条用户消息旁，避免误改历史 */}
          {canEdit && !isEditing && (
            <button
              type="button"
              className="wechat-msg__edit-btn"
              title="编辑后重发"
              aria-label="编辑这条消息"
              onClick={() => onStartEdit?.()}
            >
              ✎
            </button>
          )}
          {actionMenuOpen && (
            <div className="wechat-msg__actions" role="menu" ref={actionsRef}>
              {plainText !== null && (
                <button
                  type="button"
                  role="menuitem"
                  className="wechat-msg__action"
                  onClick={() => void handleCopy()}
                >
                  复制
                </button>
              )}
              {onQuote && plainText !== null && (
                <button
                  type="button"
                  role="menuitem"
                  className="wechat-msg__action"
                  onClick={handleQuote}
                >
                  引用
                </button>
              )}
              {/*
                撤回：只在"自己发的 + 两分钟内"出现。
                判断放在菜单渲染时（而不是组件渲染时）——菜单一打开就重渲一次，
                这样超过时限的那条消息不会还留着可点的陈旧入口。
              */}
              {onRecall && isSelf && canRecall(message) && (
                <button
                  type="button"
                  role="menuitem"
                  className="wechat-msg__action"
                  onClick={handleRecall}
                >
                  撤回
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  role="menuitem"
                  className="wechat-msg__action wechat-msg__action--danger"
                  onClick={handleDelete}
                >
                  删除
                </button>
              )}
            </div>
          )}
          {copied && (
            <span className="wechat-msg__copied" role="status">
              已复制
            </span>
          )}
        </div>
      </motion.article>
    );
  },
);

MessageBubble.displayName = "MessageBubble";

/** 多态分发函数。 */
function renderMessageBody(
  message: IMessage,
  runtime: IMessageRuntime,
  onRevealComplete?: (id: string) => void,
): React.ReactNode {
  if (MessageGuard.isText(message)) {
    return (
      <TextBubbleBody
        message={message}
        runtime={runtime}
        onRevealComplete={onRevealComplete}
      />
    );
  }
  if (MessageGuard.isImage(message)) {
    return <ImageBubbleBody message={message} />;
  }
  if (MessageGuard.isVoice(message)) {
    return <VoiceBubbleBody message={message} />;
  }
  if (MessageGuard.isSticker(message)) {
    return <StickerBubbleBody message={message} />;
  }
  if (MessageGuard.isSystem(message)) {
    return <SystemBubbleBody message={message} />;
  }
  if (MessageGuard.isRecall(message)) {
    return <RecallBubbleBody message={message} />;
  }
  // exhaustiveness
  const _exhaustive: never = message;
  return _exhaustive;
}

// ---------- 子渲染器 ----------

/**
 * 就地编辑气泡：把气泡换成输入框，回车发送、Esc 取消。
 * 受控于父组件的 isEditing，本组件只管自己的草稿文本。
 */
const EditBubbleBody: FC<{
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}> = ({ initialText, onSubmit, onCancel }) => {
  const [value, setValue] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 进入编辑态自动聚焦，并把光标放到末尾
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = useCallback(() => {
    const text = value.trim();
    if (text) onSubmit(text);
  }, [onSubmit, value]);

  return (
    <div className="wechat-msg-edit">
      <textarea
        ref={textareaRef}
        className="wechat-msg-edit__input"
        value={value}
        rows={2}
        aria-label="编辑消息"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="wechat-msg-edit__actions">
        <span className="wechat-msg-edit__hint">回车发送 · Esc 取消</span>
        <button type="button" className="wechat-msg-edit__btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="wechat-msg-edit__btn wechat-msg-edit__btn--primary"
          onClick={submit}
          disabled={!value.trim()}
        >
          重发
        </button>
      </div>
    </div>
  );
};

/**
 * 引用块：显示在气泡内容上方（微信式：发送者 + 摘要）。
 *
 * 可点击时跳到被引用的那条消息——长对话里想确认"他引的是哪句"，
 * 不用再往上翻半天。
 */
const QuoteBlock: FC<{
  quote: IMessageQuote;
  onJump?: () => void;
}> = ({ quote, onJump }) => {
  const body = (
    <>
      <span className="wechat-msg__quote-name">{quote.senderName}</span>
      <span className="wechat-msg__quote-text">{quote.preview}</span>
    </>
  );

  if (!onJump) {
    return (
      <div
        className="wechat-msg__quote"
        title={`${quote.senderName}：${quote.preview}`}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="wechat-msg__quote wechat-msg__quote--clickable"
      title={`跳到这条消息：${quote.senderName}：${quote.preview}`}
      aria-label={`跳到被引用的消息：${quote.preview}`}
      onClick={onJump}
    >
      {body}
    </button>
  );
};

QuoteBlock.displayName = "QuoteBlock";

const TextBubbleBody: FC<{
  message: ITextMessage;
  runtime: IMessageRuntime;
  onRevealComplete?: (id: string) => void;
}> = ({ message, runtime, onRevealComplete }) => {
  const { displayedText, isCorrected } = useRafTypewriter({
    fullText: message.text,
    revealDelays: runtime.revealDelays,
    typoCorrectAtMs: runtime.typoCorrectAtMs,
    onComplete: () => onRevealComplete?.(message.id),
  });

  // 错别字纠错：到达纠错时间点后，用正确文本替换错字版本
  const finalText =
    isCorrected && runtime.correctedText
      ? runtime.correctedText
      : displayedText;

  // 消息状态：pending 气泡 → loading，delivered → 默认
  const status: MessageStatus = runtime.pending ? "loading" : "delivered";

  return (
    <div className="wechat-msg-bubble wechat-msg-bubble--text">
      <span className="wechat-msg-bubble__text">{finalText}</span>
      {isCorrected && (
        <span className="wechat-msg-bubble__corrected-mark" aria-hidden>
          ✓
        </span>
      )}
      <MessageStatusIndicator status={status} />
    </div>
  );
};

const ImageBubbleBody: FC<{ message: IImageMessage }> = ({ message }) => (
  <div className="wechat-msg-bubble wechat-msg-bubble--image">
    <img
      src={message.thumbnailUrl ?? message.url}
      alt="图片消息"
      width={message.width}
      height={message.height}
      loading="lazy"
    />
  </div>
);

const VoiceBubbleBody: FC<{ message: IVoiceMessage }> = ({ message }) => (
  <div className="wechat-msg-bubble wechat-msg-bubble--voice">
    <span className="wechat-msg-bubble__voice-icon" aria-hidden>🎤</span>
    <span className="wechat-msg-bubble__voice-duration">
      {Math.round(message.durationSec)}″
    </span>
  </div>
);

const StickerBubbleBody: FC<{ message: IStickerMessage }> = ({ message }) => (
  <div className="wechat-msg-bubble wechat-msg-bubble--sticker">
    {/*
      贴图用内置 SVG 现画：外链失效就是满屏破图，而简笔表情足够用。
      fallbackText 保留在 alt/title 里，读屏与鼠标悬停都能看到表情名。
    */}
    <img
      className="wechat-msg-bubble__sticker"
      src={buildPlaceholderSticker(message.stickerId)}
      alt={message.fallbackText}
      title={message.fallbackText}
      width={96}
      height={96}
      loading="lazy"
    />
  </div>
);

const SystemBubbleBody: FC<{ message: ISystemMessage }> = ({ message }) => (
  <div className="wechat-msg-bubble wechat-msg-bubble--system">
    <span>{message.displayText}</span>
  </div>
);

const RecallBubbleBody: FC<{ message: IRecallMessage }> = ({ message }) => (
  <div className="wechat-msg-bubble wechat-msg-bubble--recall">
    <span>{message.notice}</span>
  </div>
);
