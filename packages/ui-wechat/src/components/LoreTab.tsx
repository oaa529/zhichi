/**
 * @file LoreTab.tsx
 * 「设定」Tab：世界书（Lorebook）的查看、启用/停用、增删改。
 *
 * 条目主要来自导入的社区角色卡（`character_book`），也可以手动补几条。
 * 与「记忆」Tab 的区别：记忆是聊出来的（关于用户的偏好、经历），
 * 世界书是作者预先写死的（世界观、配角、地点、道具）。
 *
 * 样式复用记忆面板的那一套列表/编辑器类名——视觉规范一致，也少一份 CSS。
 */

import { memo, useCallback, useMemo, useState } from "react";
import type { ChangeEvent, FC } from "react";
import type { ILoreEntry } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import { Icon } from "./Icon";

/** 编辑器提交的草稿。 */
interface ILoreDraft {
  readonly keys: ReadonlyArray<string>;
  readonly content: string;
  readonly constant: boolean;
}

export const LoreTab: FC = memo(() => {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const characters = useSessionStore((s) => s.characters);
  const loreMap = useSessionStore((s) => s.loreEntries);
  const addLoreEntry = useSessionStore((s) => s.addLoreEntry);
  const updateLoreEntry = useSessionStore((s) => s.updateLoreEntry);
  const deleteLoreEntry = useSessionStore((s) => s.deleteLoreEntry);

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ILoreEntry | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const session = activeSessionId ? sessions[activeSessionId] : null;
  const characterId =
    session?.participantIds.find((id) => id !== "user") ?? null;
  const character = characterId ? characters[characterId] : undefined;
  const entries = characterId ? loreMap[characterId] ?? [] : [];

  const filtered = useMemo(() => {
    const sorted = [...entries].sort((a, b) => a.order - b.order);
    const keyword = search.trim().toLowerCase();
    if (!keyword) return sorted;
    return sorted.filter(
      (entry) =>
        entry.content.toLowerCase().includes(keyword) ||
        entry.keys.some((key) => key.toLowerCase().includes(keyword)) ||
        (entry.comment ?? "").toLowerCase().includes(keyword),
    );
  }, [entries, search]);

  /** 新条目排在最后（order 大的后注入）。 */
  const nextOrder = useMemo(
    () => entries.reduce((max, entry) => Math.max(max, entry.order), 0) + 1,
    [entries],
  );

  const handleSave = useCallback(
    (draft: ILoreDraft) => {
      if (!characterId) return;
      if (editing) {
        updateLoreEntry(characterId, editing.id, {
          keys: draft.keys,
          content: draft.content,
          constant: draft.constant,
          // 手动从"常驻"改回关键词触发时，原本就没有次级关键词，保持空即可
          secondaryKeys: draft.constant ? [] : editing.secondaryKeys,
        });
      } else {
        const now = Date.now();
        addLoreEntry(characterId, {
          id: `lore-${now}-${Math.random().toString(36).slice(2, 6)}`,
          keys: draft.keys,
          secondaryKeys: [],
          content: draft.content,
          enabled: true,
          order: nextOrder,
          caseSensitive: false,
          constant: draft.constant,
          selective: false,
        });
      }
      setEditing(null);
      setIsCreating(false);
    },
    [characterId, editing, nextOrder, addLoreEntry, updateLoreEntry],
  );

  const handleToggleEnabled = useCallback(
    (entry: ILoreEntry) => {
      if (!characterId) return;
      updateLoreEntry(characterId, entry.id, { enabled: !entry.enabled });
    },
    [characterId, updateLoreEntry],
  );

  if (!character) {
    return (
      <div className="zhichi-memory-tab">
        <p className="zhichi-prompt-panel__empty">请先选择一个会话</p>
      </div>
    );
  }

  if (editing || isCreating) {
    return (
      <LoreEditor
        entry={editing}
        onSave={handleSave}
        onCancel={() => {
          setEditing(null);
          setIsCreating(false);
        }}
      />
    );
  }

  return (
    <div className="zhichi-memory-tab">
      <div className="zhichi-memory-tab__toolbar">
        <button
          type="button"
          className="zhichi-memory-tab__add-btn"
          onClick={() => setIsCreating(true)}
        >
          <Icon name="plus" size={16} />
          新增设定
        </button>
      </div>

      <p className="zhichi-memory-tab__hint">
        当前角色：{character.displayName} · 共 {entries.length} 条设定
        {entries.length > 0 && ` · 已启用 ${entries.filter((e) => e.enabled).length} 条`}
      </p>

      <label className="zhichi-memory-tab__search">
        <Icon name="search" size={14} />
        <input
          type="text"
          value={search}
          placeholder="搜索设定…"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        />
      </label>

      {filtered.length === 0 ? (
        <p className="zhichi-prompt-panel__empty">
          {entries.length === 0
            ? "还没有世界设定。导入带世界书的社区角色卡会自动填充，也可以手动新增——聊到关键词时才会注入，不占日常上下文。"
            : "没有匹配的设定。"}
        </p>
      ) : (
        <ul className="zhichi-memory-list">
          {filtered.map((entry) => (
            <li
              key={entry.id}
              className={`zhichi-memory-list__item${entry.enabled ? "" : " zhichi-lore-list__item--off"}`}
            >
              <div className="zhichi-memory-list__head">
                <span className="zhichi-memory-list__kind">
                  {entry.constant
                    ? "常驻"
                    : entry.keys.length > 0
                      ? "关键词"
                      : "无关键词"}
                </span>
                <div className="zhichi-memory-list__actions">
                  <label
                    className="zhichi-lore-list__toggle"
                    title={entry.enabled ? "停用这条设定" : "启用这条设定"}
                  >
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      aria-label={entry.enabled ? "停用" : "启用"}
                      onChange={() => handleToggleEnabled(entry)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditing(entry)}
                    aria-label="编辑"
                    title="编辑"
                  >
                    <Icon name="settings" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => characterId && deleteLoreEntry(characterId, entry.id)}
                    aria-label="删除"
                    title="删除"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
              <p className="zhichi-memory-list__content">{entry.content}</p>
              {entry.keys.length > 0 && (
                <div className="zhichi-memory-list__keywords">
                  {entry.keys.map((key) => (
                    <span key={key}>{key}</span>
                  ))}
                </div>
              )}
              {entry.comment && (
                <p className="zhichi-memory-list__meta">{entry.comment}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

LoreTab.displayName = "LoreTab";

interface ILoreEditorProps {
  readonly entry: ILoreEntry | null;
  readonly onSave: (draft: ILoreDraft) => void;
  readonly onCancel: () => void;
}

const LoreEditor: FC<ILoreEditorProps> = ({ entry, onSave, onCancel }) => {
  const [keys, setKeys] = useState(entry ? entry.keys.join("，") : "");
  const [content, setContent] = useState(entry?.content ?? "");
  const [constant, setConstant] = useState(entry?.constant ?? false);

  const handleSave = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSave({
      keys: keys
        .split(/[，,、\s]+/)
        .map((key) => key.trim())
        .filter(Boolean)
        .slice(0, 12),
      content: trimmed,
      constant,
    });
  };

  return (
    <div className="zhichi-memory-editor">
      <label className="zhichi-memory-editor__field">
        <span>关键词（逗号分隔，聊到才注入）</span>
        <input
          type="text"
          value={keys}
          disabled={constant}
          placeholder={constant ? "常驻条目不需要关键词" : "如：唱片，黑胶"}
          onChange={(e) => setKeys(e.target.value)}
        />
      </label>

      <label className="zhichi-memory-editor__field">
        <span>设定内容</span>
        <textarea
          value={content}
          rows={4}
          placeholder="如：店里收藏了三千张黑胶，最旧的一张是 1968 年的。"
          onChange={(e) => setContent(e.target.value)}
        />
      </label>

      <label className="zhichi-memory-editor__field zhichi-memory-editor__field--inline">
        <input
          type="checkbox"
          checked={constant}
          onChange={(e) => setConstant(e.target.checked)}
        />
        <span>常驻（每轮都注入，适合世界观底线）</span>
      </label>

      <div className="zhichi-memory-editor__actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="zhichi-memory-editor__save"
          onClick={handleSave}
        >
          保存
        </button>
      </div>
    </div>
  );
};

LoreEditor.displayName = "LoreEditor";
