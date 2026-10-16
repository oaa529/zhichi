/**
 * @file WeChatShell.tsx
 * 三栏布局容器。
 *
 * 布局：
 * ┌─────────────┬──────────────────────────┐
 * │  侧边栏     │       主聊天区            │
 * │ SessionList │   ChatSessionView         │
 * │ /Contacts   │   + InputBar              │
 * │ /Settings   │                           │
 * ├─────────────┤                           │
 * │  ChatTabBar │                           │
 * └─────────────┴──────────────────────────┘
 *
 * 侧边栏宽度 280px。
 */

import { memo, useState, useCallback, useRef, useEffect } from "react";
import type { FC, ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { ChatTabBar } from "./ChatTabBar";
import type { ChatTab } from "./ChatTabBar";
import { SessionList } from "./SessionList";
import { MessageSearchPanel } from "./MessageSearchPanel";
import { ContactsPanel } from "./ContactsPanel";
import { SettingsPanel } from "./SettingsPanel";
import type { IBackupActionResult, IAutoBackupApi } from "./SettingsPanel";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { CharacterEditor } from "./CharacterEditor";
import type { ICharacterGenOutcome } from "./CharacterEditor";
import { useSessionStore } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import type { IConnectionTestResult } from "@wechat-rp/core";

export interface IWeChatShellProps {
  /** 主聊天区内容（ChatSessionView + InputBar）。 */
  readonly children: ReactNode;
  /** 标题栏显示名。 */
  readonly title?: string;
  /** 重建适配器回调。 */
  readonly onRecreateAdapter?: () => void;
  /** 测试连接回调。 */
  readonly onTestConnection?: () => Promise<IConnectionTestResult>;
  /** 导出全部数据为备份文件。 */
  readonly onExportBackup?: () => IBackupActionResult;
  /** 导入备份文件（合并，不删除本地数据）。 */
  readonly onImportBackup?: (file: File) => Promise<IBackupActionResult>;
  /** 自动备份（快照列表 + 操作入口）。 */
  readonly autoBackup?: IAutoBackupApi;
  /** 从搜索结果跳到某条消息（切会话 + 定位高亮）。 */
  readonly onJumpToMessage?: (sessionId: string, messageId: string) => void;
  /** 导入角色卡文件（新增角色，不覆盖已有）。 */
  readonly onImportCharacterCard?: (
    file: File,
  ) => Promise<{ ok: boolean; message: string }>;
  /** 导出某个角色为角色卡文件。 */
  readonly onExportCharacterCard?: (characterId: string) => void;
  /** AI 生成角色草稿（未配置 API 时可不传，编辑器则隐藏该入口）。 */
  readonly onGenerateCharacter?: (
    description: string,
  ) => Promise<ICharacterGenOutcome>;
  /** 导出某个会话的聊天记录（Markdown）。 */
  readonly onExportTranscript?: (sessionId: string) => void;
}

export const WeChatShell: FC<IWeChatShellProps> = memo(
  ({
    children,
    title = "咫尺",
    onRecreateAdapter,
    onTestConnection,
    onExportBackup,
    onImportBackup,
    autoBackup,
    onJumpToMessage,
    onImportCharacterCard,
    onExportCharacterCard,
    onGenerateCharacter,
    onExportTranscript,
  }) => {
    const [activeTab, setActiveTab] = useState<ChatTab>("chats");
    /** 聊天记录搜索关键词；非空时用搜索结果替换会话列表。 */
    const [searchQuery, setSearchQuery] = useState("");
    const [editorOpen, setEditorOpen] = useState(false);
    /** 正在编辑的角色 ID（null = 新建模式）。 */
    const [editingCharacterId, setEditingCharacterId] = useState<string | null>(
      null,
    );
    const [sidebarWidth, setSidebarWidth] = useState(300);
    const draggingRef = useRef(false);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const sessions = useSessionStore((s) => s.sessions);
    /**
     * 在场状态（在线 / 忙碌 / 已就寝）。
     *
     * 之前它只渲染在 ChatSessionView 里那个 `display: none` 的头里——
     * 也就是说"已就寝""在上课"这些状态用户根本看不见。
     * 标题下面挂一行小字，成本最低、信息也最该出现在那里。
     */
    const presence = useChatStore((s) => s.presence);
    const presenceText = useChatStore((s) => s.presenceText);
    /** 设置页占用整块主区（侧栏与分隔条收起）。 */
    const showSettings = activeTab === "settings";

    const unreadTotal = Object.values(sessions).reduce(
      (sum, s) => sum + s.unreadCount,
      0,
    );

    const handleSelectContact = useCallback(() => {
      setActiveTab("chats");
    }, []);

    const handleCreateCharacter = useCallback(() => {
      setEditingCharacterId(null);
      setEditorOpen(true);
    }, []);

    const handleEditCharacter = useCallback((characterId: string) => {
      setEditingCharacterId(characterId);
      setEditorOpen(true);
    }, []);

    // 点搜索结果：交给上层切会话并定位，同时收起搜索（回到会话列表）
    const handleJumpToMessage = useCallback(
      (sessionId: string, messageId: string) => {
        setSearchQuery("");
        onJumpToMessage?.(sessionId, messageId);
      },
      [onJumpToMessage],
    );

    // 拖拽分隔条逻辑
    const handleMouseDown = useCallback((e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }, []);

    useEffect(() => {
      const handleMouseMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        // TabBar 宽度 72px，侧边栏起始 x = 72
        const newWidth = e.clientX - 72;
        const clamped = Math.max(220, Math.min(520, newWidth));
        setSidebarWidth(clamped);
      };
    const handleMouseUp = () => {
        if (draggingRef.current) {
          draggingRef.current = false;
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    }, []);

    return (
      <div className="zhichi-shell">
        {/* 最左侧：垂直导航栏 */}
        <ChatTabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          unreadTotal={unreadTotal}
        />

        {/*
         * 设置要占满主区，不挤在侧边栏里。
         *
         * 之前设置面板被塞进 300px 的侧栏：五个 Tab 的字被压成竖排两行
         * （"关于/你"、"备/份"），长标签字段的控件被挤到 25~41px 宽
         * （"一句话背景"那个 textarea 只剩 28px，基本没法用）。
         * 现在切到设置就隐藏侧栏 + 主区全宽显示，标签单行、控件有地方伸展。
         */}
        {!showSettings && (
          <>
        {/* 中间：侧边栏内容 */}
        <aside className="zhichi-shell__sidebar" style={{ width: sidebarWidth }}>
          {/*
           * 微信这里没有标题栏：左栏图标已经说明了"你在哪个区"，
           * 再来一条"咫尺/通讯录/设置"是重复信息，白占 56px。
           * （设置模式下侧栏整个收起，标题由主区顶栏承担。）
           */}
          <div className="zhichi-shell__sidebar-content">
            {activeTab === "chats" && (
              <>
                <MessageSearchPanel
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  onJumpToMessage={handleJumpToMessage}
                />
                {searchQuery.trim().length === 0 && (
                  <SessionList onExportTranscript={onExportTranscript} />
                )}
              </>
            )}
            {activeTab === "contacts" && (
              <ContactsPanel
                onSelectContact={handleSelectContact}
                onCreateCharacter={handleCreateCharacter}
                onEditCharacter={handleEditCharacter}
                onImportCharacterCard={onImportCharacterCard}
              />
            )}
          </div>
        </aside>

        {/* 拖拽分隔条 */}
        <div
          className="zhichi-shell__resizer"
          onMouseDown={handleMouseDown}
          role="separator"
          aria-orientation="vertical"
        />
          </>
        )}

        {/* 右侧：主区（聊天填满剩余空间；设置时整块让给设置面板） */}
        <main className="zhichi-shell__main">
          <header className="zhichi-shell__main-header">
            <div className="zhichi-shell__main-heading">
              <span className="zhichi-shell__main-title">
                {showSettings
                  ? "设置"
                  : activeSessionId && sessions[activeSessionId]
                    ? sessions[activeSessionId]!.displayName
                    : title}
              </span>
              {/* 只有真的开着一个会话时才显示状态（否则"在线"没主语） */}
              {!showSettings && activeSessionId && sessions[activeSessionId] && (
                <span
                  className="zhichi-shell__main-presence"
                  data-presence={presence}
                >
                  {presenceText}
                </span>
              )}
            </div>
            {!showSettings && (
              <ContextUsageBadge sessionId={activeSessionId ?? undefined} />
            )}
          </header>
          <div className="zhichi-shell__main-content">
            {showSettings ? (
              <SettingsPanel
                onRecreateAdapter={onRecreateAdapter}
                onTestConnection={onTestConnection}
                onExportBackup={onExportBackup}
                onImportBackup={onImportBackup}
                autoBackup={autoBackup}
              />
            ) : (
              children
            )}
          </div>
        </main>

        {editorOpen && (
          <CharacterEditor
            editingCharacterId={editingCharacterId}
            onClose={() => setEditorOpen(false)}
            onExportCharacterCard={onExportCharacterCard}
            onGenerate={onGenerateCharacter}
          />
        )}
      </div>
    );
  },
);

WeChatShell.displayName = "WeChatShell";
