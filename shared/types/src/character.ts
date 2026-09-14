/**
 * @file character.ts
 * 角色档案契约。描述一个 RP 角色的完整元数据：
 * 基础信息、立绘视觉元数据、作息表、以及影响拟真引擎行为的性格标签。
 */

/**
 * 角色立绘视觉元数据。
 * 用于 UI 层的 `<AvatarWithSprite />` 与 `<SpriteViewer />`。
 */
export interface ICharacterVisualMetadata {
  /** 头像 URL（聊天列表与气泡内小头像使用）。 */
  readonly avatarUrl: string;
  /** 全尺寸立绘图集合，按情绪标签索引。 */
  readonly sprites: ReadonlyArray<ICharacterSprite>;
  /** 是否支持"固定立绘"模式（点击头像后常驻显示）。 */
  readonly supportsPinSprite: boolean;
  /** 立绘默认出现位置（聊天气泡左侧/右侧）。 */
  readonly defaultSpriteAnchor: "left" | "right";
  /**
   * 是否开启"固定立绘"。
   *
   * 放在角色档案里而不是组件本地 state：固定立绘是屏幕级的常驻图层，
   * 每个消息气泡各存一份的话，从两个气泡各点一次就会冒出两个立绘。
   */
  readonly spritePinned?: boolean;
  /**
   * 固定立绘的位置（距窗口左边缘 / 下边缘的像素）。
   * 拖动后写回，下次打开仍在原处；渲染时会按当前窗口尺寸钳制回可见区域。
   */
  readonly spritePosition?: { readonly x: number; readonly y: number };
}

/** 单张立绘图及其触发条件。 */
export interface ICharacterSprite {
  /** 情绪标签，引擎根据当前 chunk 的 sentiment 选取。 */
  readonly emotion: CharacterEmotion;
  /** 立绘图片 URL。 */
  readonly url: string;
  /** 可选缩略图 URL（用于快速预览）。 */
  readonly thumbnailUrl?: string;
}

/** 角色情绪枚举（与立绘、消息语气联动）。 */
export type CharacterEmotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "shy"
  | "surprised"
  | "thinking"
  | "sleepy";

/**
 * 角色作息表。引擎据此判断"睡眠时段延迟回复"等拟真行为。
 * 时间使用 24h 制的 `HH:MM` 字符串，便于配置与可读性。
 */
export interface ICharacterSchedule {
  /** 起床时间，如 "07:30"。 */
  readonly wakeTime: string;
  /** 入睡时间，如 "23:30"。 */
  readonly sleepTime: string;
  /** 是否启用作息感知（关闭后引擎将忽略睡眠延迟）。 */
  readonly scheduleEnabled: boolean;
  /** 时区 IANA 标识，默认 "Asia/Shanghai"。 */
  readonly timezone: string;
  /** 睡眠时段收到消息的回复策略。 */
  readonly sleepReplyPolicy: CharacterSleepReplyPolicy;
  /**
   * 忙碌时段（上课 / 上班 / 通勤），如 `[{ start: "09:00", end: "12:00", label: "在上课" }]`。
   *
   * 可选字段：老存档里没有它，按"没有忙碌时段"处理即可，不必做数据迁移。
   * 时段可以跨午夜（22:00–02:00）；与睡眠时段重叠时**睡眠优先**——
   * 人睡着了就是睡着了，不会"边睡边上课"。
   */
  readonly busyPeriods?: ReadonlyArray<ICharacterBusyPeriod>;
}

/**
 * 忙碌时段。
 *
 * 与睡眠的区别：睡着时角色**看不到**消息，忙的时候看得到、只是没空细说——
 * 所以忙碌不拦回复（该回还是回），但会更短、更"回头再说"。
 */
export interface ICharacterBusyPeriod {
  /** 开始时间 "HH:MM"。 */
  readonly start: string;
  /** 结束时间 "HH:MM"（小于开始时间表示跨午夜）。 */
  readonly end: string;
  /** 展示文案，如"在上课""在开会"。 */
  readonly label: string;
}

/** 睡眠时段回复策略。 */
export type CharacterSleepReplyPolicy =
  /** 次日醒来后按时间顺序补发回复。 */
  | "next-day-queue"
  /** 立即触发极短"半梦半醒"回复（如"嗯..."）。 */
  | "drowsy-burst"
  /** 完全静默直到醒来。 */
  | "silent";

/**
 * 角色性格标签。这些标签是拟真引擎 `TypingSimulator` 的输入参数，
 * 直接影响打字速度、碎片化粒度、犹豫概率与错别字率。
 */
export interface IPersonalityTraits {
  /**
   * 性格主标签。引擎内置每种的默认参数档位，
   * 可被 `ISimulationConfig` 覆盖。
   */
  readonly archetype: CharacterArchetype;
  /** 打字速度倍率，1.0 = 普通成年人基准。范围建议 0.5 ~ 2.0。 */
  readonly typingSpeedMultiplier: number;
  /**
   * 碎片化倾向 0~1。越高越倾向于把一句话拆成多条短气泡发送
   * （模拟"分条"聊天习惯）。
   */
  readonly fragmentationBias: number;
  /** 犹豫概率 0~1。发送前出现"对方正在输入..."然后停顿的概率。 */
  readonly hesitationProbability: number;
  /** 错别字率 0~1。打字时随机替换近形/近音字的概率。 */
  readonly typoRate: number;
  /** 表情/贴图使用频率 0~1。 */
  readonly stickerFrequency: number;
}

/** 角色原型枚举。 */
export type CharacterArchetype =
  | "energetic"   // 活泼：打字快、碎片多、错别字略高
  | "gentle"      // 温柔：打字慢、句子完整、犹豫略高
  | "serious"     // 严肃：打字准、碎片少、几乎不错字
  | "playful"     // 顽皮：贴图多、错别字高、节奏跳跃
  | "reserved"    // 内敛：长间隔停顿、回复短促
  | "night-owl";  // 夜猫：作息后移、深夜活跃

/**
 * 角色档案根类型。UI 与引擎均消费此结构。
 */
/**
 * 回复长度档位。
 * 这是**内容**层面的长度（模型写多少字），
 * 与 ISimulationConfig 里管"分成几条气泡、打字多快"的拟真参数是两回事。
 */
export type ReplyLength = "terse" | "short" | "medium" | "detailed";

/**
 * 文本回复风格：直接写进 system prompt，逐字影响模型输出。
 */
export interface IReplyStyle {
  /** 长度档位。 */
  readonly length: ReplyLength;
  /**
   * 是否允许"动作描写"（`（她抬头看了看窗外）` 这类旁白）。
   *
   * 默认关闭：这是个微信风格的聊天界面，真人不会在聊天框里
   * 写自己的动作和神态。开着更适合跑团/剧情向的用法。
   */
  readonly allowActions: boolean;
}

/** 回复风格的默认值（不填时按这个走）。 */
export const DEFAULT_REPLY_STYLE: IReplyStyle = {
  length: "short",
  allowActions: false,
};

export interface ICharacterProfile {
  /** 角色唯一 ID。 */
  readonly id: string;
  /** 显示名（出现在聊天列表与聊天气泡）。 */
  readonly displayName: string;
  /** 一句话简介。 */
  readonly bio: string;
  /** 视觉元数据：头像与立绘。 */
  readonly visualMetadata: ICharacterVisualMetadata;
  /** 作息表。 */
  readonly schedule: ICharacterSchedule;
  /** 性格标签。 */
  readonly personalityTraits: IPersonalityTraits;
  /** 角色 LLM system prompt 模板引用（不在本层注入实际内容）。 */
  readonly promptTemplateId: string;
  /** 文本回复风格（可选，缺省按 DEFAULT_REPLY_STYLE）。 */
  readonly replyStyle?: IReplyStyle;
  /**
   * 开场白：角色在新会话里主动说的第一句话。
   *
   * 从社区角色卡（SillyTavern 的 `first_mes`）导入时带过来，
   * 新会话首次打开时由界面注入成一条角色消息——
   * 卡片作者精心写的第一句话，是角色给人的第一印象。
   */
  readonly greeting?: string;
}
