/**
 * @file TypingIndicatorBubble.tsx
 * "对方正在输入..." 占位气泡。
 * 仅在 typingIndicator.active === true 时由 ChatSessionView 渲染。
 */

import { memo } from "react";
import type { FC } from "react";
import { motion } from "framer-motion";

export interface ITypingIndicatorBubbleProps {
  readonly avatarUrl: string;
}

export const TypingIndicatorBubble: FC<ITypingIndicatorBubbleProps> = memo(
  ({ avatarUrl }) => {
    return (
      <motion.div
        className="wechat-msg wechat-msg--typing"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
      >
        <img
          className="wechat-msg__avatar"
          src={avatarUrl}
          alt=""
          loading="lazy"
        />
        <div className="wechat-msg__body">
          <div className="wechat-msg-bubble wechat-msg-bubble--typing">
            <span className="wechat-msg-bubble__dots">
              <span className="dot dot--1" />
              <span className="dot dot--2" />
              <span className="dot dot--3" />
            </span>
          </div>
        </div>
      </motion.div>
    );
  },
);

TypingIndicatorBubble.displayName = "TypingIndicatorBubble";
