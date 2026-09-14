/**
 * @file plot.ts
 * 剧情契约：状态卡 + 事件时间线。
 *
 * 剧情由后台整理自动更新（可回滚），也可由用户手动编辑；
 * "推进剧情"按钮会让角色基于当前状态卡主动推进一步。
 */

import type { IMemoryDraft, MemoryImportance } from "./memory";

/** 角色与用户的关系条目。 */
export interface IPlotRelation {
  /** 角色 ID。 */
  readonly characterId: string;
  /** 关系描述（如"青梅竹马"）。 */
  readonly label: string;
}

/** 时间线上的一个关键事件。 */
export interface IPlotEvent {
  /** 事件唯一 ID。 */
  readonly id: string;
  /** 事件摘要（一句话）。 */
  readonly summary: string;
  /** 记录时间（ms）。 */
  readonly at: number;
  /** 重要度 1~5。 */
  readonly importance: MemoryImportance;
  /** 来源消息 ID 列表。 */
  readonly sourceMessageIds: ReadonlyArray<string>;
  /** 是否为手动添加。 */
  readonly manual: boolean;
}

/** 状态卡快照（用于回滚，不含事件时间线）。 */
export interface IPlotSnapshot {
  readonly chapter: string;
  readonly scene: string;
  readonly timeLabel: string;
  readonly location: string;
  readonly synopsis: string;
  readonly openThreads: ReadonlyArray<string>;
  readonly relations: ReadonlyArray<IPlotRelation>;
  /** 快照保存时间（ms）。 */
  readonly savedAt: number;
}

/** 剧情状态卡（按会话归属）。 */
export interface IPlotState {
  /** 所属会话 ID。 */
  readonly sessionId: string;
  /** 章节/阶段（如"第一章 · 重逢"）。 */
  readonly chapter: string;
  /** 当前场景（如"放学后的教室"）。 */
  readonly scene: string;
  /** 故事内时间（如"周五傍晚"）。 */
  readonly timeLabel: string;
  /** 地点。 */
  readonly location: string;
  /** 剧情概要（由整理维护，同时作为 Prompt 摘要注入）。 */
  readonly synopsis: string;
  /** 未解决线索/伏笔。 */
  readonly openThreads: ReadonlyArray<string>;
  /** 与用户的关系。 */
  readonly relations: ReadonlyArray<IPlotRelation>;
  /** 事件时间线（按时间正序，保留最近 N 条）。 */
  readonly events: ReadonlyArray<IPlotEvent>;
  /** 状态卡历史快照（最近 N 版，用于回滚）。 */
  readonly history: ReadonlyArray<IPlotSnapshot>;
  /** 最后更新时间（ms）。 */
  readonly updatedAt: number;
}

/** 后台整理产出的状态卡补丁（仅提供需要更新的字段）。 */
export interface IPlotStatePatch {
  readonly chapter?: string;
  readonly scene?: string;
  readonly timeLabel?: string;
  readonly location?: string;
  readonly synopsis?: string;
  readonly openThreads?: ReadonlyArray<string>;
  readonly relations?: ReadonlyArray<IPlotRelation>;
}

/** 后台整理产出的剧情事件草稿。 */
export interface IPlotEventDraft {
  readonly summary: string;
  readonly importance: MemoryImportance;
}

/**
 * 一次后台整理（记忆 + 剧情共用同一次 LLM 调用）的产出。
 */
export interface IBackgroundDigest {
  /** 新增/更新的记忆草稿。 */
  readonly memories: ReadonlyArray<IMemoryDraft>;
  /** 新记录的关键事件。 */
  readonly events: ReadonlyArray<IPlotEventDraft>;
  /** 状态卡补丁。 */
  readonly plot: IPlotStatePatch;
}
