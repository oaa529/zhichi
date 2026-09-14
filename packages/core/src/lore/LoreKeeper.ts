/**
 * @file LoreKeeper.ts
 * 世界书：从社区角色卡的 `character_book` 归一化、按关键词检索、渲染成 Prompt 段落。
 *
 * 设计取舍：
 * - **不做递归扫描**（社区卡的 `recursive_scanning`）：条目内容再去触发别的条目，
 *   在长设定集上会滚雪球，注入量不可控。这里只做一次扫描。
 * - **预算是硬约束**：条数与总字数都设上限，宁可少注入也不能把上下文挤爆。
 * - 与「长期记忆」分开检索、分开渲染，但注入时共用同一段动态上下文。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { ILoreEntry, ILoreSelectionStats } from "@wechat-rp/shared-types";

/** 单轮最多注入几条。 */
export const DEFAULT_LORE_MAX_ENTRIES = 5;
/** 单轮注入内容的总字数上限。 */
export const DEFAULT_LORE_MAX_CHARS = 800;

/** 检索结果。 */
export interface ILoreSelectionResult {
  /** 实际注入的条目（已按插入顺序排好）。 */
  readonly entries: ReadonlyArray<ILoreEntry>;
  readonly stats: ILoreSelectionStats;
}

/** 单条目的关键词命中判定。 */
function hitsAny(
  haystack: string,
  keys: ReadonlyArray<string>,
  caseSensitive: boolean,
): boolean {
  return keys.some((key) => {
    const needle = caseSensitive ? key.trim() : key.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** 条目是否应当被当前输入触发。 */
function isTriggered(entry: ILoreEntry, query: string): boolean {
  if (entry.constant) return true;
  if (entry.keys.length === 0) return false;
  const haystack = entry.caseSensitive ? query : query.toLowerCase();
  if (!hitsAny(haystack, entry.keys, entry.caseSensitive)) return false;
  // 精确条目：主关键词之外，还要有一个次级关键词同时出现
  if (entry.selective && entry.secondaryKeys.length > 0) {
    return hitsAny(haystack, entry.secondaryKeys, entry.caseSensitive);
  }
  return true;
}

/**
 * 从当前输入（通常是"用户这句话 + 最近几条消息"）里挑出要注入的世界书条目。
 *
 * 规则：
 * 1. 只考虑启用且正文非空的条目；
 * 2. 常驻条目（constant）无条件入选，其余按关键词命中；
 * 3. 按插入顺序升序排列（社区卡里 order 小的优先级高）；
 * 4. 条数与总字数双重预算：超预算的条目跳过，但**允许继续找更短的条目**；
 *    若第一条就超预算，则截断这一条而不是什么都不注入。
 */
export function selectLoreEntries(
  query: string,
  entries: ReadonlyArray<ILoreEntry>,
  options: { readonly maxEntries?: number; readonly maxChars?: number } = {},
): ILoreSelectionResult {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_LORE_MAX_ENTRIES);
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_LORE_MAX_CHARS);

  const usable = entries.filter((entry) => entry.enabled && entry.content.trim());
  const candidates = usable
    .filter((entry) => isTriggered(entry, query))
    .sort((a, b) => a.order - b.order);

  const selected: ILoreEntry[] = [];
  let usedChars = 0;
  let dropped = 0;

  for (const entry of candidates) {
    if (selected.length >= maxEntries) {
      dropped += 1;
      continue;
    }
    const content = entry.content.trim();
    const cost = content.length;

    if (usedChars + cost > maxChars) {
      // 超出预算：跳过这一条，但后面的短条目仍有机会
      dropped += 1;
      continue;
    }
    selected.push(entry);
    usedChars += cost;
  }

  // 兜底：所有候选都超预算时（例如单条长设定 + 很小的预算），
  // 与其什么都不注入，不如把最靠前的那条截断——至少给模型一点线索。
  if (selected.length === 0 && candidates.length > 0) {
    const first = candidates[0]!;
    const content = first.content.trim();
    selected.push({
      ...first,
      content: `${content.slice(0, Math.max(1, maxChars - 1))}…`,
    });
    dropped = Math.max(0, dropped - 1);
  }

  return {
    entries: selected,
    stats: {
      total: usable.length,
      injected: selected.length,
      droppedByBudget: dropped,
    },
  };
}

/** 把选中的条目渲染成一段 Prompt 文本；没有内容时返回空串（不产生空段落）。 */
export function renderLoreSection(
  entries: ReadonlyArray<ILoreEntry>,
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.content.trim()}`);
  return ["【世界设定】", ...lines].join("\n");
}

// ---------- 社区卡 character_book → 条目 ----------

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取字符串数组（过滤非字符串元素）。 */
function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 把社区卡的 `character_book` 归一化成条目数组。
 *
 * 结构不对的部分逐条丢弃，不让一条坏数据毁掉整张卡。
 *
 * @param book 社区卡的 character_book 原始结构（未知类型）
 * @param idFactory 条目 ID 生成器（测试可注入）
 */
export function loreEntriesFromBook(
  book: unknown,
  idFactory: (index: number) => string = (index) =>
    `lore-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
): ReadonlyArray<ILoreEntry> {
  if (!isRecord(book)) return [];
  const rawEntries = book.entries;
  if (!Array.isArray(rawEntries)) return [];

  const out: ILoreEntry[] = [];
  rawEntries.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const content = asString(raw.content).trim();
    if (!content) return;
    const keys = asStringArray(raw.keys).map((key) => key.trim()).filter(Boolean);
    const secondaryKeys = (
      asStringArray(raw.secondary_keys).length > 0
        ? asStringArray(raw.secondary_keys)
        : asStringArray(raw.keysecondary)
    )
      .map((key) => key.trim())
      .filter(Boolean);
    const comment = asString(raw.comment).trim() || asString(raw.name).trim();

    out.push({
      id: idFactory(index),
      keys,
      secondaryKeys,
      content,
      // 社区卡里 enabled 缺省视为启用
      enabled: asBoolean(raw.enabled, true),
      order: asNumber(raw.insertion_order, index),
      caseSensitive: asBoolean(raw.case_sensitive, false),
      constant: asBoolean(raw.constant, false),
      selective: asBoolean(raw.selective, false),
      ...(comment ? { comment } : {}),
    });
  });

  return out;
}
