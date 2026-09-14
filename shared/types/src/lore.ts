/**
 * @file lore.ts
 * 世界书（Lorebook / World Info）。
 *
 * 来源：社区角色卡里的 `character_book`——作者把"只有聊到某个话题时才需要
 * 知道的设定"拆成条目，每条带触发关键词。它和「长期记忆」的区别：
 * - 记忆是**对话中产生**的（关于用户的偏好、经历）；
 * - 世界书是**作者预先写死**的（世界观、配角、地点、道具）。
 *
 * 所以两者分开存储、分开检索，但共用同一份注入预算控制。
 */

/** 一条世界书条目。 */
export interface ILoreEntry {
  /** 条目唯一 ID。 */
  readonly id: string;
  /** 触发关键词（命中任意一个即候选）。 */
  readonly keys: ReadonlyArray<string>;
  /** 次级关键词（`selective` 为 true 时需要同时命中其一）。 */
  readonly secondaryKeys: ReadonlyArray<string>;
  /** 命中后注入的正文。 */
  readonly content: string;
  /** 是否启用（作者写了但关掉的条目不应注入）。 */
  readonly enabled: boolean;
  /** 注入顺序：数字小的先注入（对应社区卡的 insertion_order）。 */
  readonly order: number;
  /** 关键词是否区分大小写（中文场景基本用不到，保留兼容）。 */
  readonly caseSensitive: boolean;
  /** 常驻条目：不需要关键词命中，每轮都注入。 */
  readonly constant: boolean;
  /** 是否需要次级关键词也命中（精确触发）。 */
  readonly selective: boolean;
  /** 作者备注（不注入，仅供辨认）。 */
  readonly comment?: string;
}

/** 世界书检索结果的统计（供界面与调试查看）。 */
export interface ILoreSelectionStats {
  /** 参与检索的条目总数。 */
  readonly total: number;
  /** 实际注入的条目数。 */
  readonly injected: number;
  /** 因为超出预算被丢弃的条目数。 */
  readonly droppedByBudget: number;
}
