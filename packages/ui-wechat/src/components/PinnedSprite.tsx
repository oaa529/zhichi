/**
 * @file PinnedSprite.tsx
 * 「固定立绘」常驻层：全屏只渲染一份，可拖动。
 *
 * 为什么独立成组件、而不是塞在消息气泡里：
 * 固定立绘是**屏幕级图层**。挂在气泡上的话，每个角色消息都会渲染一份
 * （实测点一次固定后页面上出现 2 个立绘），而且气泡还被 framer-motion
 * 的 transform 包着，`position: fixed` 会退化成相对气泡定位。
 *
 * 所以：状态存角色档案（谁能点、点完都改同一份），渲染只由会话视图负责一次。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FC, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import {
  DEFAULT_SPRITE_POSITION,
  applyDragDelta,
  clampSpritePosition,
} from "../utils/spritePosition";
import type { ISpritePosition } from "../utils/spritePosition";

export interface IPinnedSpriteProps {
  /** 当前会话的角色（为空或未开启固定立绘时不渲染）。 */
  readonly profile?: ICharacterProfile;
  /** 当前情绪，用于挑选立绘。 */
  readonly emotion?: string;
}

/** 情绪交叉淡入的时长（与 CSS 里的动画时长保持一致）。 */
const SPRITE_CROSSFADE_MS = 300;

export const PinnedSprite: FC<IPinnedSpriteProps> = ({
  profile,
  emotion = "neutral",
}) => {
  const updateCharacter = useSessionStore((s) => s.updateCharacter);
  const [dragPosition, setDragPosition] = useState<ISpritePosition | null>(null);
  const elementRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    origin: ISpritePosition;
    size: { width: number; height: number };
    latest: ISpritePosition;
  } | null>(null);

  const pinned = profile?.visualMetadata.spritePinned ?? false;
  const sprites = profile?.visualMetadata.sprites ?? [];
  const active =
    sprites.find((sprite) => sprite.emotion === emotion) ?? sprites[0];
  const activeUrl = active?.url ?? null;

  /**
   * 情绪切换时做交叉淡入：旧图留在下面淡出，新图叠上去淡入。
   *
   * 之前是直接换 `src`——一张表情硬切到另一张，看起来像闪了一下。
   * 用 data URL 时尤其明显（解码要一帧）。
   */
  const previousUrlRef = useRef<string | null>(null);
  const [fadingUrl, setFadingUrl] = useState<string | null>(null);

  useEffect(() => {
    const previous = previousUrlRef.current;
    previousUrlRef.current = activeUrl;
    if (!activeUrl || !previous || previous === activeUrl) return;

    setFadingUrl(previous);
    const timer = setTimeout(() => setFadingUrl(null), SPRITE_CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [activeUrl]);

  const position = clampSpritePosition(
    dragPosition ??
      profile?.visualMetadata.spritePosition ??
      DEFAULT_SPRITE_POSITION,
    {
      width: elementRef.current?.offsetWidth ?? 200,
      height: elementRef.current?.offsetHeight ?? 320,
    },
    {
      width: typeof window === "undefined" ? 1280 : window.innerWidth,
      height: typeof window === "undefined" ? 720 : window.innerHeight,
    },
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!profile) return;
      event.preventDefault();
      const el = elementRef.current;
      dragRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        origin: position,
        size: {
          width: el?.offsetWidth ?? 200,
          height: el?.offsetHeight ?? 320,
        },
        latest: position,
      };

      const handleMove = (moveEvent: PointerEvent): void => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = clampSpritePosition(
          applyDragDelta(drag.origin, {
            dx: moveEvent.clientX - drag.pointerX,
            dy: moveEvent.clientY - drag.pointerY,
          }),
          drag.size,
          { width: window.innerWidth, height: window.innerHeight },
        );
        drag.latest = next;
        setDragPosition(next);
      };

      const handleUp = (): void => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        const drag = dragRef.current;
        dragRef.current = null;
        setDragPosition(null);
        if (!drag) return;
        // 松手才写库：拖动过程中每帧写一次 IndexedDB 太浪费
        updateCharacter(profile.id, {
          visualMetadata: {
            ...profile.visualMetadata,
            spritePosition: drag.latest,
          },
        });
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [position, profile, updateCharacter],
  );

  // 没有立绘的角色不必挂这个图层；有立绘时**始终渲染**，
  // 用 data-visible 控制显隐——这样开关固定立绘是淡入淡出，而不是"啪"地出现/消失
  if (!profile || sprites.length === 0 || !activeUrl) return null;
  const visible = pinned;

  return createPortal(
    <div
      ref={elementRef}
      className="wechat-avatar__pinned-sprite"
      data-pin="true"
      data-visible={visible}
      data-dragging={dragPosition !== null}
      style={{ zIndex: 100, left: position.x, bottom: position.y }}
      onPointerDown={visible ? handlePointerDown : undefined}
      title={visible ? "拖动可移动位置" : undefined}
      aria-hidden={!visible}
    >
      {fadingUrl && (
        <img
          className="wechat-avatar__pinned-sprite-img wechat-avatar__pinned-sprite-img--out"
          src={fadingUrl}
          alt=""
          draggable={false}
        />
      )}
      <img
        key={activeUrl}
        className="wechat-avatar__pinned-sprite-img wechat-avatar__pinned-sprite-img--in"
        src={activeUrl}
        alt=""
        draggable={false}
      />
    </div>,
    document.body,
  );
};

PinnedSprite.displayName = "PinnedSprite";
