/**
 * @file MemoryTab.tsx
 * 「记忆」Tab：长期记忆的查看、添加、编辑、删除、置顶与手动整理入口。
 *
 * 记忆按角色隔离（characterId），面板入口挂在提示词浮层的第二个 Tab。
 */

import { memo, useCallback, useMemo, useState } from "react";
import type { ChangeEvent, FC } from "react";
import type { IMemory, MemoryImportance, MemoryKind } from "@wechat-rp/shared-types";
import type { DigestFailureReason } from "@wechat-rp/core";
import { extractKeywords, retrieveMemories } from "@wechat-rp/core";
import { useSessionStore } from "../store/sessionStore";
import { formatRelativeTime } from "../utils/relativeTime";
import { Icon } from "./Icon";

/** 记忆类别中文标签。 */
const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  event: "经历",
  promise: "约定",
  relation: "关系",
  other: "其他",
};

const KIND_OPTIONS: ReadonlyArray<MemoryKind> = [
  "fact",
  "preference",
  "event",
  "promise",
  "relation",
  "other",
];

const IMPORTANCE_OPTIONS: ReadonlyArray<MemoryImportance> = [1, 2, 3, 4, 5];

/** 整理失败原因 → 给用户看的话（说清"卡在哪一步"，而不是只报"失败"）。 */
const DIGEST_FAILURE_LABELS: Record<DigestFailureReason, string> = {
  "no-history": "这段时间里没有可整理的文本消息",
  "empty-output": "模型没有返回内容（推理模型有时会把输出预算花在思考上）",
  unparsable: "模型返回的内容不是可解析的整理结果",
  "adapter-error": "调用模型时出错（网络或接口问题）",
  timeout: "调用模型超时（免费额度响应慢时可以调大超时）",
  aborted: "整理被中断了",
};

export interface IMemoryTabProps {
  /** 手动触发一次整理（由 App 注入 digestRunner）。 */
  readonly onRunDigest?: () => void;
  /** 待整理消息条数。 */
  readonly pendingDigestCount?: number;
  /** 是否正在整理。 */
  readonly isDigesting?: boolean;
}

export const MemoryTab: FC<IMemoryTabProps> = memo(
  ({ onRunDigest, pendingDigestCount = 0, isDigesting = false }) => {
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const sessions = useSessionStore((s) => s.sessions);
    const digestFailure = useSessionStore((s) =>
      s.activeSessionId ? s.digestFailures[s.activeSessionId] : undefined,
    );
    const digestReport = useSessionStore((s) =>
      s.activeSessionId ? s.digestReports[s.activeSessionId] : undefined,
    );
    const characters = useSessionStore((s) => s.characters);
    const memoriesMap = useSessionStore((s) => s.memories);
    const addMemory = useSessionStore((s) => s.addMemory);
    const updateMemory = useSessionStore((s) => s.updateMemory);
    const deleteMemory = useSessionStore((s) => s.deleteMemory);
    const togglePinMemory = useSessionStore((s) => s.togglePinMemory);
    const digestConfig = useSessionStore((s) => s.digestConfig);

    const [search, setSearch] = useState("");
    /** 检索预览：输入一句话，看看会挑中哪几条记忆（与真实注入同一套算法）。 */
    const [retrievalOpen, setRetrievalOpen] = useState(false);
    const [retrievalQuery, setRetrievalQuery] = useState("");
    const [editing, setEditing] = useState<IMemory | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    const session = activeSessionId ? sessions[activeSessionId] : null;
    const characterId =
      session?.participantIds.find((id) => id !== "user") ?? null;
    const character = characterId ? characters[characterId] : undefined;
    const memories = characterId ? memoriesMap[characterId] ?? [] : [];

    /**
     * 检索预览结果。
     *
     * 用的就是真实注入那条链路（`retrieveMemories` + 同一个条数上限），
     * 所以"这句话会带出哪几条记忆"看到的就是真的——出问题时不用再猜。
     */
    const retrievalHits = useMemo(() => {
      const query = retrievalQuery.trim();
      if (!query || memories.length === 0) return [];
      const queryKeywords = new Set(
        extractKeywords(query).map((keyword) => keyword.toLowerCase()),
      );
      return retrieveMemories(query, memories, {
        maxItems: digestConfig.maxInject,
      }).map((memory) => ({
        memory,
        // 为什么是它：命中的关键词（预览不显示打分，只说命中什么）
        hits: memory.keywords.filter((keyword) =>
          queryKeywords.has(keyword.toLowerCase()),
        ),
      }));
    }, [retrievalQuery, memories, digestConfig.maxInject]);

    const filtered = useMemo(() => {
      const sorted = [...memories].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.updatedAt - a.updatedAt;
      });
      const keyword = search.trim().toLowerCase();
      if (!keyword) return sorted;
      return sorted.filter(
        (memory) =>
          memory.content.toLowerCase().includes(keyword) ||
          memory.keywords.some((k) => k.toLowerCase().includes(keyword)),
      );
    }, [memories, search]);

    const handleSave = useCallback(
      (draft: {
        kind: MemoryKind;
        content: string;
        keywords: ReadonlyArray<string>;
        importance: MemoryImportance;
      }) => {
        if (!characterId) return;
        if (editing) {
          updateMemory(characterId, editing.id, {
            kind: draft.kind,
            content: draft.content,
            keywords: draft.keywords,
            importance: draft.importance,
            // 用户改过就归"手动维护"：之后不会再被后台整理改写
            origin: "manual",
          });
        } else {
          const now = Date.now();
          addMemory(characterId, {
            id: `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            kind: draft.kind,
            content: draft.content,
            keywords: draft.keywords,
            importance: draft.importance,
            pinned: false,
            createdAt: now,
            updatedAt: now,
            sourceMessageIds: [],
            origin: "manual",
          });
        }
        setEditing(null);
        setIsCreating(false);
      },
      [characterId, editing, addMemory, updateMemory],
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
        <MemoryEditor
          memory={editing}
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
            新增记忆
          </button>
          {onRunDigest && (
            <button
              type="button"
              className="zhichi-memory-tab__digest-btn"
              onClick={onRunDigest}
              disabled={isDigesting}
              title="让 AI 立即从最近对话中提炼记忆与剧情"
            >
              <Icon name="sparkles" size={14} />
              {isDigesting ? "整理中…" : "立即整理"}
            </button>
          )}
        </div>

        <p className="zhichi-memory-tab__hint">
          当前角色：{character.displayName} · 共 {memories.length} 条记忆
          {pendingDigestCount > 0 && ` · 待整理 ${pendingDigestCount} 条`}
        </p>
        <p className="zhichi-memory-tab__hint">
          你自己新增或改过的记忆会标成「手动」，后台整理不会改写或删除它
          （想交给自动整理接管，把它删掉即可）。
        </p>
        {/*
          上次整理改了什么的摘要：整理是自动跑的，
          用户最容易犯嘀咕的就是"它刚才偷偷改了什么"——一行说清。
        */}
        {digestReport && (
          <p
            className={`zhichi-memory-tab__report${
              digestReport.conflicts > 0
                ? " zhichi-memory-tab__report--conflict"
                : ""
            }`}
            role="status"
          >
            上次整理 {formatRelativeTime(digestReport.at)} · 覆盖{" "}
            {digestReport.messageCount} 条消息 · 新增 {digestReport.added} 条
            {digestReport.replaced > 0 && ` · 取代 ${digestReport.replaced} 条`}
            {digestReport.events > 0 && ` · 新增事件 ${digestReport.events} 个`}
            {digestReport.conflicts > 0 &&
              ` · ⚠️ ${digestReport.conflicts} 条与你的手动/置顶记忆冲突`}
          </p>
        )}

        {/*
          整理失败要说话。
          此前失败是全静默的：用户只看到"待整理"越积越多，
          不知道是模型没返回、JSON 解析失败，还是网络问题。
        */}
        {digestFailure && (
          <p className="zhichi-memory-tab__failure" role="status">
            上次整理没成功（{formatRelativeTime(digestFailure.at)}）：
            {DIGEST_FAILURE_LABELS[digestFailure.reason]}
            {pendingDigestCount > 0 && "，有新消息时会自动重试"}
          </p>
        )}

        {/*
          检索预览：一句话会带出哪几条记忆。
          用的是真实注入同一条链路，出问题时不用再猜"为什么它没记住"。
        */}
        <button
          type="button"
          className="zhichi-memory-tab__retrieval-toggle"
          aria-expanded={retrievalOpen}
          onClick={() => setRetrievalOpen((open) => !open)}
        >
          {retrievalOpen ? "收起检索预览" : "试试这句话会带出哪几条记忆"}
        </button>
        {retrievalOpen && (
          <div className="zhichi-memory-tab__retrieval">
            <input
              type="text"
              value={retrievalQuery}
              placeholder="输入一句话，例如：我明天要去杭州出差"
              aria-label="检索预览输入"
              onChange={(e) => setRetrievalQuery(e.target.value)}
            />
            {retrievalQuery.trim() !== "" && (
              <ul className="zhichi-memory-tab__retrieval-list">
                {retrievalHits.length === 0 && (
                  <li className="zhichi-memory-tab__retrieval-empty">
                    这句话不会带出任何记忆（没有命中够区分度的关键词）
                  </li>
                )}
                {retrievalHits.map(({ memory, hits }) => (
                  <li key={memory.id}>
                    <span className="zhichi-memory-tab__retrieval-content">
                      {memory.content}
                    </span>
                    {hits.length > 0 && (
                      <span className="zhichi-memory-tab__retrieval-why">
                        命中：{hits.join("、")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="zhichi-memory-tab__retrieval-hint">
              注入上限 {digestConfig.maxInject} 条；置顶记忆每次必定注入，不参与这里的竞争。
            </p>
          </div>
        )}

        <label className="zhichi-memory-tab__search">
          <Icon name="search" size={14} />
          <input
            type="text"
            value={search}
            placeholder="搜索记忆…"
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setSearch(e.target.value)
            }
          />
        </label>

        {filtered.length === 0 ? (
          <p className="zhichi-prompt-panel__empty">
            {memories.length === 0
              ? "还没有记忆。多聊一会儿后点「立即整理」，或手动新增。"
              : "没有匹配的记忆。"}
          </p>
        ) : (
          <ul className="zhichi-memory-list">
            {filtered.map((memory) => (
              <li
                key={memory.id}
                className={`zhichi-memory-list__item${memory.pinned ? " zhichi-memory-list__item--pinned" : ""}`}
              >
                <div className="zhichi-memory-list__head">
                  <span className="zhichi-memory-list__kind">
                    {KIND_LABELS[memory.kind]}
                  </span>
                  <span className="zhichi-memory-list__importance">
                    {"★".repeat(memory.importance)}
                  </span>
                  {/*
                    手动维护的标记：这条是用户自己写的，
                    后台整理不会改写或删除它（用户得知道自己受保护）
                  */}
                  {memory.origin === "manual" && (
                    <span
                      className="zhichi-memory-list__origin"
                      title="你自己新增或改过的记忆，后台整理不会改写它"
                    >
                      手动
                    </span>
                  )}
                  <div className="zhichi-memory-list__actions">
                    <button
                      type="button"
                      onClick={() =>
                        characterId && togglePinMemory(characterId, memory.id)
                      }
                      aria-label={memory.pinned ? "取消置顶" : "置顶"}
                      title={memory.pinned ? "取消置顶" : "置顶"}
                    >
                      <Icon name="heart" size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(memory)}
                      aria-label="编辑"
                      title="编辑"
                    >
                      <Icon name="settings" size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        characterId && deleteMemory(characterId, memory.id)
                      }
                      aria-label="删除"
                      title="删除"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </div>
                <p className="zhichi-memory-list__content">{memory.content}</p>
                {/*
                  取代记录：后台整理把它认为"过时"的那条替换掉时留下的。
                  显示出来，用户才能判断自动整理有没有改错。
                */}
                {memory.supersedesContent && (
                  <p
                    className="zhichi-memory-list__superseded"
                    title={
                      memory.supersededAt
                        ? `取代于 ${new Date(memory.supersededAt).toLocaleString("zh-CN")}`
                        : undefined
                    }
                  >
                    取代了：{memory.supersedesContent}
                  </p>
                )}
                {/*
                  冲突提示：这条新信息推翻了用户手动维护/置顶的那条，
                  但那两条都保留着——用户得知道"这儿有两份说法，你来定"。
                */}
                {memory.conflictsWith && (
                  <p className="zhichi-memory-list__conflict">
                    与你的手动/置顶记忆冲突：{memory.conflictsWith}
                  </p>
                )}
                {memory.keywords.length > 0 && (
                  <div className="zhichi-memory-list__keywords">
                    {memory.keywords.map((keyword) => (
                      <span key={keyword}>{keyword}</span>
                    ))}
                  </div>
                )}
                <p
                  className="zhichi-memory-list__meta"
                  title={`更新于 ${new Date(memory.updatedAt).toLocaleString("zh-CN")}`}
                >
                  更新于 {formatRelativeTime(memory.updatedAt)}
                  {memory.sourceMessageIds.length > 0 &&
                    ` · 来源 ${memory.sourceMessageIds.length} 条消息`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);

MemoryTab.displayName = "MemoryTab";

interface IMemoryEditorProps {
  readonly memory: IMemory | null;
  readonly onSave: (draft: {
    kind: MemoryKind;
    content: string;
    keywords: ReadonlyArray<string>;
    importance: MemoryImportance;
  }) => void;
  readonly onCancel: () => void;
}

const MemoryEditor: FC<IMemoryEditorProps> = ({ memory, onSave, onCancel }) => {
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "other");
  const [importance, setImportance] = useState<MemoryImportance>(
    memory?.importance ?? 3,
  );
  const [content, setContent] = useState(memory?.content ?? "");
  const [keywords, setKeywords] = useState(
    memory ? memory.keywords.join("，") : "",
  );

  const handleSave = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSave({
      kind,
      content: trimmed,
      keywords: keywords
        .split(/[，,、\s]+/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 6),
      importance,
    });
  };

  return (
    <div className="zhichi-memory-editor">
      <label className="zhichi-memory-editor__field">
        <span>类别</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </label>

      <label className="zhichi-memory-editor__field">
        <span>内容</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder="一句话描述要记住的事"
        />
      </label>

      <label className="zhichi-memory-editor__field">
        <span>关键词</span>
        <input
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="用逗号分隔，如：猫，喜欢"
        />
      </label>

      <label className="zhichi-memory-editor__field">
        <span>重要度</span>
        <select
          value={importance}
          onChange={(e) =>
            setImportance(Number(e.target.value) as MemoryImportance)
          }
        >
          {IMPORTANCE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {"★".repeat(option)}
            </option>
          ))}
        </select>
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
