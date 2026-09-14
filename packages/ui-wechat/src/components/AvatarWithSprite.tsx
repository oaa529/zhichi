/**
 * @file AvatarWithSprite.tsx
 * 头像组件 + 立绘弹出逻辑。
 *
 * 交互：
 * - 点击头像：弹出 SpriteViewer 立绘详情面板
 * - 长按头像（或设置中开启"固定立绘"）：立绘常驻，可拖动
 * - 固定立绘模式下，立绘图层级 z-index 高于文字，需遮罩处理
 *
 * 受控组件：
 * - pinSpriteEnabled / spriteViewerOpen 均来自外部 store
 * - 点击/长按回调由父级注入
 */

import { memo, useState } from "react";
import type { FC } from "react";
import type {
  ICharacterProfile,
  ICharacterSprite,
} from "@wechat-rp/shared-types";

import { SpriteViewer } from "./SpriteViewer";

export interface IAvatarWithSpriteProps {
  readonly profile: ICharacterProfile;
  /** 头像尺寸（px）。 */
  readonly size?: number;
  /** 是否已开启"固定立绘"模式。 */
  readonly pinSpriteEnabled: boolean;
  /** 当前情绪（用于选取立绘）。 */
  readonly currentEmotion: string;
  /** 头像点击回调。 */
  readonly onClick?: () => void;
  /** 头像长按回调（开启固定立绘）。 */
  readonly onLongPress?: () => void;
  /** 切换固定立绘开关。 */
  readonly onTogglePinSprite?: (enabled: boolean) => void;
}

export const AvatarWithSprite: FC<IAvatarWithSpriteProps> = memo(
  ({
    profile,
    size = 40,
    pinSpriteEnabled,
    currentEmotion,
    onClick,
    onLongPress,
    onTogglePinSprite,
  }) => {
    const [viewerOpen, setViewerOpen] = useState(false);
    const [pressTimer, setPressTimer] =
      useState<ReturnType<typeof setTimeout> | null>(null);
    const handlePointerDown = () => {
      const t = setTimeout(() => {
        onLongPress?.();
        onTogglePinSprite?.(!pinSpriteEnabled);
      }, 600);
      setPressTimer(t);
    };

    const handlePointerUp = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        setPressTimer(null);
      }
    };

    const handleClick = () => {
      onClick?.();
      if (!pinSpriteEnabled) {
        setViewerOpen(true);
      }
    };

    const activeSprite = pickSpriteForEmotion(
      profile.visualMetadata.sprites,
      currentEmotion,
    );

    return (
      <div className="wechat-avatar" style={{ width: size, height: size }}>
        <button
          type="button"
          className="wechat-avatar__btn"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          aria-label={`查看 ${profile.displayName} 的立绘`}
        >
          <img
            className="wechat-avatar__img"
            src={profile.visualMetadata.avatarUrl}
            alt={profile.displayName}
            loading="lazy"
          />
        </button>

        {/*
          注意：固定立绘的常驻层**不在这里渲染**。
          它是屏幕级图层，挂在消息气泡上的话每个角色消息都会渲染一份；
          改由 ChatSessionView 统一渲染一次（见 PinnedSprite）。
          这里只负责"点头像/长按 → 改角色档案里的开关"。
        */}

        {/* 立绘详情弹层 */}
        {viewerOpen && activeSprite && (
          <SpriteViewer
            profile={profile}
            initialSprite={activeSprite}
            onClose={() => setViewerOpen(false)}
            onTogglePin={(enabled) => {
              onTogglePinSprite?.(enabled);
              if (enabled) setViewerOpen(false);
            }}
            pinSpriteEnabled={pinSpriteEnabled}
          />
        )}
      </div>
    );
  },
);

AvatarWithSprite.displayName = "AvatarWithSprite";

/** 根据情绪选取立绘，找不到时回退 neutral。 */
function pickSpriteForEmotion(
  sprites: ReadonlyArray<ICharacterSprite>,
  emotion: string,
): ICharacterSprite | null {
  if (sprites.length === 0) return null;
  const exact = sprites.find((s) => s.emotion === emotion);
  if (exact) return exact;
  const neutral = sprites.find((s) => s.emotion === "neutral");
  return neutral ?? sprites[0] ?? null;
}
