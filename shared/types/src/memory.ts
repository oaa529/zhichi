/**
 * @file memory.ts
 * 长期记忆契约。
 *
 * 角色在与用户对话过程中，由后台整理（Digest）自动提炼"值得记住的事"，
 * 也可由用户手动增删改。记忆在每次构造 Prompt 时按相关度检索并注入。
 */

/** 记忆重要度档位（1 最低，5 最高）。 */
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;

/**
 * 记忆类别。
 * - fact       事实（姓名/年龄/职业等客观信息）
 * - preference 偏好（喜欢/讨厌的事物）
 * - event      经历（发生过的事）
 * - promise    约定（答应过的事）
 * - relation   关系（两人关系的变化与进展）
 * - other      其他
 */
export type MemoryKind =
  | "fact"
  | "preference"
  | "event"
  | "promise"
  | "relation"
  | "other";

/**
 * 记忆的来源。
 * - auto   后台整理自动提炼的
 * - manual 用户在记忆面板里新增或改过的
 */
export type MemoryOrigin = "auto" | "manual";

/** 一条长期记忆。 */
export interface IMemory {
  /** 记忆唯一 ID。 */
  readonly id: string;
  /** 归属角色 ID（记忆按角色隔离，跨会话共享）。 */
  readonly characterId: string;
  /** 记忆类别。 */
  readonly kind: MemoryKind;
  /** 记忆内容（一句话，第三人称或直述均可）。 */
  readonly content: string;
  /** 检索关键词（中文词/短语，由整理或用户提供）。 */
  readonly keywords: ReadonlyArray<string>;
  /** 重要度 1~5，影响注入排序。 */
  readonly importance: MemoryImportance;
  /** 是否置顶（置顶记忆在检索得分中获得加成）。 */
  readonly pinned: boolean;
  /** 创建时间（ms）。 */
  readonly createdAt: number;
  /** 最后更新时间（ms）。 */
  readonly updatedAt: number;
  /** 来源消息 ID 列表（手动创建时为空）。 */
  readonly sourceMessageIds: ReadonlyArray<string>;
  /**
   * 来源（缺省视为自动整理，老数据不必迁移）。
   *
   * 手动维护的记忆**不会被后台整理改写或删除**：
   * "刚改完，过几轮又被自动改回去"是最伤信任的一种行为。
   * 想让自动整理接管某条事实，把它删掉重新交给对话即可。
   */
  readonly origin?: MemoryOrigin;
  /**
   * 与哪条**受保护**的记忆（手动维护 / 置顶）内容冲突。
   *
   * 后台整理发现新信息推翻了那条受保护的记忆时，不会去改用户写的东西，
   * 也不会把新信息丢掉——而是并存，并在这里留下"和谁冲突"，
   * 让记忆面板能直接提示用户"这两条得你自己定"。
   */
  readonly conflictsWith?: string;
  /**
   * 被本条取代掉的旧记忆原文（后台整理做了"取代"时写入）。
   *
   * 只用于界面回显：让用户看得见"这条替掉了什么"，
   * 从而判断自动整理有没有改错。不参与检索或注入。
   */
  readonly supersedesContent?: string;
  /** 取代发生的时间（ms）。 */
  readonly supersededAt?: number;
}

/** 后台整理产出的记忆草稿（尚未落库，无 ID 与时间戳）。 */
export interface IMemoryDraft {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly keywords: ReadonlyArray<string>;
  readonly importance: MemoryImportance;
  /**
   * 被本条取代的旧记忆原文（可选）。
   *
   * 人的状态会变：昨天"喜欢喝咖啡"，今天"戒了改喝茶"。若只做相似度合并，
   * 两条会同时留下，角色之后就会一会儿劝你喝咖啡、一会儿说你在戒咖啡。
   * 整理模型发现冲突时把旧记忆原文原样回填到这里，合并阶段据此把它删掉。
   */
  readonly supersedes?: string;
}

/**
 * 后台整理配置。
 */
export interface IDigestConfig {
  /** 是否开启自动整理。 */
  readonly enabled: boolean;
  /** 触发阈值：距上次整理累计多少条消息后触发（默认 20）。 */
  readonly threshold: number;
  /** 单次整理最多取多少条消息作为窗口（默认 60）。 */
  readonly maxWindow: number;
  /** 每次回复最多注入多少条记忆（默认 10）。 */
  readonly maxInject: number;
  /** 事件时间线保留条数（默认 100）。 */
  readonly maxEvents: number;
  /** 状态卡快照保留版本数（默认 5）。 */
  readonly maxHistory: number;
}

/**
 * 一次后台整理的"变更摘要"。
 *
 * 整理是自动跑的，用户最容易犯嘀咕的就是"它刚才偷偷改了什么"。
 * 把这次新增/取代/冲突/事件的数量留一条记录，面板上一行就能看清，
 * 有冲突时还能直接把注意力引过去——比让用户逐条比对省事得多。
 */
export interface IDigestReport {
  /** 整理完成时间（ms）。 */
  readonly at: number;
  /** 这次整理覆盖了多少条消息。 */
  readonly messageCount: number;
  /** 新增的记忆条数。 */
  readonly added: number;
  /** 被取代或合并掉的旧记忆条数。 */
  readonly replaced: number;
  /** 与手动维护/置顶记忆冲突的条数（需要用户定夺）。 */
  readonly conflicts: number;
  /** 新增的剧情事件条数。 */
  readonly events: number;
}
