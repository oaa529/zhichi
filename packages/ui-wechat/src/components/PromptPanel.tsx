/**
 * @file PromptPanel.tsx
 * 角色助手浮层（三 Tab）：提示词 / 记忆 / 剧情。弹窗式。
 *
 * 提示词 Tab：
 * - 列出所有提示词模板，绑定到当前会话角色（真正注入 system prompt）
 * - 结构化编辑器（5 大类：身份/性格/习惯/说话风格/世界观）
 * - 新建/编辑/删除模板；"填入输入框"作为次要操作保留
 *
 * 记忆 / 剧情 Tab：见 MemoryTab / PlotTab。
 */

import { memo, useState, useCallback } from "react";
import type { FC, ChangeEvent } from "react";
import { useSessionStore } from "../store/sessionStore";
import {
  PROMPT_FIELD_GROUPS,
} from "@wechat-rp/shared-types";
import type { IPromptTemplate } from "@wechat-rp/shared-types";
import { Icon } from "./Icon";
import { MemoryTab } from "./MemoryTab";
import { PlotTab } from "./PlotTab";
import { LoreTab } from "./LoreTab";
import {
  TEMPLATE_PRESETS,
  buildTemplateFromPreset,
} from "../utils/templatePresets";
import type { ITemplatePreset } from "../utils/templatePresets";

export interface IPromptPanelProps {
  /** 关闭回调。 */
  readonly onClose: () => void;
  /** 将模板内容填入输入框（次要操作）。 */
  readonly onApply: (content: string) => void;
  /** 手动触发一次后台整理（记忆/剧情 Tab 的"立即整理"）。 */
  readonly onRunDigest?: () => void;
  /** 待整理消息条数。 */
  readonly pendingDigestCount?: number;
  /** 是否正在整理。 */
  readonly isDigesting?: boolean;
}

/** 浮层 Tab。 */
type PanelTab = "prompt" | "memory" | "lore" | "plot";

export const PromptPanel: FC<IPromptPanelProps> = memo(
  ({ onClose, onApply, onRunDigest, pendingDigestCount, isDigesting }) => {
  const templates = useSessionStore((s) => s.promptTemplates);
  const createPromptTemplate = useSessionStore((s) => s.createPromptTemplate);
  const updatePromptTemplate = useSessionStore((s) => s.updatePromptTemplate);
  const deletePromptTemplate = useSessionStore((s) => s.deletePromptTemplate);
  const realtimeAIConfig = useSessionStore((s) => s.realtimeAIConfig);
  const setRealtimeAIConfig = useSessionStore((s) => s.setRealtimeAIConfig);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const characters = useSessionStore((s) => s.characters);
  const updateCharacter = useSessionStore((s) => s.updateCharacter);

  const [panelTab, setPanelTab] = useState<PanelTab>("prompt");
  const [editing, setEditing] = useState<IPromptTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const list = Object.values(templates);

  // 当前会话角色与已绑定模板
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const characterId =
    session?.participantIds.find((id) => id !== "user") ?? null;
  const character = characterId ? characters[characterId] : undefined;
  const boundTemplateId = character?.promptTemplateId ?? "";

  const handleToggleRealtimeAI = useCallback(() => {
    setRealtimeAIConfig({ enabled: !realtimeAIConfig.enabled });
  }, [realtimeAIConfig.enabled, setRealtimeAIConfig]);

  const handleIntervalChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const seconds = Number(e.target.value);
      if (!Number.isNaN(seconds) && seconds >= 10) {
        setRealtimeAIConfig({ intervalMs: seconds * 1000 });
      }
    },
    [setRealtimeAIConfig],
  );

  const handleSave = useCallback(
    (tpl: IPromptTemplate) => {
      if (templates[tpl.id]) {
        updatePromptTemplate(tpl.id, tpl);
      } else {
        createPromptTemplate(tpl);
      }
      setEditing(null);
      setIsCreating(false);
    },
    [templates, createPromptTemplate, updatePromptTemplate],
  );

  /**
   * 用内置预设新建模板。
   *
   * 刻意**不自动打开编辑器**：模板在这时就已落库，若顺手打开编辑器，
   * 用户点"取消"会以为创建被撤销，其实模板还在——语义含糊。
   * 创建后停在列表里，想改再点那一行的编辑按钮，行为可预期。
   *
   * 名字重复时加后缀：预设可以反复取用（想基于同一套设定捏两个角色）。
   */
  const handleUsePreset = useCallback(
    (preset: ITemplatePreset) => {
      const takenNames = new Set(
        Object.values(templates).map((tpl) => tpl.name),
      );
      let name = preset.name;
      for (let i = 2; takenNames.has(name); i += 1) {
        name = `${preset.name} ${i}`;
      }
      const template = { ...buildTemplateFromPreset(preset), name };
      createPromptTemplate(template);
    },
    [templates, createPromptTemplate],
  );

  /**
   * 绑定/解绑模板到当前会话角色。
   * 绑定的模板会在每次回复时注入 system prompt（世界观/剧情字段因此生效）。
   */
  const handleToggleBind = useCallback(
    (tpl: IPromptTemplate) => {
      if (!characterId) return;
      updateCharacter(characterId, {
        promptTemplateId: boundTemplateId === tpl.id ? "" : tpl.id,
      });
    },
    [characterId, boundTemplateId, updateCharacter],
  );

  /** 将模板文本填入输入框（作为一次性消息发送用）。 */
  const handleFillInput = useCallback(
    (tpl: IPromptTemplate) => {
      onApply(synthesizeTemplateText(tpl));
      onClose();
    },
    [onApply, onClose],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deletePromptTemplate(id);
    },
    [deletePromptTemplate],
  );

  return (
    <div className="zhichi-prompt-panel" role="dialog" aria-label="提示词模板">
      <div className="zhichi-prompt-panel__backdrop" onClick={onClose} />

      <div className="zhichi-prompt-panel__dialog">
        <header className="zhichi-prompt-panel__header">
          <h2>
            <Icon
              name={
                panelTab === "prompt"
                  ? "prompt"
                  : panelTab === "memory"
                    ? "memory"
                    : panelTab === "lore"
                      ? "memory"
                      : "plot"
              }
              size={18}
            />
            {panelTab === "prompt"
              ? "提示词模板"
              : panelTab === "memory"
                ? "长期记忆"
                : panelTab === "lore"
                  ? "世界设定"
                  : "剧情"}
          </h2>
          <button
            type="button"
            className="zhichi-prompt-panel__close"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <nav className="zhichi-prompt-panel__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "prompt"}
            className={`zhichi-prompt-panel__tab${panelTab === "prompt" ? " zhichi-prompt-panel__tab--active" : ""}`}
            onClick={() => setPanelTab("prompt")}
          >
            提示词
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "memory"}
            className={`zhichi-prompt-panel__tab${panelTab === "memory" ? " zhichi-prompt-panel__tab--active" : ""}`}
            onClick={() => setPanelTab("memory")}
          >
            记忆
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "lore"}
            className={`zhichi-prompt-panel__tab${panelTab === "lore" ? " zhichi-prompt-panel__tab--active" : ""}`}
            onClick={() => setPanelTab("lore")}
          >
            设定
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "plot"}
            className={`zhichi-prompt-panel__tab${panelTab === "plot" ? " zhichi-prompt-panel__tab--active" : ""}`}
            onClick={() => setPanelTab("plot")}
          >
            剧情
          </button>
        </nav>

        <div className="zhichi-prompt-panel__body">
          {panelTab === "memory" && (
            <MemoryTab
              onRunDigest={onRunDigest}
              pendingDigestCount={pendingDigestCount}
              isDigesting={isDigesting}
            />
          )}

          {panelTab === "plot" && <PlotTab />}

          {panelTab === "lore" && <LoreTab />}

          {panelTab === "prompt" && (editing || isCreating) && (
            <PromptEditor
              template={editing}
              onSave={handleSave}
              onCancel={() => {
                setEditing(null);
                setIsCreating(false);
              }}
            />
          )}

          {panelTab === "prompt" && !editing && !isCreating && (
            <>
              {/* 实时 AI 配置区 */}
              <div className="zhichi-realtime-ai">
                <div className="zhichi-realtime-ai__header">
                  <span className="zhichi-realtime-ai__title">
                    <Icon name="sparkles" size={16} />
                    实时 AI
                  </span>
                  <button
                    type="button"
                    className={`zhichi-realtime-ai__toggle ${realtimeAIConfig.enabled ? "zhichi-realtime-ai__toggle--on" : ""}`}
                    onClick={handleToggleRealtimeAI}
                    aria-label={realtimeAIConfig.enabled ? "关闭实时AI" : "开启实时AI"}
                  >
                    <span className="zhichi-realtime-ai__toggle-knob" />
                  </button>
                </div>
                <p className="zhichi-realtime-ai__desc">
                  开启后，AI 会按设定间隔主动发消息（模拟对方主动找你聊天）
                </p>
                <label className="zhichi-realtime-ai__interval">
                  <span>间隔（秒）</span>
                  <input
                    type="number"
                    min={10}
                    step={10}
                    value={Math.round(realtimeAIConfig.intervalMs / 1000)}
                    onChange={handleIntervalChange}
                    disabled={!realtimeAIConfig.enabled}
                    className="zhichi-realtime-ai__interval-input"
                  />
                </label>
              </div>

              <button
                type="button"
                className="zhichi-prompt-panel__create-btn"
                onClick={() => setIsCreating(true)}
              >
                <Icon name="plus" size={16} />
                新建模板
              </button>

              {/*
                内置预设：空白模板要手填五类字段，新手很难第一次写出像样的设定。
                选一个骨架再改，比从零开始容易得多。
              */}
              <div className="zhichi-prompt-panel__presets">
                <span className="zhichi-prompt-panel__presets-label">
                  从预设开始：
                </span>
                {TEMPLATE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className="zhichi-prompt-panel__preset"
                    title={preset.summary}
                    onClick={() => handleUsePreset(preset)}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>

              {character && (
                <p className="zhichi-prompt-panel__bind-hint">
                  绑定作用于角色「{character.displayName}」，模板内容会注入
                  system prompt（世界观与剧情字段由此生效）
                </p>
              )}

              {list.length === 0 && (
                <p className="zhichi-prompt-panel__empty">
                  还没有提示词模板
                  <br />
                  点击"新建模板"开始创建
                </p>
              )}

              {list.map((tpl) => (
                <div
                  key={tpl.id}
                  className={`zhichi-prompt-panel__item${boundTemplateId === tpl.id ? " zhichi-prompt-panel__item--bound" : ""}`}
                >
                  <div className="zhichi-prompt-panel__item-info">
                    <span className="zhichi-prompt-panel__item-name">{tpl.name}</span>
                    <span className="zhichi-prompt-panel__item-preview">
                      {(tpl.content ?? synthesizePreview(tpl)).slice(0, 80)}
                      {(tpl.content ?? synthesizePreview(tpl)).length > 80 ? "..." : ""}
                    </span>
                  </div>
                  <div className="zhichi-prompt-panel__item-actions">
                    <button
                      type="button"
                      className={`zhichi-prompt-panel__item-btn zhichi-prompt-panel__item-btn--apply${boundTemplateId === tpl.id ? " zhichi-prompt-panel__item-btn--bound" : ""}`}
                      onClick={() => handleToggleBind(tpl)}
                      disabled={!characterId}
                      title={
                        boundTemplateId === tpl.id
                          ? "点击解除绑定"
                          : "绑定到当前角色（注入 system prompt）"
                      }
                    >
                      {boundTemplateId === tpl.id ? "使用中" : "绑定"}
                    </button>
                    <button
                      type="button"
                      className="zhichi-prompt-panel__item-btn"
                      onClick={() => handleFillInput(tpl)}
                      aria-label="填入输入框"
                      title="填入输入框"
                    >
                      <Icon name="link" size={14} />
                    </button>
                    <button
                      type="button"
                      className="zhichi-prompt-panel__item-btn"
                      onClick={() => setEditing(tpl)}
                      aria-label="编辑"
                    >
                      <Icon name="settings" size={14} />
                    </button>
                    <button
                      type="button"
                      className="zhichi-prompt-panel__item-btn zhichi-prompt-panel__item-btn--delete"
                      onClick={() => handleDelete(tpl.id)}
                      aria-label="删除"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

PromptPanel.displayName = "PromptPanel";

/**
 * 从结构化字段合成预览文本（用于列表展示）。
 */
function synthesizePreview(tpl: IPromptTemplate): string {
  const parts: string[] = [];
  if (tpl.identityName) parts.push(tpl.identityName);
  if (tpl.identityOccupation) parts.push(tpl.identityOccupation);
  if (tpl.personalityTraits) parts.push(tpl.personalityTraits);
  return parts.join(" · ") || "(空模板)";
}

/**
 * 从结构化字段合成完整模板文本（用于"填入输入框"）。
 * 与 core 端 synthesizeTemplatePrompt 的格式保持一致。
 */
function synthesizeTemplateText(tpl: IPromptTemplate): string {
  const sections: string[] = [];
  for (const group of PROMPT_FIELD_GROUPS) {
    const lines: string[] = [];
    for (const field of group.fields) {
      const value = tpl[field.key];
      if (typeof value === "string" && value.trim()) {
        lines.push(`- ${field.label}：${value.trim()}`);
      }
    }
    if (lines.length > 0) {
      sections.push(`【${group.label}】\n${lines.join("\n")}`);
    }
  }
  if (tpl.content && tpl.content.trim()) {
    sections.push(`【补充】\n${tpl.content.trim()}`);
  }
  return sections.join("\n\n");
}

// ---------- 内部结构化编辑器 ----------

interface IPromptEditorProps {
  readonly template: IPromptTemplate | null;
  readonly onSave: (tpl: IPromptTemplate) => void;
  readonly onCancel: () => void;
}

const PromptEditor: FC<IPromptEditorProps> = ({ template, onSave, onCancel }) => {
  const [name, setName] = useState(template?.name ?? "");
  // 用 Record<string, string> 统一管理所有字段
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const group of PROMPT_FIELD_GROUPS) {
      for (const f of group.fields) {
        const v = template?.[f.key];
        init[f.key] = typeof v === "string" ? v : "";
      }
    }
    return init;
  });
  const [content, setContent] = useState(template?.content ?? "");
  /**
   * 打开时默认停在**第一个有内容的分组**。
   *
   * 预设刻意不填身份信息（那部分留给用户），若固定停在第 1 页，
   * 用户看到的是几乎空白的一页，还得挨个点标签才知道预设填了什么。
   */
  const [activeGroup, setActiveGroup] = useState<string>(() => {
    const firstFilled = PROMPT_FIELD_GROUPS.find((group) =>
      group.fields.some((f) => {
        const v = template?.[f.key];
        return typeof v === "string" && v.trim().length > 0;
      }),
    );
    return firstFilled?.id ?? PROMPT_FIELD_GROUPS[0]!.id;
  });

  const setField = useCallback((key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;

    // 构造 IPromptTemplate，所有结构化字段 + content
    const tpl: IPromptTemplate = {
      id: template?.id ?? `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      content: content.trim() || undefined,
      variables: [],
    };

    // 填充所有结构化字段
    for (const group of PROMPT_FIELD_GROUPS) {
      for (const f of group.fields) {
        const v = fields[f.key];
        if (v && v.trim()) {
          (tpl as unknown as Record<string, unknown>)[f.key] = v.trim();
        }
      }
    }

    onSave(tpl);
  }, [name, fields, content, template, onSave]);

  const currentGroup = PROMPT_FIELD_GROUPS.find((g) => g.id === activeGroup);

  return (
    <div className="zhichi-prompt-editor">
      <label className="zhichi-prompt-editor__field">
        <span>模板名称</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：温柔邻家姐姐"
          className="zhichi-prompt-editor__input"
        />
      </label>

      {/* 分组 Tab */}
      <div className="zhichi-prompt-editor__tabs">
        {PROMPT_FIELD_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`zhichi-prompt-editor__tab ${activeGroup === group.id ? "zhichi-prompt-editor__tab--active" : ""}`}
            onClick={() => setActiveGroup(group.id)}
          >
            <span className="zhichi-prompt-editor__tab-icon">{group.icon}</span>
            <span>{group.label}</span>
          </button>
        ))}
      </div>

      {/* 当前分组字段 */}
      {currentGroup && (
        <div className="zhichi-prompt-editor__group">
          {currentGroup.fields.map((f) => (
            <label key={f.key} className="zhichi-prompt-editor__field">
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea
                  value={fields[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  rows={3}
                  className="zhichi-prompt-editor__textarea"
                />
              ) : (
                <input
                  type="text"
                  value={fields[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="zhichi-prompt-editor__input"
                />
              )}
            </label>
          ))}
        </div>
      )}

      {/* 额外补充 */}
      <label className="zhichi-prompt-editor__field">
        <span>额外补充（可选）</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="其他想补充的内容..."
          rows={3}
          className="zhichi-prompt-editor__textarea"
        />
      </label>

      <div className="zhichi-prompt-editor__footer">
        <button type="button" className="zhichi-prompt-editor__btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="zhichi-prompt-editor__btn zhichi-prompt-editor__btn--save"
          onClick={handleSave}
          disabled={!name.trim()}
        >
          保存
        </button>
      </div>
    </div>
  );
};
