/**
 * @file ContactList.tsx
 *
 * ⚠️ 现状：本组件当前**没有内部使用方**——会话列表与通讯录分别由
 * `SessionList` / `ContactsPanel` 实现。保留此文件仅供外部复用参考。
 *
 * 会话列表（首页）。受控组件。
 * 展示所有 RP 角色的会话入口，显示最后一条消息摘要与时间。
 */

import { memo } from "react";
import type { FC } from "react";
import type {
  CharacterPresence,
  ICharacterProfile,
  IMessage,
} from "@wechat-rp/shared-types";

export interface IContactListItem {
  readonly profile: ICharacterProfile;
  readonly lastMessage: IMessage | null;
  readonly unreadCount: number;
  readonly presence: CharacterPresence;
  readonly presenceText: string;
}

export interface IContactListProps {
  readonly items: ReadonlyArray<IContactListItem>;
  readonly activeCharacterId: string | null;
  readonly onSelect: (characterId: string) => void;
}

export const ContactList: FC<IContactListProps> = memo(
  ({ items, activeCharacterId, onSelect }) => {
    return (
      <nav className="wechat-contact-list" aria-label="会话列表">
        {items.map((item) => {
          const isActive = item.profile.id === activeCharacterId;
          return (
            <button
              key={item.profile.id}
              type="button"
              className="wechat-contact-list__item"
              data-active={isActive}
              onClick={() => onSelect(item.profile.id)}
            >
              <img
                className="wechat-contact-list__avatar"
                src={item.profile.visualMetadata.avatarUrl}
                alt={item.profile.displayName}
                loading="lazy"
              />
              <div className="wechat-contact-list__main">
                <div className="wechat-contact-list__row1">
                  <span className="wechat-contact-list__name">
                    {item.profile.displayName}
                  </span>
                  <span
                    className="wechat-contact-list__presence"
                    data-presence={item.presence}
                  >
                    {item.presenceText}
                  </span>
                </div>
                <div className="wechat-contact-list__row2">
                  <span className="wechat-contact-list__last-msg">
                    {summarizeLastMessage(item.lastMessage)}
                  </span>
                  {item.unreadCount > 0 && (
                    <span className="wechat-contact-list__badge">
                      {item.unreadCount > 99 ? "99+" : item.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </nav>
    );
  },
);

ContactList.displayName = "ContactList";

/** 生成最后一条消息的列表摘要（≤20 字）。 */
function summarizeLastMessage(message: IMessage | null): string {
  if (!message) return "";
  switch (message.type) {
    case "text":
      return message.text.length > 20
        ? message.text.slice(0, 20) + "…"
        : message.text;
    case "image":
      return "[图片]";
    case "voice":
      return `[语音 ${Math.round(message.durationSec)}″]`;
    case "sticker":
      return `[${message.fallbackText}]`;
    case "system":
      return message.displayText;
    case "recall":
      return message.notice;
    default:
      return "";
  }
}
