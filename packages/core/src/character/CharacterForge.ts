/**
 * @file CharacterForge.ts
 * 角色卡 AI 生成：把用户的一句话想法扩写成**能直接开演**的角色设定草稿。
 *
 * 为什么值得做：面对空白编辑器，多数人写不出好的人设——
 * 要么堆形容词（"温柔善良"），要么写不出示例对话。而后者恰恰是社区公认
 * 最能定住语气的塑形手段（本项目的人设模板也有 speechExamples 字段）。
 *
 * 这里只负责"构造指令 + 解析结果 + 拼成模板文本"，LLM 调用在组装层。
 * 纯函数，可直接单测。
 */

import type { CharacterArchetype } from "@wechat-rp/shared-types";

/** 生成出来的角色草稿（还没落库，字段与编辑器表单一一对应）。 */
export interface ICharacterDraft {
  readonly displayName: string;
  readonly bio: string;
  readonly archetype: CharacterArchetype;
  readonly background: string;
  readonly personality: string;
  readonly speechStyle: string;
  readonly worldSetting: string;
  /** 开场白：新会话里角色说的第一句话。 */
  readonly greeting: string;
  /** 示例对话（"用户：… / 角色：…"两轮）。 */
  readonly examples: string;
}

/** 允许的性格原型（与角色编辑器的六个预设一致）。 */
export const DRAFT_ARCHETYPES: ReadonlyArray<CharacterArchetype> = [
  "energetic",
  "gentle",
  "serious",
  "playful",
  "reserved",
  "night-owl",
];

/** 描述长度限制：太短生成不出东西，太长是用户在写小说。 */
export const MIN_DESCRIPTION_CHARS = 2;
export const MAX_DESCRIPTION_CHARS = 300;

/** 各字段长度上限：模型偶尔会写超长，落库前先收口。 */
const FIELD_LIMITS = {
  bio: 60,
  background: 600,
  personality: 400,
  speechStyle: 300,
  worldSetting: 300,
  greeting: 200,
  examples: 800,
} as const;

/** 生成用的 system 指令。 */
const GEN_SYSTEM_PROMPT = [
  "你是一位角色设定师，为文字角色扮演游戏写「角色卡」。",
  "用户会给你一句角色想法，你要把它扩写成一个有细节、能立刻开演的角色。",
  "只输出一个 JSON 对象，不要输出解释、前言，也不要在 JSON 之外写任何文字。",
  "JSON 结构：",
  '{"name":"角色名（中文 2~4 字，不要用「小明」这类占位名）",',
  ' "bio":"一句话简介（20 字以内）",',
  ' "archetype":"energetic|gentle|serious|playful|reserved|night-owl 之一",',
  ' "background":"身份与背景（80~150 字：年龄、职业、与用户的关系、一两个具体细节）",',
  ' "personality":"性格（40~80 字：写具体行为倾向，不要堆形容词）",',
  ' "speechStyle":"说话风格（30~60 字：句长、语气、口头禅这类可模仿的特征）",',
  ' "worldSetting":"所处的世界与场景（20~50 字；用户没说就写现代都市日常）",',
  ' "greeting":"角色对用户说的第一句话（1~2 句，符合性格，不要自我介绍式开场）",',
  ' "examples":"两轮示例对话（每轮两行，格式固定为「用户：…」与「角色名：…」，不要写成别的署名）"}',
  "写作要求：",
  "1. 具体优于华丽：写「袖口总卷到手肘」比写「气质优雅」有用得多。",
  "2. 不要写「她是一个温柔善良的女孩」这类没有信息量的句子。",
  "3. 示例对话要口语化、有停顿感，像微信聊天，不要写成小说对白。",
  "4. archetype 只能从给定选项里选一个；其余字段都用中文。",
  "5. 不要在文本里出现 {{char}}、{{user}} 这类占位符，直接写具体称呼。",
].join("\n");

/** 构造生成请求的 system / user 文本。 */
export function buildCharacterGenPrompt(
  description: string,
  userName = "我",
): { readonly system: string; readonly user: string } {
  const trimmed = description.trim();
  const user = [
    `角色想法：${trimmed}`,
    `用户希望被称呼为：${userName}`,
    "",
    "请输出角色卡 JSON。",
  ].join("\n");
  return { system: GEN_SYSTEM_PROMPT, user };
}

/**
 * 从**半截**的流式输出里尽量把角色名抠出来。
 *
 * 用在生成过程的进度提示上：模型按指令先写 `"name"`，
 * 于是"正在生成「林夏知」…"能在第几秒就显示出来，而不是干等半分钟。
 * 只认写到闭合引号的名字（半截名字不显示，免得闪烁）。
 */
export function extractDraftName(partial: string): string | null {
  const match = /"name"\s*:\s*"([^"\\]{1,16})"/.exec(partial);
  return match?.[1]?.trim() || null;
}

/** 从原始输出里提取 JSON 文本（剥离围栏、截取首尾花括号）。 */
function extractJsonText(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 按上限裁剪（超出加省略号）。 */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 简介兜底：从背景里取第一小句。 */
function bioFromBackground(background: string): string {
  const flat = background.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = flat.split(/[。！？.!?]/)[0]?.trim() || flat;
  const clause = sentence.split(/[，,、;；]/)[0]?.trim() ?? "";
  const text = clause.length >= 4 ? clause : sentence;
  return clamp(text, FIELD_LIMITS.bio);
}

/**
 * 容错解析生成结果；结构不可用时返回 null（调用方据此提示"再试一次"）。
 *
 * 容错点：markdown 围栏、前后废话、字段缺失、archetype 不在白名单、
 * 超长文本——都按"能救就救"处理，只有连名字和内容都没有才判失败。
 */
export function parseCharacterGenResult(
  raw: string | null | undefined,
): ICharacterDraft | null {
  if (!raw) return null;
  const jsonText = extractJsonText(raw);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const displayName = asString(parsed.name);
  const background = clamp(asString(parsed.background), FIELD_LIMITS.background);
  const personality = clamp(asString(parsed.personality), FIELD_LIMITS.personality);
  const speechStyle = clamp(asString(parsed.speechStyle), FIELD_LIMITS.speechStyle);
  const worldSetting = clamp(asString(parsed.worldSetting), FIELD_LIMITS.worldSetting);
  const greeting = clamp(asString(parsed.greeting), FIELD_LIMITS.greeting);
  const examples = clamp(asString(parsed.examples), FIELD_LIMITS.examples);
  const bio =
    clamp(asString(parsed.bio), FIELD_LIMITS.bio) || bioFromBackground(background);

  // 至少要有一段能用的内容；只有名字（或干脆啥都没有）说明这次生成白跑了
  const hasContent = Boolean(
    background || personality || speechStyle || greeting || examples,
  );
  if (!hasContent) return null;

  const archetypeRaw = asString(parsed.archetype) as CharacterArchetype;
  const archetype = DRAFT_ARCHETYPES.includes(archetypeRaw)
    ? archetypeRaw
    : "gentle";

  return {
    displayName: displayName || "未命名角色",
    bio,
    archetype,
    background,
    personality,
    speechStyle,
    worldSetting,
    greeting,
    examples,
  };
}

/**
 * 把草稿拼成模板正文（填进角色编辑器的「提示词」字段）。
 *
 * 空字段直接省略——留一堆空标题只会干扰模型。
 */
export function formatDraftAsPromptText(draft: ICharacterDraft): string {
  const blocks: string[] = [];
  if (draft.background) blocks.push(`【身份背景】${draft.background}`);
  if (draft.personality) blocks.push(`【性格】${draft.personality}`);
  if (draft.speechStyle) blocks.push(`【说话风格】${draft.speechStyle}`);
  if (draft.worldSetting) blocks.push(`【世界观】${draft.worldSetting}`);
  if (draft.examples) {
    blocks.push(
      `【示例对话】（模仿语气与节奏，不要照抄内容）\n${draft.examples}`,
    );
  }
  return blocks.join("\n\n");
}
