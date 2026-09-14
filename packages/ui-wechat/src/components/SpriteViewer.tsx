/**
 * @file SpriteViewer.tsx
 * 立绘详情查看器（点击头像弹出的全屏/半屏 modal）。
 *
 * 功能：
 * - 大图显示当前角色立绘（切换情绪时交叉淡入，不是硬切）
 * - 缩略图条：一眼看到有哪些情绪，可直接跳过去
 * - 左右切换 + 键盘操作（← → 切换，Esc 关闭）
 * - "固定立绘"开关：开启后立绘常驻聊天页
 * - 关闭按钮
 */

import { memo, useEffect, useState } from "react";
import type { FC } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type {
  ICharacterProfile,
  ICharacterSprite,
} from "@wechat-rp/shared-types";
import { emotionLabel } from "../utils/emotionLabel";

export interface ISpriteViewerProps {
  readonly profile: ICharacterProfile;
  /** 初始展示的立绘。 */
  readonly initialSprite: ICharacterSprite;
  /** 关闭回调。 */
  readonly onClose: () => void;
  /** 切换固定立绘开关。 */
  readonly onTogglePin: (enabled: boolean) => void;
  /** 当前是否已固定。 */
  readonly pinSpriteEnabled: boolean;
}

export const SpriteViewer: FC<ISpriteViewerProps> = memo(
  ({ profile, initialSprite, onClose, onTogglePin, pinSpriteEnabled }) => {
    const sprites = profile.visualMetadata.sprites;
    const initialIdx = sprites.findIndex((s) => s.url === initialSprite.url);
    const [currentIdx, setCurrentIdx] = useState(
      initialIdx >= 0 ? initialIdx : 0,
    );

    const current = sprites[currentIdx] ?? initialSprite;
    const canPrev = currentIdx > 0;
    const canNext = currentIdx < sprites.length - 1;

    /** 键盘操作：左右切换情绪、Esc 关闭（看图时手不用来回移鼠标）。 */
    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "ArrowLeft") {
          setCurrentIdx((index) => Math.max(0, index - 1));
        } else if (event.key === "ArrowRight") {
          setCurrentIdx((index) => Math.min(sprites.length - 1, index + 1));
        } else if (event.key === "Escape") {
          onClose();
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [sprites.length, onClose]);

    /**
     * 用 portal 挂到 document.body 上。
     *
     * 这个弹层的调用方是消息气泡里的头像，而气泡外层是 framer-motion 的
     * `motion.article`——它带 transform，会让内部元素的 `position: fixed`
     * 退化成"相对该气泡定位"（实测弹层被压成 872×58、图被顶到屏幕外）。
     * 挂到 body 上就与任何祖先的 transform 无关了。
     */
    const overlay = (
      <AnimatePresence>
        <motion.div
          className="wechat-sprite-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={`${profile.displayName} 立绘详情`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="wechat-sprite-viewer__backdrop" onClick={onClose} />

          <motion.figure
            className="wechat-sprite-viewer__figure"
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
          >
            {/*
              双层交叉淡入：切换情绪时旧图淡出、新图叠上去淡入。
              此前是直接换 src，一张立绘"啪"地变成另一张。
            */}
            <div className="wechat-sprite-viewer__stage">
              <AnimatePresence initial={false}>
                <motion.img
                  key={current.url}
                  src={current.url}
                  alt={emotionLabel(current.emotion)}
                  draggable={false}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                />
              </AnimatePresence>
            </div>

            <figcaption className="wechat-sprite-viewer__caption">
              <span>{profile.displayName}</span>
              <span className="wechat-sprite-viewer__emotion">
                {emotionLabel(current.emotion)}
              </span>
            </figcaption>
          </motion.figure>

          {/* 缩略图条：情绪多的时候不用一路按 ◀▶ */}
          {sprites.length > 1 && (
            <div className="wechat-sprite-viewer__thumbs" role="tablist">
              {sprites.map((sprite, index) => (
                <button
                  key={sprite.url}
                  type="button"
                  role="tab"
                  aria-selected={index === currentIdx}
                  className={`wechat-sprite-viewer__thumb${index === currentIdx ? " wechat-sprite-viewer__thumb--active" : ""}`}
                  title={emotionLabel(sprite.emotion)}
                  aria-label={emotionLabel(sprite.emotion)}
                  onClick={() => setCurrentIdx(index)}
                >
                  <img
                    src={sprite.thumbnailUrl ?? sprite.url}
                    alt=""
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          )}

          <nav className="wechat-sprite-viewer__nav">
            <button
              type="button"
              disabled={!canPrev}
              onClick={() => canPrev && setCurrentIdx((i) => i - 1)}
            >
              ◀
            </button>
            <label className="wechat-sprite-viewer__pin-toggle">
              <input
                type="checkbox"
                checked={pinSpriteEnabled}
                onChange={(e) => onTogglePin(e.target.checked)}
              />
              <span>固定立绘</span>
            </label>
            <button
              type="button"
              disabled={!canNext}
              onClick={() => canNext && setCurrentIdx((i) => i + 1)}
            >
              ▶
            </button>
          </nav>

          <button
            type="button"
            className="wechat-sprite-viewer__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </motion.div>
      </AnimatePresence>
    );

    return createPortal(overlay, document.body);
  },
);

SpriteViewer.displayName = "SpriteViewer";
