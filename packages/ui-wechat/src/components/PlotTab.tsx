/**
 * @file PlotTab.tsx
 * 「剧情」Tab：状态卡编辑 + 事件时间线 + 回滚。
 *
 * 状态卡按会话隔离；后台整理自动更新，用户可手动修正或回滚上一版。
 */

import { memo, useCallback, useEffect, useState } from "react";
import type { FC } from "react";
import type { IPlotRelation } from "@wechat-rp/shared-types";
import { diffPlotCards } from "@wechat-rp/core";
import { useSessionStore } from "../store/sessionStore";
import { Icon } from "./Icon";
import { formatRelativeTime } from "../utils/relativeTime";

export const PlotTab: FC = memo(() => {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const plotStates = useSessionStore((s) => s.plotStates);
  const updatePlotCard = useSessionStore((s) => s.updatePlotCard);
  const addPlotEvent = useSessionStore((s) => s.addPlotEvent);
  const deletePlotEvent = useSessionStore((s) => s.deletePlotEvent);
  const rollbackPlot = useSessionStore((s) => s.rollbackPlot);
  const clearPlotState = useSessionStore((s) => s.clearPlotState);

  const [chapter, setChapter] = useState("");
  const [scene, setScene] = useState("");
  const [timeLabel, setTimeLabel] = useState("");
  const [location, setLocation] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [threadsText, setThreadsText] = useState("");
  const [relationsText, setRelationsText] = useState("");
  const [newEvent, setNewEvent] = useState("");

  const state = activeSessionId ? plotStates[activeSessionId] : undefined;
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const characterId =
    session?.participantIds.find((id) => id !== "user") ?? "";

  // 状态卡变化（切换会话 / 后台整理 / 回滚）时同步到表单
  const updatedAt = state?.updatedAt;
  useEffect(() => {
    setChapter(state?.chapter ?? "");
    setScene(state?.scene ?? "");
    setTimeLabel(state?.timeLabel ?? "");
    setLocation(state?.location ?? "");
    setSynopsis(state?.synopsis ?? "");
    setThreadsText((state?.openThreads ?? []).join("\n"));
    setRelationsText(
      (state?.relations ?? []).map((relation) => relation.label).join("\n"),
    );
  }, [activeSessionId, updatedAt, state]);

  const handleSaveCard = useCallback(() => {
    if (!activeSessionId) return;
    const relations: IPlotRelation[] = relationsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((label) => ({ characterId, label }));
    updatePlotCard(activeSessionId, {
      chapter: chapter.trim(),
      scene: scene.trim(),
      timeLabel: timeLabel.trim(),
      location: location.trim(),
      synopsis: synopsis.trim(),
      openThreads: threadsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      relations,
    });
  }, [
    activeSessionId,
    characterId,
    chapter,
    scene,
    timeLabel,
    location,
    synopsis,
    threadsText,
    relationsText,
    updatePlotCard,
  ]);

  const handleAddEvent = useCallback(() => {
    if (!activeSessionId) return;
    const summary = newEvent.trim();
    if (!summary) return;
    const now = Date.now();
    addPlotEvent(activeSessionId, {
      id: `evt-${now}-${Math.random().toString(36).slice(2, 8)}`,
      summary,
      at: now,
      importance: 3,
      sourceMessageIds: [],
      manual: true,
    });
    setNewEvent("");
  }, [activeSessionId, newEvent, addPlotEvent]);

  if (!activeSessionId) {
    return (
      <div className="zhichi-plot-tab">
        <p className="zhichi-prompt-panel__empty">请先选择一个会话</p>
      </div>
    );
  }

  const events = [...(state?.events ?? [])].reverse();
  const canRollback = (state?.history.length ?? 0) > 0;
  /**
   * 上一版到这一版改了什么。
   *
   * `history` 的最后一条就是"这次更新之前的卡"（applyDigest 在改动前压的快照），
   * 所以不用额外存 diff——直接比一下就有。字段多的时候，
   * 用户盯着卡根本看不出哪一项被自动整理动过。
   */
  const lastSnapshot = state?.history[state.history.length - 1];
  const cardChanges =
    state && lastSnapshot ? diffPlotCards(lastSnapshot, state) : [];

  return (
    <div className="zhichi-plot-tab">
      <section className="zhichi-plot-tab__card">
        <header className="zhichi-plot-tab__section-head">
          <span>剧情状态卡</span>
          <div className="zhichi-plot-tab__section-actions">
            <button
              type="button"
              onClick={() => activeSessionId && rollbackPlot(activeSessionId)}
              disabled={!canRollback}
              title="回滚到上一版状态卡（事件不回滚）"
            >
              <Icon name="back" size={14} />
              回滚
            </button>
            <button
              type="button"
              onClick={() => activeSessionId && clearPlotState(activeSessionId)}
              disabled={!state}
              title="清空本会话的剧情状态"
            >
              <Icon name="close" size={14} />
              清空
            </button>
          </div>
        </header>

        {cardChanges.length > 0 && (
          <div className="zhichi-plot-tab__diff">
            <p className="zhichi-plot-tab__diff-title">
              本次更新（{formatRelativeTime(state!.updatedAt)}）
            </p>
            <ul className="zhichi-plot-tab__diff-list">
              {cardChanges.map((change, index) => (
                <li key={`${change.field}-${index}`}>
                  <span className="zhichi-plot-tab__diff-field">
                    {change.field}
                  </span>
                  {change.from !== null && change.to !== null
                    ? `「${change.from}」→「${change.to}」`
                    : change.to !== null
                      ? `「${change.to}」`
                      : `（已移除）「${change.from}」`}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="zhichi-plot-tab__grid">
          <label className="zhichi-plot-tab__field">
            <span>章节</span>
            <input
              type="text"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              placeholder="如：第一章 · 重逢"
            />
          </label>
          <label className="zhichi-plot-tab__field">
            <span>场景</span>
            <input
              type="text"
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              placeholder="如：放学后的教室"
            />
          </label>
          <label className="zhichi-plot-tab__field">
            <span>故事时间</span>
            <input
              type="text"
              value={timeLabel}
              onChange={(e) => setTimeLabel(e.target.value)}
              placeholder="如：周五傍晚"
            />
          </label>
          <label className="zhichi-plot-tab__field">
            <span>地点</span>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="如：南方小城"
            />
          </label>
        </div>

        <label className="zhichi-plot-tab__field">
          <span>剧情概要</span>
          <textarea
            value={synopsis}
            onChange={(e) => setSynopsis(e.target.value)}
            rows={3}
            placeholder="一段话概括当前剧情进展"
          />
        </label>

        <label className="zhichi-plot-tab__field">
          <span>未解线索（每行一条）</span>
          <textarea
            value={threadsText}
            onChange={(e) => setThreadsText(e.target.value)}
            rows={3}
            placeholder={"如：\n未送出的生日礼物\n下周的约见"}
          />
        </label>

        <label className="zhichi-plot-tab__field">
          <span>关系（每行一条）</span>
          <textarea
            value={relationsText}
            onChange={(e) => setRelationsText(e.target.value)}
            rows={2}
            placeholder={"如：\n青梅竹马"}
          />
        </label>

        <button
          type="button"
          className="zhichi-plot-tab__save"
          onClick={handleSaveCard}
        >
          保存状态卡
        </button>
      </section>

      <section className="zhichi-plot-tab__timeline">
        <header className="zhichi-plot-tab__section-head">
          <span>事件时间线（{events.length}）</span>
        </header>

        <div className="zhichi-plot-tab__add-event">
          <input
            type="text"
            value={newEvent}
            onChange={(e) => setNewEvent(e.target.value)}
            placeholder="手动记录一个事件…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddEvent();
              }
            }}
          />
          <button type="button" onClick={handleAddEvent}>
            <Icon name="plus" size={14} />
          </button>
        </div>

        {events.length === 0 ? (
          <p className="zhichi-prompt-panel__empty">
            还没有事件。开启自动整理后，AI 会把关键剧情记录到这里。
          </p>
        ) : (
          <ul className="zhichi-plot-list">
            {events.map((event) => (
              <li key={event.id} className="zhichi-plot-list__item">
                <div className="zhichi-plot-list__head">
                  <time>{formatTime(event.at)}</time>
                  <span className="zhichi-plot-list__importance">
                    {"★".repeat(event.importance)}
                  </span>
                  {event.manual && (
                    <span className="zhichi-plot-list__badge">手动</span>
                  )}
                  <button
                    type="button"
                    aria-label="删除事件"
                    title="删除事件"
                    onClick={() =>
                      activeSessionId && deletePlotEvent(activeSessionId, event.id)
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
                <p>{event.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
});

PlotTab.displayName = "PlotTab";

/** 时间戳格式化（本地时区，精确到分钟）。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}
