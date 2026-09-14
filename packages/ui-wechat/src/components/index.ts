/**
 * @file index.ts
 * @wechat-rp/ui-wechat 出口。
 */

export { ChatSessionView } from "./ChatSessionView";
export type { IChatSessionViewProps } from "./ChatSessionView";

export { MessageList } from "./MessageList";
export type { IMessageListProps } from "./MessageList";

export { MessageBubble } from "./MessageBubble";
export type { IMessageBubbleProps } from "./MessageBubble";

export { AvatarWithSprite } from "./AvatarWithSprite";
export type { IAvatarWithSpriteProps } from "./AvatarWithSprite";

export { SpriteViewer } from "./SpriteViewer";
export type { ISpriteViewerProps } from "./SpriteViewer";

// 注：ContactList / useSmartScroll 当前无内部使用方（详见各自文件头说明），
// 保留导出仅供外部复用。
export { ContactList } from "./ContactList";
export type { IContactListProps, IContactListItem } from "./ContactList";

export { InputBar } from "./InputBar";
export type { IInputBarProps } from "./InputBar";

export { Icon } from "./Icon";
export type { IconName, IIconProps } from "./Icon";

export { PromptPanel } from "./PromptPanel";
export type { IPromptPanelProps } from "./PromptPanel";

export { MemoryTab } from "./MemoryTab";
export type { IMemoryTabProps } from "./MemoryTab";

export { PlotTab } from "./PlotTab";

export { LoreTab } from "./LoreTab";

export { TypingIndicatorBubble } from "./TypingIndicatorBubble";
export type { ITypingIndicatorBubbleProps } from "./TypingIndicatorBubble";

export { NewMessagePill } from "./NewMessagePill";
export type { INewMessagePillProps } from "./NewMessagePill";

export { MessageStatusIndicator } from "./MessageStatus";
export type { IMessageStatusProps, MessageStatus } from "./MessageStatus";

export { ErrorRetryBubble } from "./ErrorRetryBubble";
export type { IErrorRetryBubbleProps } from "./ErrorRetryBubble";

// ---------- 三栏布局 ----------

export { WeChatShell } from "./WeChatShell";
export type { IWeChatShellProps } from "./WeChatShell";

export { ChatTabBar } from "./ChatTabBar";
export type { ChatTab, IChatTabBarProps } from "./ChatTabBar";

export { SessionList } from "./SessionList";
export type { ISessionListProps } from "./SessionList";

export { MessageSearchPanel } from "./MessageSearchPanel";
export type { IMessageSearchPanelProps } from "./MessageSearchPanel";

export { ContextUsageBadge } from "./ContextUsageBadge";
export type { IContextUsageBadgeProps } from "./ContextUsageBadge";

export { ErrorBoundary } from "./ErrorBoundary";
export type { IErrorBoundaryProps } from "./ErrorBoundary";

export { ContactsPanel } from "./ContactsPanel";
export type { IContactsPanelProps } from "./ContactsPanel";

export { SettingsPanel } from "./SettingsPanel";
export type {
  ISettingsPanelProps,
  IBackupActionResult,
} from "./SettingsPanel";

export { CharacterEditor } from "./CharacterEditor";
export type {
  ICharacterEditorProps,
  ICharacterGenOutcome,
} from "./CharacterEditor";

// ---------- Hooks ----------

export { useSmartScroll } from "../hooks/useSmartScroll";
export type { ISmartScrollResult } from "../hooks/useSmartScroll";

export { useRafTypewriter } from "../hooks/useRafTypewriter";
export type { IRafTypewriterOptions, IRafTypewriterResult } from "../hooks/useRafTypewriter";

export { useViewportResize } from "../hooks/useViewportResize";
export type { IViewportResizeResult } from "../hooks/useViewportResize";
