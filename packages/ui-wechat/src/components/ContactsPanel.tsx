/**
 * @file ContactsPanel.tsx
 * 通讯录面板。
 *
 * 显示所有联系人 + "+" 新建角色入口。
 */

import { memo, useCallback, useMemo, useState } from "react";
import type { FC } from "react";
import { useSessionStore } from "../store/sessionStore";
import type { IContact } from "@wechat-rp/shared-types";

export interface IContactsPanelProps {
  /** 点击联系人时触发（通常跳转到对应聊天）。 */
  readonly onSelectContact?: (characterId: string) => void;
  /** 点击新建角色时触发（打开角色编辑器）。 */
  readonly onCreateCharacter?: () => void;
  /** 点击编辑角色时触发（打开角色编辑器并载入该角色）。 */
  readonly onEditCharacter?: (characterId: string) => void;
  /** 选择一个角色卡文件导入（新增角色，不覆盖已有）。 */
  readonly onImportCharacterCard?: (
    file: File,
  ) => Promise<{ ok: boolean; message: string }>;
}

export const ContactsPanel: FC<IContactsPanelProps> = memo(
  ({ onSelectContact, onCreateCharacter, onEditCharacter, onImportCharacterCard }) => {
    const contacts = useSessionStore((s) => s.contacts);
    const createSession = useSessionStore((s) => s.createSession);
    /** 导入角色卡的结果提示（3 秒后自动消失）。 */
    const [importState, setImportState] = useState<{
      ok: boolean;
      message: string;
    } | null>(null);

    const handleImportFile = useCallback(
      async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // 清空 value，否则连续选同一个文件不会再触发 change
        event.target.value = "";
        if (!file || !onImportCharacterCard) return;
        const result = await onImportCharacterCard(file);
        setImportState(result);
        setTimeout(() => setImportState(null), 3000);
      },
      [onImportCharacterCard],
    );

    const sorted = useMemo(() => {
      return Object.values(contacts).sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return a.displayName.localeCompare(b.displayName, "zh-CN");
      });
    }, [contacts]);

    const handleContactClick = (contact: IContact) => {
      const sessionId = createSession(contact.characterId);
      onSelectContact?.(contact.characterId);
      return sessionId;
    };

    return (
      <div className="zhichi-contacts">
        <button
          type="button"
          className="zhichi-contacts__add-btn"
          onClick={onCreateCharacter}
        >
          <span className="zhichi-contacts__add-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          <span>新建角色</span>
        </button>
        {onImportCharacterCard && (
          <label
            className="zhichi-contacts__import-btn"
            title="支持「咫尺」角色卡，以及 SillyTavern / TavernAI 社区卡（JSON 或 PNG）"
          >
            导入角色卡
            <input
              type="file"
              accept="application/json,.json,image/png,.png"
              hidden
              onChange={handleImportFile}
            />
          </label>
        )}
        {importState && (
          <p
            className={`zhichi-contacts__import-result${
              importState.ok ? "" : " zhichi-contacts__import-result--error"
            }`}
            role="status"
          >
            {importState.message}
          </p>
        )}
        <div className="zhichi-contacts__list" role="list">
          {sorted.length === 0 && (
            <p className="zhichi-contacts__empty">还没有联系人</p>
          )}
          {sorted.map((contact) => (
            <div
              key={contact.characterId}
              className="zhichi-contacts__row"
            >
              <button
                type="button"
                className="zhichi-contacts__item"
                role="listitem"
                onClick={() => handleContactClick(contact)}
              >
                <div className="zhichi-contacts__avatar">
                  {contact.avatarUrl ? (
                    <img src={contact.avatarUrl} alt={contact.displayName} />
                  ) : (
                    <span className="zhichi-contacts__avatar-placeholder">
                      {contact.displayName.slice(0, 1)}
                    </span>
                  )}
                </div>
                <div className="zhichi-contacts__info">
                  <span className="zhichi-contacts__name">{contact.displayName}</span>
                  <span className="zhichi-contacts__bio">{contact.bio}</span>
                </div>
              </button>
              {onEditCharacter && (
                <button
                  type="button"
                  className="zhichi-contacts__edit-btn"
                  title="编辑角色"
                  aria-label={`编辑 ${contact.displayName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditCharacter(contact.characterId);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  },
);

ContactsPanel.displayName = "ContactsPanel";
