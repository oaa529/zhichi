/**
 * @file session.ts
 * 会话与配置契约。支持多角色、多会话、API 配置、提示词模板。
 */

import type { ISimulationConfig } from "./simulation";

/**
 * 会话类型。单聊或群聊（群聊后续迭代）。
 */
export type SessionType = "single" | "group";

/**
 * 一个聊天会话（对应"聊天"列表中的一项）。
 */
export interface ISession {
  /** 会话唯一 ID。 */
  readonly id: string;
  /** 会话类型。第一版只实现 single。 */
  readonly type: SessionType;
  /** 参与者 ID 列表（角色 ID + "user"）。单聊为 [characterId, "user"]。 */
  readonly participantIds: ReadonlyArray<string>;
  /** 会话显示名（单聊为角色名，群聊为群名）。 */
  readonly displayName: string;
  /** 会话头像 URL。 */
  readonly avatarUrl: string;
  /** 最近一条消息的预览文本（用于列表显示）。 */
  readonly lastMessagePreview: string;
  /** 最近一条消息的时间戳。 */
  readonly lastMessageTime: number;
  /** 未读消息数。 */
  readonly unreadCount: number;
  /** 是否置顶。 */
  readonly isPinned: boolean;
  /** 创建时间戳。 */
  readonly createdAt: number;
  /** 最后更新时间戳。 */
  readonly updatedAt: number;
}

/**
 * 单会话运行时状态快照（切换会话与页面刷新时保存/恢复用）。
 *
 * 消息以 `unknown` 保存：运行时视图（IMessageRuntime，含逐字揭示/错别字
 * 纠错等 UI 状态）由 UI 层定义，契约层只约定"这里放的是一个消息数组"。
 */
export interface ISessionRuntimeSnapshot {
  readonly messages: ReadonlyArray<unknown>;
  readonly presence: string;
  readonly presenceText: string;
  readonly phase: string;
  readonly typingIndicator: { active: boolean; estimatedRemainingMs: number };
  readonly pendingCount: number;
  readonly simulationConfig: ISimulationConfig;
  /**
   * 还在排队等回复的用户消息（"对方正在回复"时又发的那几条）。
   *
   * 可选字段：老存档里没有它，按"队列空"处理即可，不必做数据迁移。
   *
   * 为什么必须存：这些消息**已经上屏**了，队列丢了它们就永远不会被回复
   * ——用户看到自己发的三条消息躺在那里，一条回复都没有，还不知道为什么。
   */
  readonly queuedUserTexts?: ReadonlyArray<{ readonly text: string }>;
}

/**
 * 用户人设（"关于你"）。
 *
 * 角色卡描述的是角色，长期记忆是"聊出来的"，而这一块是用户**自己写的**、
 * 稳定成立的背景（名字、身份、习惯）。它每轮都注入，不等后台整理提炼——
 * 于是角色从第一句起就知道在跟谁说话，而不是把对方当成抽象的"用户"。
 */
export interface IUserProfile {
  /** 希望被怎么称呼（默认"我"＝不特别指定）。 */
  readonly displayName: string;
  /** 一句话背景（年龄/职业/住处/习惯等，可为空）。 */
  readonly bio: string;
}

/**
 * 实时 AI 配置 — 让 AI 可以主动发消息。
 */
export interface IRealtimeAIConfig {
  /** 是否开启实时 AI。 */
  readonly enabled: boolean;
  /** 主动消息间隔（毫秒）。 */
  readonly intervalMs: number;
}

/**
 * 通讯录联系人项。
 */
export interface IContact {
  /** 关联的角色 ID。 */
  readonly characterId: string;
  /** 显示名。 */
  readonly displayName: string;
  /** 头像 URL。 */
  readonly avatarUrl: string;
  /** 一句话简介。 */
  readonly bio: string;
  /** 是否置顶（通讯录排序用）。 */
  readonly isPinned: boolean;
}

/**
 * 提示词模板 — 角色人设定义。
 *
 * 字段划分为 5 大类，由 PromptBuilder 合成为完整 system prompt：
 * 1. identity   — 身份背景（姓名/年龄/职业/身份/关系）
 * 2. personality — 性格特质（性格/喜好/厌恶/价值观）
 * 3. habits     — 行为习惯（口头禅/小动作/作息/兴趣爱好）
 * 4. speechStyle — 说话风格（语气/用词/句式/禁用词）
 * 5. worldview   — 世界观/世界背景（故事背景/所处世界/时间线）
 *
 * 各字段均为可选，留空时不拼入 system prompt。
 * 同时保留 content 字段作为"自定义补充"用例。
 */
export interface IPromptTemplate {
  /** 模板唯一 ID。 */
  readonly id: string;
  /** 模板名（显示用）。 */
  readonly name: string;

  // ---------- 1. 身份背景 ----------
  /** 角色姓名（可与角色卡 name 不同，用于提示词内部称呼）。 */
  readonly identityName?: string;
  /** 年龄/性别（如"18岁女性"）。 */
  readonly identityAge?: string;
  /** 职业/身份（如"高中生/邻家姐姐"）。 */
  readonly identityOccupation?: string;
  /** 与用户的关系（如"青梅竹马/同桌"）。 */
  readonly identityRelation?: string;
  /** 背景故事（出身/经历/家庭）。 */
  readonly identityBackground?: string;

  // ---------- 2. 性格特质 ----------
  /** 性格描述（如"温柔内向，偶尔小任性"）。 */
  readonly personalityTraits?: string;
  /** 喜好（事物/食物/活动）。 */
  readonly personalityLikes?: string;
  /** 厌恶（雷区/禁忌话题）。 */
  readonly personalityDislikes?: string;
  /** 价值观/信念。 */
  readonly personalityValues?: string;

  // ---------- 3. 行为习惯 ----------
  /** 口头禅/常用语。 */
  readonly habitsCatchphrase?: string;
  /** 小动作/习惯动作（如"说话时爱戳手指"）。 */
  readonly habitsGestures?: string;
  /** 作息倾向（如"夜猫子/早起党"）。 */
  readonly habitsSchedule?: string;
  /** 兴趣爱好。 */
  readonly habitsHobbies?: string;

  // ---------- 4. 说话风格 ----------
  /** 语气基调（如"轻柔撒娇/干练直白"）。 */
  readonly speechTone?: string;
  /** 用词习惯（如"爱用叠词/夹杂英语"）。 */
  readonly speechVocab?: string;
  /** 句式偏好（如"短句分条，不用长段落"）。 */
  readonly speechPattern?: string;
  /** 禁用词/禁止行为（如"不使用书面语"）。 */
  readonly speechForbidden?: string;
  /**
   * 示例对话（few-shot）。
   *
   * 写两三轮"用户说什么、角色怎么回"，比一整段形容词更能定住语气与节奏——
   * 角色扮演社区里公认最有效的塑形手段。PromptBuilder 会单独成段注入，
   * 并明确要求"只模仿语气，不要照抄内容"。
   */
  readonly speechExamples?: string;

  // ---------- 5. 世界观/世界背景 ----------
  /** 世界设定（如"现代都市/古代江湖/异世界"）。 */
  readonly worldSetting?: string;
  /** 时间线/时代背景。 */
  readonly worldEra?: string;
  /** 地点/场景（如"南方某沿海城市"）。 */
  readonly worldLocation?: string;
  /** 社会规则/魔法体系等背景设定。 */
  readonly worldRules?: string;
  /** 当前剧情节点/事件背景。 */
  readonly worldPlot?: string;

  // ---------- 兼容字段 ----------
  /** 模板内容（可含 {{变量}} 占位符）。
   * 兼容旧版/自定义补充。若结构化字段非空，此字段作为"额外补充"拼入。 */
  readonly content?: string;
  /** 变量名列表。 */
  readonly variables?: ReadonlyArray<string>;
}

/**
 * 提示词模板的分组定义（用于 UI 渲染）。
 */
export interface IPromptFieldGroup {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly fields: ReadonlyArray<{
    readonly key: keyof IPromptTemplate;
    readonly label: string;
    readonly placeholder: string;
    readonly multiline?: boolean;
  }>;
}

/**
 * 提示词模板字段分组（UI 渲染用，与 IPromptTemplate 字段对应）。
 */
export const PROMPT_FIELD_GROUPS: ReadonlyArray<IPromptFieldGroup> = [
  {
    id: "identity",
    label: "身份背景",
    icon: "👤",
    fields: [
      { key: "identityName", label: "姓名", placeholder: "如：苏晚晴" },
      { key: "identityAge", label: "年龄/性别", placeholder: "如：22岁女性" },
      { key: "identityOccupation", label: "职业/身份", placeholder: "如：大学在校生" },
      { key: "identityRelation", label: "与你的关系", placeholder: "如：青梅竹马" },
      { key: "identityBackground", label: "背景故事", placeholder: "出身/经历/家庭...", multiline: true },
    ],
  },
  {
    id: "personality",
    label: "性格特质",
    icon: "🌸",
    fields: [
      { key: "personalityTraits", label: "性格描述", placeholder: "如：温柔内向，偶尔小任性", multiline: true },
      { key: "personalityLikes", label: "喜好", placeholder: "如：甜食/雨声/猫" },
      { key: "personalityDislikes", label: "厌恶", placeholder: "如：吵闹/被欺骗" },
      { key: "personalityValues", label: "价值观", placeholder: "如：真诚最重要" },
    ],
  },
  {
    id: "habits",
    label: "行为习惯",
    icon: "🌙",
    fields: [
      { key: "habitsCatchphrase", label: "口头禅", placeholder: "如：嗯...让我想想" },
      { key: "habitsGestures", label: "小动作", placeholder: "如：说话时爱戳手指" },
      { key: "habitsSchedule", label: "作息倾向", placeholder: "如：夜猫子" },
      { key: "habitsHobbies", label: "兴趣爱好", placeholder: "如：摄影/弹吉他" },
    ],
  },
  {
    id: "speech",
    label: "说话风格",
    icon: "💬",
    fields: [
      { key: "speechTone", label: "语气基调", placeholder: "如：轻柔撒娇" },
      { key: "speechVocab", label: "用词习惯", placeholder: "如：爱用叠词" },
      { key: "speechPattern", label: "句式偏好", placeholder: "如：短句分条" },
      { key: "speechForbidden", label: "禁用词/行为", placeholder: "如：不使用书面语" },
      {
        key: "speechExamples",
        label: "示例对话",
        placeholder: "用户：在吗\n角色：在呢，怎么啦",
        multiline: true,
      },
    ],
  },
  {
    id: "worldview",
    label: "世界观/背景",
    icon: "🌍",
    fields: [
      { key: "worldSetting", label: "世界设定", placeholder: "如：现代都市/古代江湖/异世界", multiline: true },
      { key: "worldEra", label: "时间线", placeholder: "如：2024年春天" },
      { key: "worldLocation", label: "地点", placeholder: "如：南方某沿海城市" },
      { key: "worldRules", label: "世界规则", placeholder: "如：存在魔法/无超自然", multiline: true },
      { key: "worldPlot", label: "当前剧情", placeholder: "如：两人刚重逢", multiline: true },
    ],
  },
];

/**
 * LLM API 配置。
 * apiKey 不在此接口（内存驻留，不持久化）。
 *
 * adapter 字段标识"协议族"：
 * - openai: OpenAI 兼容协议（含 DeepSeek/Kimi/通义千问/硅基流动等）
 * - claude: Anthropic 原生协议
 * - mock: 离线测试
 *
 * provider 字段标识"供应商预设"，用于填充 baseURL/model 默认值。
 */
export interface IApiConfig {
  /** 适配器协议族。 */
  readonly adapter: "openai" | "claude" | "mock";
  /** 供应商预设。 */
  readonly provider: ApiProvider;
  /** API base URL。 */
  readonly baseURL: string;
  /** 模型名。 */
  readonly model: string;
  /** 温度参数。 */
  readonly temperature: number;
  /** 最大生成 token 数。 */
  readonly maxTokens: number;
  /** 最大重试次数。 */
  readonly maxRetries: number;
  /** 请求超时（ms）。 */
  readonly timeoutMs: number;
}

/**
 * API 供应商预设。
 * - openai-compatible 系列均走 OpenAIAdapter，仅 baseURL/model 默认值不同。
 * - claude 走 ClaudeAdapter。
 * - custom 由用户填写 baseURL/model。
 */
export type ApiProvider =
  | "mock"
  | "openai"
  | "claude"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "siliconflow"
  | "gemini"
  | "zhipu"
  | "ernie"
  | "hunyuan"
  | "yi"
  | "openrouter"
  | "groq"
  | "together"
  | "fireworks"
  | "agnes"
  | "custom";

/**
 * 供应商预设配置。
 */
export interface IProviderPreset {
  readonly id: ApiProvider;
  readonly label: string;
  readonly adapter: IApiConfig["adapter"];
  readonly baseURL: string;
  readonly model: string;
  readonly apiKeyPlaceholder: string;
  readonly helpUrl?: string;
  /**
   * 该供应商建议的请求超时（ms）。
   * 推理型 / 免费额度的服务端首字延迟可能远超默认 30s，实测 Agnes
   * 一次带思考的回复要 30s 以上，超时会被判定为失败并触发降级。
   */
  readonly timeoutMs?: number;
}

/**
 * 供应商预设列表。
 */
export const PROVIDER_PRESETS: ReadonlyArray<IProviderPreset> = [
  {
    id: "mock",
    label: "Mock（离线测试）",
    adapter: "mock",
    baseURL: "",
    model: "mock-1",
    apiKeyPlaceholder: "无需填写",
  },
  {
    id: "openai",
    label: "OpenAI",
    adapter: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "claude",
    label: "Anthropic Claude",
    adapter: "claude",
    baseURL: "https://api.anthropic.com",
    model: "claude-3-5-haiku-20241022",
    apiKeyPlaceholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/",
  },
  {
    id: "deepseek",
    label: "DeepSeek 深度求索",
    adapter: "openai",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://platform.deepseek.com/",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    adapter: "openai",
    baseURL: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://platform.moonshot.cn/",
  },
  {
    id: "qwen",
    label: "通义千问 (Qwen)",
    adapter: "openai",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-turbo",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://dashscope.console.aliyun.com/",
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    adapter: "openai",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://cloud.siliconflow.cn/",
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI 兼容)",
    adapter: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-1.5-flash",
    apiKeyPlaceholder: "AIza...",
    helpUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    adapter: "openai",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    apiKeyPlaceholder: "xxx.xxx",
    helpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "ernie",
    label: "百度文心一言 (ERNIE)",
    adapter: "openai",
    baseURL: "https://qianfan.baidubce.com/v2",
    model: "ernie-speed-8k",
    apiKeyPlaceholder: "bv-...",
    helpUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    adapter: "openai",
    baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
    model: "hunyuan-lite",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  {
    id: "yi",
    label: "零一万物 (Yi)",
    adapter: "openai",
    baseURL: "https://api.lingyiwanwu.com/v1",
    model: "yi-lightning",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://platform.lingyiwanwu.com/apikeys",
  },
  {
    id: "openrouter",
    label: "OpenRouter (聚合 200+ 模型)",
    adapter: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    apiKeyPlaceholder: "sk-or-...",
    helpUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq (超低延迟)",
    adapter: "openai",
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.1-8b-instant",
    apiKeyPlaceholder: "gsk_...",
    helpUrl: "https://console.groq.com/keys",
  },
  {
    id: "together",
    label: "Together AI",
    adapter: "openai",
    baseURL: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3-8b-chat-hf",
    apiKeyPlaceholder: "sk-...",
    helpUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    adapter: "openai",
    baseURL: "https://api.fireworks.ai/inference/v1",
    model: "llama-v3-8b-instruct",
    apiKeyPlaceholder: "fw_...",
    helpUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "agnes",
    label: "Agnes AI (免费)",
    adapter: "openai",
    baseURL: "https://apihub.agnes-ai.com/v1",
    model: "agnes-2.5-flash",
    apiKeyPlaceholder: "agnes-...",
    helpUrl: "https://platform.agnes-ai.com/",
    // 实测：简单回复 3~10s，带思考的长回复会超过 30s
    timeoutMs: 90000,
  },
  {
    id: "custom",
    label: "自定义 (OpenAI 兼容)",
    adapter: "openai",
    baseURL: "",
    model: "",
    apiKeyPlaceholder: "sk-...",
  },
];
