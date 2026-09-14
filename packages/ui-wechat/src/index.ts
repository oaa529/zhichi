/**
 * @file index.ts
 * @wechat-rp/ui-wechat 包出口。
 */

export * from "./components";
export * from "./store/chatStore";
export * from "./store/sessionStore";

// ---------- 纯工具函数（供组装层复用，均可单测） ----------

export * from "./utils/messageOrder";
export * from "./utils/scrollFollow";
export * from "./utils/timeDivider";
export * from "./utils/proactiveSession";
export * from "./utils/characterTemplate";
export * from "./utils/regenerate";
export * from "./utils/placeholderSprite";
export * from "./utils/placeholderSticker";
export * from "./utils/spritePosition";
export * from "./utils/emotionLabel";
// 社区卡导入（PNG 卡的自带头像）需要它
export * from "./utils/imageFile";
