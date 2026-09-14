/**
 * @file PlotKeeper.ts
 * 剧情维护：把后台整理结果应用到状态卡与事件时间线，
 * 提供回滚、Prompt 摘要渲染与"推进剧情"指令构造。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type {
  IBackgroundDigest,
  IPlotEvent,
  IPlotSnapshot,
  IPlotState,
} from "@wechat-rp/shared-types";

import { bigramSimilarity } from "../memory/MemoryRetriever";

/** 时间线保留的最大事件数。 */
const DEFAULT_MAX_EVENTS = 100;
/** 状态卡历史快照保留数量。 */
const DEFAULT_MAX_HISTORY = 5;
/** 事件去重相似度阈值。 */
const DEFAULT_EVENT_SIMILARITY = 0.8;

/** 创建一张空白状态卡。 */
export function createEmptyPlotState(
  sessionId: string,
  now: number = Date.now(),
): IPlotState {
  return {
    sessionId,
    chapter: "",
    scene: "",
    timeLabel: "",
    location: "",
    synopsis: "",
    openThreads: [],
    relations: [],
    events: [],
    history: [],
    updatedAt: now,
  };
}

/** 应用整理的选项。 */
export interface IApplyDigestOptions {
  readonly sessionId: string;
  /** 现有状态卡（null = 首次创建）。 */
  readonly state: IPlotState | null;
  readonly digest: IBackgroundDigest;
  /** 当前时间（测试可注入）。 */
  readonly now?: number;
  /** 本批事件/记忆的来源消息 ID。 */
  readonly sourceMessageIds?: ReadonlyArray<string>;
  /** 事件 ID 生成器（测试可注入）。 */
  readonly idFactory?: () => string;
  /** 时间线保留上限（默认 100）。 */
  readonly maxEvents?: number;
  /** 快照保留上限（默认 5）。 */
  readonly maxHistory?: number;
  /** 事件去重相似度阈值（默认 0.8）。 */
  readonly eventSimilarityThreshold?: number;
}

/**
 * 把整理结果应用到状态卡。
 *
 * - 状态卡字段有实际变化时，先把旧版本压入 history 快照再覆盖
 * - 事件按摘要相似度去重后追加，并保留最近 maxEvents 条
 * - 不修改入参，返回新对象
 */
export function applyDigest(options: IApplyDigestOptions): IPlotState {
  const {
    sessionId,
    state,
    digest,
    now = Date.now(),
    sourceMessageIds = [],
    idFactory = (): string =>
      `evt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    maxEvents = DEFAULT_MAX_EVENTS,
    maxHistory = DEFAULT_MAX_HISTORY,
    eventSimilarityThreshold = DEFAULT_EVENT_SIMILARITY,
  } = options;

  const base = state ?? createEmptyPlotState(sessionId, now);
  const patch = digest.plot;

  const nextCard = {
    chapter: patch.chapter ?? base.chapter,
    scene: patch.scene ?? base.scene,
    timeLabel: patch.timeLabel ?? base.timeLabel,
    location: patch.location ?? base.location,
    synopsis: patch.synopsis ?? base.synopsis,
    openThreads: patch.openThreads ?? base.openThreads,
    relations: patch.relations ?? base.relations,
  };

  // 状态卡内容变化 → 压入历史快照
  const cardChanged = !isSameCard(base, nextCard);
  let history = base.history;
  if (cardChanged && hasAnyCardContent(base)) {
    const snapshot: IPlotSnapshot = {
      chapter: base.chapter,
      scene: base.scene,
      timeLabel: base.timeLabel,
      location: base.location,
      synopsis: base.synopsis,
      openThreads: base.openThreads,
      relations: base.relations,
      savedAt: now,
    };
    history = [...base.history, snapshot].slice(-maxHistory);
  }

  // 事件去重后追加
  const events: IPlotEvent[] = [...base.events];
  for (const draft of digest.events) {
    const duplicated = events.some(
      (event) =>
        event.summary === draft.summary ||
        bigramSimilarity(event.summary, draft.summary) >= eventSimilarityThreshold,
    );
    if (duplicated) continue;
    events.push({
      id: idFactory(),
      summary: draft.summary,
      at: now,
      importance: draft.importance,
      sourceMessageIds: [...sourceMessageIds],
      manual: false,
    });
  }

  return {
    sessionId,
    ...nextCard,
    events: trimEvents(events, maxEvents),
    history,
    updatedAt: now,
  };
}

/**
 * 时间线截断：保留最近 maxEvents 条，但**手动加的事件优先保留**。
 *
 * 由来：此前是直接 `events.slice(-maxEvents)`。长会话里事件会一路累积，
 * 一旦碰到上限（默认 100 条），**最早那批连同用户手写的一起被挤掉**——
 * 自动累积的东西把用户自己写的抹掉，属于最不该发生的那种数据丢失。
 *
 * 规则：
 * - 手动事件全部保留（它们本来就是少数，且是用户亲手维护的）；
 * - 剩余名额给最近的自动事件；
 * - 万一手动事件自己就超过上限（极端情况），按时间保最近的，别让数组无限增长；
 * - 顺序不变（events 本来就是按时间正序）。
 */
function trimEvents(
  events: ReadonlyArray<IPlotEvent>,
  maxEvents: number,
): IPlotEvent[] {
  if (events.length <= maxEvents) return [...events];
  if (maxEvents <= 0) return [];

  const manual = events.filter((event) => event.manual);
  if (manual.length >= maxEvents) return manual.slice(-maxEvents);

  const autoRoom = maxEvents - manual.length;
  const keptAuto = new Set<IPlotEvent>(
    events.filter((event) => !event.manual).slice(-autoRoom),
  );
  return events.filter((event) => event.manual || keptAuto.has(event));
}

/**
 * 回滚状态卡到上一个快照。
 *
 * 事件时间线不参与回滚（单条可手动删除）。
 *
 * @returns 回滚后的状态卡；无历史快照时返回 null
 */
export function rollbackPlotState(
  state: IPlotState,
  now: number = Date.now(),
): IPlotState | null {
  const snapshot = state.history[state.history.length - 1];
  if (!snapshot) return null;

  return {
    ...state,
    chapter: snapshot.chapter,
    scene: snapshot.scene,
    timeLabel: snapshot.timeLabel,
    location: snapshot.location,
    synopsis: snapshot.synopsis,
    openThreads: snapshot.openThreads,
    relations: snapshot.relations,
    history: state.history.slice(0, -1),
    updatedAt: now,
  };
}

/**
 * 渲染状态卡为 Prompt 段落；全空时返回空字符串（不注入）。
 */
export function renderPlotSummary(
  state: IPlotState | null | undefined,
): string {
  if (!state) return "";

  const lines: string[] = [];
  if (state.chapter.trim()) lines.push(`章节：${state.chapter.trim()}`);
  if (state.scene.trim()) lines.push(`当前场景：${state.scene.trim()}`);
  if (state.timeLabel.trim()) lines.push(`故事时间：${state.timeLabel.trim()}`);
  if (state.location.trim()) lines.push(`地点：${state.location.trim()}`);
  if (state.relations.length > 0) {
    const relations = state.relations
      .map((relation) => relation.label.trim())
      .filter(Boolean)
      .join("；");
    if (relations) lines.push(`关系：${relations}`);
  }
  if (state.openThreads.length > 0) {
    const threads = state.openThreads
      .map((thread, index) => `${index + 1}) ${thread.trim()}`)
      .filter((text) => !text.endsWith(") "))
      .join(" ");
    if (threads) lines.push(`未解线索：${threads}`);
  }
  if (state.synopsis.trim()) lines.push(`剧情概要：${state.synopsis.trim()}`);

  if (lines.length === 0) return "";
  return `【当前剧情】\n${lines.join("\n")}`;
}

/**
 * 构造"推进剧情"按钮触发的系统指令。
 *
 * 有状态卡时要求角色围绕未解线索/关系推进一步；
 * 无状态卡时退化为通用的主动消息指令。
 */
export function buildPlotAdvancePrompt(
  characterName: string,
  state?: IPlotState | null,
): string {
  if (state && renderPlotSummary(state)) {
    return `（系统：请以${characterName}的身份推进一步剧情——优先处理「当前剧情」中你最在意的一条未解线索，或以自然的方式推动场景/关系发生一点变化。保持人设与聊天风格，像平时发消息一样说话，不要提及系统提示。）`;
  }
  return `（系统：现在是一个自然时机，请以${characterName}的身份主动给对方发一条消息。可以是日常问候、分享心情或发起话题。保持人设，不要提及系统提示。）`;
}

/** 状态卡的一处变化（供界面回显"这次改了什么"）。 */
export interface IPlotCardChange {
  /** 变化的字段名（章节 / 场景 / 时间 / 地点 / 概要 / 未解线索 / 关系）。 */
  readonly field: string;
  /** 变化前的值（新增时为 null）。 */
  readonly from: string | null;
  /** 变化后的值（删除时为 null）。 */
  readonly to: string | null;
}

/** 卡片上可以直接逐字对比的字段。 */
const CARD_TEXT_FIELDS: ReadonlyArray<
  readonly [keyof IPlotCardLike, string]
> = [
  ["chapter", "章节"],
  ["scene", "场景"],
  ["timeLabel", "时间"],
  ["location", "地点"],
  ["synopsis", "概要"],
];

/**
 * 可比对的状态卡形状。
 *
 * 用结构子集而不是 `IPlotSnapshot`：调用方手上可能是快照（带 savedAt），
 * 也可能是当前的 `IPlotState`（带 updatedAt），两者都有这几个字段。
 */
export type IPlotCardLike = Pick<
  IPlotSnapshot,
  | "chapter"
  | "scene"
  | "timeLabel"
  | "location"
  | "synopsis"
  | "openThreads"
  | "relations"
>;

/**
 * 对比两版状态卡，列出改了哪些地方。
 *
 * 由来：状态卡字段多（章节/场景/时间/地点/概要/线索/关系），
 * 后台整理默默 patch 之后，用户盯着卡根本看不出哪一项被动了。
 * 这里把它拆成"一行一处变化"，界面直接照着列。
 *
 * 纯函数，可直接单测。
 */
export function diffPlotCards(
  before: IPlotCardLike | null | undefined,
  after: IPlotCardLike | null | undefined,
): ReadonlyArray<IPlotCardChange> {
  const prev = before ?? EMPTY_CARD;
  const next = after ?? EMPTY_CARD;
  const changes: IPlotCardChange[] = [];

  for (const [key, label] of CARD_TEXT_FIELDS) {
    const from = (prev[key] as string) ?? "";
    const to = (next[key] as string) ?? "";
    if (from === to) continue;
    changes.push({
      field: label,
      from: from.trim() ? from : null,
      to: to.trim() ? to : null,
    });
  }

  // 未解线索：按原文对比，分"新增"与"移除/了结"两类
  for (const thread of next.openThreads) {
    if (!prev.openThreads.includes(thread)) {
      changes.push({ field: "新增线索", from: null, to: thread });
    }
  }
  for (const thread of prev.openThreads) {
    if (!next.openThreads.includes(thread)) {
      changes.push({ field: "了结线索", from: thread, to: null });
    }
  }

  // 关系：按 characterId 对齐，看是新增、改写还是移除
  for (const relation of next.relations) {
    const old = prev.relations.find(
      (item) => item.characterId === relation.characterId,
    );
    if (!old) {
      changes.push({ field: "新增关系", from: null, to: relation.label });
    } else if (old.label !== relation.label) {
      changes.push({
        field: "关系",
        from: old.label,
        to: relation.label,
      });
    }
  }
  for (const relation of prev.relations) {
    if (!next.relations.some((item) => item.characterId === relation.characterId)) {
      changes.push({ field: "移除关系", from: relation.label, to: null });
    }
  }

  return changes;
}

/** 空白卡（用于"之前什么都没有"的对比）。 */
const EMPTY_CARD: IPlotCardLike = {
  chapter: "",
  scene: "",
  timeLabel: "",
  location: "",
  synopsis: "",
  openThreads: [],
  relations: [],
};

/** 判定两张状态卡内容是否一致。 */
function isSameCard(
  a: Pick<
    IPlotState,
    | "chapter"
    | "scene"
    | "timeLabel"
    | "location"
    | "synopsis"
    | "openThreads"
    | "relations"
  >,
  b: Pick<
    IPlotState,
    | "chapter"
    | "scene"
    | "timeLabel"
    | "location"
    | "synopsis"
    | "openThreads"
    | "relations"
  >,
): boolean {
  return (
    a.chapter === b.chapter &&
    a.scene === b.scene &&
    a.timeLabel === b.timeLabel &&
    a.location === b.location &&
    a.synopsis === b.synopsis &&
    JSON.stringify(a.openThreads) === JSON.stringify(b.openThreads) &&
    JSON.stringify(a.relations) === JSON.stringify(b.relations)
  );
}

/** 状态卡是否有任何内容（空白卡不产生快照）。 */
function hasAnyCardContent(state: IPlotState): boolean {
  return (
    state.chapter.trim().length > 0 ||
    state.scene.trim().length > 0 ||
    state.timeLabel.trim().length > 0 ||
    state.location.trim().length > 0 ||
    state.synopsis.trim().length > 0 ||
    state.openThreads.length > 0 ||
    state.relations.length > 0
  );
}
