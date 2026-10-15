/**
 * @file InputBar.tsx
 * 底部输入栏。受控组件。
 *
 * 职责：
 * - 文本输入框 + 发送按钮
 * - 顶部把手：手动拉高/压低输入框（方向键同样可调）
 * - 提示词模板入口（打开提示词面板）
 * - 发送时清空输入并调用 onSubmit
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import type { IMessageQuote } from "@wechat-rp/shared-types";
import { BASIC_STICKERS, STICKER_PACK_ID } from "@wechat-rp/core";
import { useViewportResize } from "../hooks/useViewportResize";
import { buildPlaceholderSticker } from "../utils/placeholderSticker";
import { Icon } from "./Icon";

/**
 * 自动增高的上限，与 CSS 里的 `max-height` 保持一致。
 *
 * 超过这个高度就内部滚动，而不是把消息区挤没——输入框顶多占约 5 行，
 * 再多就该用把手手动拉高了。
 */
const AUTO_MAX_HEIGHT = 100;
/** 把手能压到的下限；再矮就等于交给自动增高。 */
const MIN_MANUAL_HEIGHT = 37;
/** 拉高超过这个高度就把输入框圆角从胶囊切成圆角矩形（贴着 1 行的高度判定）。 */
const TALL_THRESHOLD = 44;
/** 方向键步长 / Shift+方向键步长。 */
const KEY_STEP = 24;
const KEY_STEP_LARGE = 72;

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
    /**
     * 用户手动拉的输入框高度；null = 交给自动增高。
     *
     * 拖回下限以下会置回 null（"还给你"），这样长文本仍然自动长高，
     * 而用户主动拉高过的高度会一直留着——发完消息不会缩回去，
     * 想收回再往下拖就行（微信桌面版就是这个手感）。
     */
    const [manualHeight, setManualHeight] = useState<number | null>(null);
    /** 拖拽过程标记：把手高亮 + 光标保持 row-resize。 */
    const [resizing, setResizing] = useState(false);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    /** 拉高上限：跟着窗口走，最多占 55% 高度，免得把消息区完全挤掉。 */
    const maxHeight = Math.max(220, Math.round(window.innerHeight * 0.55));

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

    // 输入框随内容自动增高（单行 → 最多约 5 行，超过后内部滚动），
    // 除非用户用把手手动拉高过——那时以手动高度为准。
    // 未做自动增高时，长消息只能看到一行，用户无法回看自己写的内容。
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      const auto = Math.min(el.scrollHeight, AUTO_MAX_HEIGHT);
      const height = manualHeight ?? auto;
      el.style.height = `${height}px`;
      el.dataset.tall = String(height > TALL_THRESHOLD);
      // 手动拉高时解除 CSS 的自动增高上限，否则 inline 高度会被 max-height 压回去，
      // 表现为"怎么拉都卡在 100px"。
      el.dataset.manual = String(manualHeight !== null);
    }, [value, manualHeight]);

    /** 当前实际高度：手动值优先，其次量 DOM。 */
    const readHeight = useCallback(() => {
      const h = textareaRef.current?.offsetHeight ?? 0;
      // 0 表示"这会儿量不到高度"（首帧、或测试环境无布局），按下限兜底，
      // 不能让它把后面的加法带成负数。
      return h > 0 ? h : MIN_MANUAL_HEIGHT;
    }, []);

    /** 步进/拖拽的基准高度：先看手动值，没有再量 DOM。 */
    const baseHeight = useCallback(
      () => manualHeight ?? readHeight(),
      [manualHeight, readHeight],
    );

    /**
     * 把候选高度落成状态：夹在下限与上限之间，压到下限以下就交回自动增高。
     */
    const applyHeight = useCallback(
      (candidate: number) => {
        if (candidate < MIN_MANUAL_HEIGHT) {
          setManualHeight(null);
          return;
        }
        setManualHeight(Math.round(Math.min(candidate, maxHeight)));
      },
      [maxHeight],
    );

    const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
      // 只忽略右键/中键；别用 `!== 0`——那会把"没有 button 的事件"也误判掉
      if (e.button > 0) return;
      dragRef.current = { startY: e.clientY, startHeight: baseHeight() };
      setResizing(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (!drag) return;
      // 往上拖（clientY 变小）= 变高
      applyHeight(drag.startHeight + (drag.startY - e.clientY));
    };

    const handleResizeEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setResizing(false);
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    /** 键盘调节：拖不动也能用（separator 可聚焦，方向键调高度）。 */
    const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        applyHeight(baseHeight() + step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        applyHeight(baseHeight() - step);
      } else if (e.key === "Home") {
        // Home：还回自动增高
        e.preventDefault();
        setManualHeight(null);
      }
    };

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
        <div
          className="zhichi-input-bar__resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整输入框高度"
          aria-valuenow={manualHeight ?? readHeight()}
          aria-valuemin={MIN_MANUAL_HEIGHT}
          aria-valuemax={maxHeight}
          tabIndex={0}
          data-resizing={resizing}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onKeyDown={handleResizeKeyDown}
          title="拖动调整输入框高度（方向键也可以）"
        />
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
