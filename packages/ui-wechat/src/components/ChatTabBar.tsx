/**
 * @file ChatTabBar.tsx
 * 左侧垂直导航栏（聊天/通讯录/设置）。
 */

import { memo } from "react";
import type { FC } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export type ChatTab = "chats" | "contacts" | "settings";

export interface IChatTabBarProps {
  readonly activeTab: ChatTab;
  readonly onTabChange: (tab: ChatTab) => void;
  readonly unreadTotal?: number;
}

const TABS: ReadonlyArray<{ id: ChatTab; label: string; icon: IconName }> = [
  { id: "chats", label: "聊天", icon: "chat" },
  { id: "contacts", label: "通讯录", icon: "contacts" },
  { id: "settings", label: "设置", icon: "settings" },
];

export const ChatTabBar: FC<IChatTabBarProps> = memo(
  ({ activeTab, onTabChange, unreadTotal = 0 }) => {
    return (
      <nav className="zhichi-tab-bar" role="tablist" aria-orientation="vertical">
        {/* 顶部 Logo */}
        <div className="zhichi-tab-bar__logo">
          <span className="zhichi-tab-bar__logo-text">咫</span>
        </div>

        {/* Tab 按钮 */}
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`zhichi-tab-bar__item ${activeTab === tab.id ? "zhichi-tab-bar__item--active" : ""}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            <span className="zhichi-tab-bar__icon">
              <Icon name={tab.icon} size={24} />
            </span>
            <span className="zhichi-tab-bar__label">{tab.label}</span>
            {tab.id === "chats" && unreadTotal > 0 && (
              <span className="zhichi-tab-bar__badge">{unreadTotal > 99 ? "99+" : unreadTotal}</span>
            )}
          </button>
        ))}
      </nav>
    );
  },
);

ChatTabBar.displayName = "ChatTabBar";
