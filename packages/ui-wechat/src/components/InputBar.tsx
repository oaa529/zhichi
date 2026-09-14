/**
 * @file InputBar.tsx
 * 底部输入栏。受控组件。
 *
 * 职责：
 * - 文本输入框 + 发送按钮
 * - 提示词模板入口（打开提示词面板）
 * - 发送时清空输入并调用 onSubmit
 */

import { memo, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import type { IMessageQuote } from "@wechat-rp/shared-types";
import { BASIC_STICKERS, STICKER_PACK_ID } from "@wechat-rp/core";
import { useViewportResize } from "../hooks/useViewportResize";
import { buildPlaceholderSticker } from "../utils/placeholderSticker";
import { Icon } from "./Icon";

export interface IInputBarProps {
  /** 当前输入文本（受控）。 */
  readonly value: string;
  /** 文本变化回调。 */
  readonly onChange: (value: string) => void;
  /** 发送回调。父级负责调用 engine.startStream。 */
  readonly onSubmit: (text: string) => void;
  /**
   * 是否处于"对方正在回复"状态。
   *
   * 注意：该状态下输入框**仍可输入与发送**（微信式体验）——
   * 消息会先上屏，由父级排队，等当前回复结束后自动发出。
   * 只有"推进剧情"这类会直接驱动引擎的操作才被禁用。
   */
  readonly disabled: boolean;
  /** 提示词面板入口回调。 */
  readonly onOpenPrompts?: () => void;
  /** 推进剧情回调（AI 基于状态卡主动推进一步）。 */
  readonly onAdvancePlot?: () => void;
  /** 占位符文本。 */
  readonly placeholder?: string;
  /** 当前正在引用的消息（显示在输入框上方，发送后由父级清空）。 */
  readonly quote?: IMessageQuote;
  /** 取消引用。 */
  readonly onCancelQuote?: () => void;
  /** 选了一张贴图要发出去（表情面板）。 */
  readonly onSendSticker?: (sticker: {
    readonly stickerPackId: string;
    readonly stickerId: string;
    readonly fallbackText: string;
  }) => void;
}

export const InputBar: FC<IInputBarProps> = memo(
  ({
    value,
    onChange,
    onSubmit,
    disabled,
    onOpenPrompts,
    onAdvancePlot,
    placeholder = "输入消息...",
    quote,
    onCancelQuote,
    onSendSticker,
  }) => {
    const [composing, setComposing] = useState(false);
    const { keyboardHeight, isMobile } = useViewportResize();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    /** 表情面板是否展开。 */
    const [pickerOpen, setPickerOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    // 点面板外面收起（与其他浮层一致）
    useEffect(() => {
      if (!pickerOpen) return;
      const handleOutside = (event: MouseEvent): void => {
        if (pickerRef.current?.contains(event.target as Node)) return;
        setPickerOpen(false);
      };
      document.addEventListener("mousedown", handleOutside);
      return () => document.removeEventListener("mousedown", handleOutside);
    }, [pickerOpen]);

    // 输入框随内容自动增高（单行 → 最多约 5 行，超过后内部滚动）。
    // 未做这一步时，长消息只能看到一行，用户无法回看自己写的内容。
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      // 100 = CSS 中的 max-height，二者保持一致
      el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
    }, [value]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !composing) {
        e.preventDefault();
        // 流式期间同样允许发送（父级会排队），因此不检查 disabled
        if (value.trim()) {
          onSubmit(value.trim());
        }
      }
    };

    // 流式期间也允许发送（父级会排队），因此只看内容是否为空
    const canSend = value.trim().length > 0;

    return (
      <footer
        className="zhichi-input-bar"
        style={isMobile && keyboardHeight > 0 ? { paddingBottom: `${keyboardHeight}px` } : undefined}
        data-keyboard-open={isMobile && keyboardHeight > 0}
      >
        {onSendSticker && pickerOpen && (
          <div
            className="zhichi-sticker-picker"
            role="dialog"
            aria-label="选择表情"
            ref={pickerRef}
          >
            {BASIC_STICKERS.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                className="zhichi-sticker-picker__item"
                title={sticker.fallbackText}
                aria-label={sticker.fallbackText}
                onClick={() => {
                  setPickerOpen(false);
                  onSendSticker({
                    stickerPackId: STICKER_PACK_ID,
                    stickerId: sticker.id,
                    fallbackText: sticker.fallbackText,
                  });
                }}
              >
                <img
                  src={buildPlaceholderSticker(sticker.id)}
                  alt=""
                  draggable={false}
                />
              </button>
            ))}
          </div>
        )}
        {quote && (
          <div className="zhichi-input-bar__quote">
            <span className="zhichi-input-bar__quote-bar" aria-hidden />
            <div className="zhichi-input-bar__quote-body">
              <span className="zhichi-input-bar__quote-name">
                {quote.senderName}
              </span>
              <span className="zhichi-input-bar__quote-text">
                {quote.preview}
              </span>
            </div>
            <button
              type="button"
              className="zhichi-input-bar__quote-cancel"
              aria-label="取消引用"
              title="取消引用"
              onClick={onCancelQuote}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <div className="zhichi-input-bar__row">
        <button
          type="button"
          className="zhichi-input-bar__icon-btn"
          aria-label="提示词"
          onClick={onOpenPrompts}
          title="提示词模板"
        >
          <Icon name="prompt" size={22} />
        </button>
        {onAdvancePlot && (
          <button
            type="button"
            className="zhichi-input-bar__icon-btn"
            aria-label="推进剧情"
            onClick={onAdvancePlot}
            disabled={disabled}
            title="推进剧情"
          >
            <Icon name="plot" size={22} />
          </button>
        )}
        {onSendSticker && (
          <button
            type="button"
            className="zhichi-input-bar__icon-btn"
            aria-label="表情"
            title="发个表情"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            disabled={disabled}
          >
            <Icon name="smile" size={22} />
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="zhichi-input-bar__textarea"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          rows={1}
        />
        {canSend ? (
          <button
            type="button"
            className="zhichi-input-bar__send"
            onClick={() => onSubmit(value.trim())}
            aria-label="发送"
          >
            <Icon name="send" size={18} />
          </button>
        ) : (
          <span className="zhichi-input-bar__send zhichi-input-bar__send--idle">
            <Icon name="send" size={18} />
          </span>
        )}
        </div>
      </footer>
    );
  },
);

InputBar.displayName = "InputBar";
