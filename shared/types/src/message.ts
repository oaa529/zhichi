/**
 * @file message.ts
 * 消息契约。使用联合类型（Discriminated Union）区分 6 种消息类型，
 * 每条消息必须携带 senderId / timestamp / chunkSequence 用于排序与渲染。
 */

import type { CharacterEmotion } from "./character";

/** 消息类型判别字段。 */
export type MessageType =
  | "text"
  | "image"
  | "voice"
  | "sticker"
  | "system"
  | "recall";

/** 所有消息共享的公共字段。 */
export interface IMessageBase {
  /** 消息唯一 ID（UUID v4）。 */
  readonly id: string;
  /** 发送者 ID。角色 ID 或保留 ID "user"。 */
  readonly senderId: string;
  /** 接收者 ID（用于会话归属判定，单聊场景下为对方 ID）。 */
  readonly recipientId: string;
  /** 所属会话 ID。 */
  readonly sessionId: string;
  /** 服务端时间戳（ms）。 */
  readonly timestamp: number;
  /**
   * 碎片序列号。
   * 当引擎把一段 LLM 输出拆为多条气泡时，每条 chunk 递增此序号，
   * UI 依此对同一批次的消息做稳定排序与逐条弹出动画。
   */
  readonly chunkSequence: number;
  /** 当前消息发送者的情绪快照（驱动立绘切换）。 */
  readonly emotion: CharacterEmotion;
  /**
   * 引用的消息（微信式"引用回复"，仅被引用的那条消息）。
   *
   * 只保存渲染与 Prompt 需要的摘要，不引用整条消息对象：
   * 被引用的消息可能因为"重新生成/撤回"而从列表里消失，
   * 那时引用块仍要能显示出来。
   */
  readonly quote?: IMessageQuote;
}

/** 引用回复的目标摘要。 */
export interface IMessageQuote {
  /** 被引用消息的 ID。 */
  readonly messageId: string;
  /** 被引用消息的发送者显示名（"我"或角色名）。 */
  readonly senderName: string;
  /** 被引用内容的单行摘要（已截断）。 */
  readonly preview: string;
}

/** 文本消息。 */
export interface ITextMessage extends IMessageBase {
  readonly type: "text";
  /** 已完成拼接的完整文本（逐字动画由 UI 层按延迟播放）。 */
  readonly text: string;
  /** 该 chunk 在原文中的起始字符偏移，供引擎回填与回放。 */
  readonly sourceOffset: number;
}

/** 图片消息。 */
export interface IImageMessage extends IMessageBase {
  readonly type: "image";
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** 可选缩略图（聊天气泡内优先渲染）。 */
  readonly thumbnailUrl?: string;
}

/** 语音消息。 */
export interface IVoiceMessage extends IMessageBase {
  readonly type: "voice";
  /** 语音文件 URL。 */
  readonly url: string;
  /** 时长（秒）。 */
  readonly durationSec: number;
  /** 可选 ASR 转写文本（点击"转文字"时显示）。 */
  readonly transcript?: string;
}

/** 贴图/表情消息。 */
export interface IStickerMessage extends IMessageBase {
  readonly type: "sticker";
  /** 贴图包 ID + 贴图 ID，UI 据此查找静态资源。 */
  readonly stickerPackId: string;
  readonly stickerId: string;
  /** 内联表情字符串回退（如缺资源时显示 [微笑]）。 */
  readonly fallbackText: string;
}

/** 系统消息（时间分割线、"对方撤回了一条消息"等）。 */
export interface ISystemMessage extends IMessageBase {
  readonly type: "system";
  readonly systemKind: SystemMessageKind;
  readonly displayText: string;
}

/** 撤回消息。引用被撤回的原消息 ID。 */
export interface IRecallMessage extends IMessageBase {
  readonly type: "recall";
  /** 被撤回的原消息 ID。 */
  readonly targetMessageId: string;
  /** 撤回提示文案，如"苏晚晴撤回了一条消息"。 */
  readonly notice: string;
}

/** 系统消息子类型。 */
export type SystemMessageKind =
  | "time-divider"
  | "recall-notice"
  | "presence-change"
  | "session-start";

/**
 * 消息联合类型。通过 `msg.type` 做 exhaustiveness 判断。
 */
export type IMessage =
  | ITextMessage
  | IImageMessage
  | IVoiceMessage
  | IStickerMessage
  | ISystemMessage
  | IRecallMessage;

/**
 * 消息类型守卫工具集合。供 UI 层在 switch 之外做 narrowing。
 */
export const MessageGuard = {
  isText: (m: IMessage): m is ITextMessage => m.type === "text",
  isImage: (m: IMessage): m is IImageMessage => m.type === "image",
  isVoice: (m: IMessage): m is IVoiceMessage => m.type === "voice",
  isSticker: (m: IMessage): m is IStickerMessage => m.type === "sticker",
  isSystem: (m: IMessage): m is ISystemMessage => m.type === "system",
  isRecall: (m: IMessage): m is IRecallMessage => m.type === "recall",
} as const;
