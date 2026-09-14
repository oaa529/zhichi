/**
 * @file TavernCard.ts
 * 社区角色卡（SillyTavern / TavernAI 的 Character Card V1 & V2）解析。
 *
 * 为什么值得做兼容：角色扮演社区里流通的角色卡绝大多数是这个格式，
 * 有现成的 JSON，也有**把 JSON 用 base64 塞进 PNG 文本块**的自带立绘版本。
 * 支持它，等于把社区已有的角色资产直接接进来。
 *
 * 规范来源（SillyTavern 官方仓库引用的社区规范）：
 * - V1：name / description / personality / scenario / first_mes / mes_example
 * - V2：在外层加 `{ spec: "chara_card_v2", data: {…V1 字段, creator_notes,
 *   system_prompt, post_history_instructions, alternate_greetings, character_book,
 *   tags, creator, character_version, extensions } }`
 *
 * 全部为纯函数：不碰 DOM、不碰 store，方便单测。
 */

import {
  type ICharacterProfile,
  type ICharacterCard,
  type ILoreEntry,
  type IPromptTemplate,
} from "@wechat-rp/shared-types";
import { buildCharacterCard } from "../backup/CharacterCard";
import { loreEntriesFromBook } from "../lore/LoreKeeper";

/** PNG 里存放角色卡 JSON 的文本块关键字（V1 规范拼作 "Chara"，读取时不区分大小写）。 */
export const TAVERN_PNG_KEYWORD = "chara";

/** 兼容解析出的社区卡片。字段全部归一化为字符串/数组，缺省为空。 */
export interface ITavernCard {
  /** 卡片规范版本：1 或 2。 */
  readonly specVersion: 1 | 2;
  readonly name: string;
  readonly description: string;
  readonly personality: string;
  readonly scenario: string;
  /** 开场白（第一句话）。 */
  readonly firstMessage: string;
  /** 示例对话原文（含 `<START>` 轮次分隔符）。 */
  readonly messageExamples: string;
  readonly alternateGreetings: ReadonlyArray<string>;
  readonly creatorNotes: string;
  readonly systemPrompt: string;
  readonly postHistoryInstructions: string;
  readonly tags: ReadonlyArray<string>;
  readonly creator: string;
  readonly characterVersion: string;
  /** 内嵌世界书条目（已归一化；空数组表示卡片没带世界书）。 */
  readonly loreEntries: ReadonlyArray<ILoreEntry>;
  /** 内嵌世界书条目数（提示文案用）。 */
  readonly lorebookEntries: number;
}

/** 解析失败原因。 */
export type TavernCardParseError =
  /** 文件是空的。 */
  | "empty"
  /** PNG 里没有角色卡数据块。 */
  | "no-card-chunk"
  /** 既不是 JSON 也不是可识别的社区卡片。 */
  | "not-tavern-card";

export type TavernCardParseResult =
  | {
      readonly ok: true;
      readonly card: ITavernCard;
      /** 数据来源（PNG 卡会顺带带上内嵌图片，可用于头像）。 */
      readonly source: "json" | "png";
    }
  | { readonly ok: false; readonly error: TavernCardParseError };

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取字符串字段（非字符串一律当空串，与规范"缺省为空字符串"一致）。 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 取字符串数组字段。 */
function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

// ---------- PNG 文本块 ----------

const PNG_SIGNATURE: ReadonlyArray<number> = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 大端读取 4 字节无符号整数。 */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

/** 在字节数组里从 from 开始找第一个 0 字节的下标。 */
function indexOfZero(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

/** 解码 PNG 的 tEXt / iTXt 文本块；不认识的类型返回 null。 */
function parsePngTextChunk(
  type: string,
  data: Uint8Array,
  decoder: TextDecoder,
): { keyword: string; text: string } | null {
  const keywordEnd = indexOfZero(data, 0);
  if (keywordEnd <= 0) return null;
  const keyword = decoder.decode(data.subarray(0, keywordEnd));

  if (type === "tEXt") {
    // keyword \0 text（Latin-1；实际内容多为 base64 的 ASCII）
    return { keyword, text: decodeLatin1(data.subarray(keywordEnd + 1)) };
  }

  if (type === "iTXt") {
    // keyword \0 compressionFlag(1) compressionMethod(1) languageTag \0 translatedKeyword \0 text
    const compressionFlag = data[keywordEnd + 1] ?? 0;
    let cursor = keywordEnd + 3;
    const langEnd = indexOfZero(data, cursor);
    if (langEnd < 0) return null;
    cursor = langEnd + 1;
    const translatedEnd = indexOfZero(data, cursor);
    if (translatedEnd < 0) return null;
    cursor = translatedEnd + 1;
    if (compressionFlag === 1) {
      // 压缩的 iTXt 极少见，这里不引入解压依赖，直接跳过
      return null;
    }
    return { keyword, text: decoder.decode(data.subarray(cursor)) };
  }

  return null;
}

/** Latin-1 解码（PNG tEXt 规定使用它）。 */
function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

/**
 * 从 PNG 字节里提取指定关键字的文本块内容（大小写不敏感）。
 *
 * 只做必要的结构校验：签名不对、块长度越界、找不到关键字都返回 null，
 * 不让半个字节流把调用方拖崩。
 */
export function extractPngTextChunk(
  bytes: Uint8Array,
  keyword: string,
): string | null {
  if (bytes.length < 8) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const decoder = new TextDecoder("utf-8");
  const wanted = keyword.toLowerCase();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // 长度越界说明文件被截断
    if (dataEnd + 4 > bytes.length) return null;

    if (type === "tEXt" || type === "iTXt") {
      const chunk = parsePngTextChunk(type, bytes.subarray(dataStart, dataEnd), decoder);
      if (chunk && chunk.keyword.toLowerCase() === wanted) return chunk.text;
    }
    if (type === "IEND") break;

    offset = dataEnd + 4;
  }

  return null;
}

/** base64 → UTF-8 字符串；不是合法 base64 时原样返回（有的实现直接塞 JSON）。 */
function decodeCardPayload(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) return trimmed;
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return trimmed;
  }
}

// ---------- 卡片解析 ----------

/** 判断一个 JSON 对象是否像社区角色卡。 */
function looksLikeTavernCard(value: Record<string, unknown>): boolean {
  if (value.spec === "chara_card_v2" && isRecord(value.data)) return true;
  // V1 没有标识字段，只能按"有名字 + 至少一个有内容的角色字段"判断，
  // 避免把随便一个 {"name": "x"} 的 JSON 当成角色卡。
  if (typeof value.name !== "string") return false;
  return ["description", "personality", "scenario", "first_mes", "mes_example"].some(
    (key) => typeof value[key] === "string" && (value[key] as string).trim() !== "",
  );
}

/** 把归一化后的对象转成 ITavernCard。 */
function normalizeCard(
  source: Record<string, unknown>,
  specVersion: 1 | 2,
): ITavernCard {
  const book = source.character_book;
  const loreEntries = loreEntriesFromBook(book);
  return {
    specVersion,
    name: asString(source.name),
    description: asString(source.description),
    personality: asString(source.personality),
    scenario: asString(source.scenario),
    firstMessage: asString(source.first_mes),
    messageExamples: asString(source.mes_example),
    alternateGreetings: asStringArray(source.alternate_greetings),
    creatorNotes: asString(source.creator_notes),
    systemPrompt: asString(source.system_prompt),
    postHistoryInstructions: asString(source.post_history_instructions),
    tags: asStringArray(source.tags),
    creator: asString(source.creator),
    characterVersion: asString(source.character_version),
    loreEntries,
    lorebookEntries: loreEntries.length,
  };
}

/**
 * 解析社区角色卡：既接受 JSON 文本，也接受 PNG 字节（自动从文本块里取）。
 *
 * 两种输入都走同一套归一化，调用方拿到的结构完全一致。
 */
export function parseTavernCard(input: {
  readonly text?: string;
  readonly bytes?: Uint8Array;
}): TavernCardParseResult {
  let json: string | null = null;
  let source: "json" | "png" = "json";

  if (typeof input.text === "string" && input.text.trim()) {
    json = input.text;
  } else if (input.bytes && input.bytes.length > 0) {
    const chunk = extractPngTextChunk(input.bytes, TAVERN_PNG_KEYWORD);
    if (!chunk) return { ok: false, error: "no-card-chunk" };
    json = decodeCardPayload(chunk);
    source = "png";
  } else {
    return { ok: false, error: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: source === "png" ? "no-card-chunk" : "not-tavern-card" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "not-tavern-card" };
  if (!looksLikeTavernCard(parsed)) return { ok: false, error: "not-tavern-card" };

  // V2：真正的内容在 data 里；V1：内容就在顶层
  const isV2 = parsed.spec === "chara_card_v2" && isRecord(parsed.data);
  const payload = isV2 ? (parsed.data as Record<string, unknown>) : parsed;
  return { ok: true, card: normalizeCard(payload, isV2 ? 2 : 1), source };
}

// ---------- 映射到「咫尺」角色 ----------

/** 映射选项。 */
export interface ITavernCardMappingOptions {
  /** 当前时间（测试可注入）。 */
  readonly now?: number;
  /** 头像（PNG 卡可直接把整张图内联进来）。 */
  readonly avatarUrl?: string;
  /** 用户显示名，用于替换 `{{user}}` / `<USER>`，缺省「我」。 */
  readonly userName?: string;
}

/**
 * 替换社区卡片里的占位符（规范要求大小写不敏感）。
 */
export function substituteCardPlaceholders(
  text: string,
  characterName: string,
  userName: string,
): string {
  return text
    .replace(/\{\{char\}\}/gi, characterName)
    .replace(/<BOT>/gi, characterName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<USER>/gi, userName);
}

/** 把 `<START>` 分段的示例对话整理成项目里"示例对话"字段的写法。 */
export function convertMessageExamples(
  raw: string,
  characterName: string,
  userName: string,
): string {
  const replaced = substituteCardPlaceholders(raw, characterName, userName);
  return replaced
    .split(/<START>/gi)
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** 取描述的首行/首句作为一句话简介。 */
function summarize(description: string, fallback: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  // 先按句末标点切，再按逗号/顿号切一刀——简介字段要短，长了会被界面截断
  const sentence = flat.split(/[。！？.!?]/)[0]?.trim() || flat;
  const clause = sentence.split(/[，,、;；]/)[0]?.trim() ?? "";
  const text = clause.length >= 4 ? clause : sentence;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * 把社区卡片映射成「咫尺」的角色卡（再由 instantiateCharacterCard 分配新 ID）。
 *
 * 字段对应关系：
 * - `description` → 模板「背景故事」，同时抽一句话当角色简介
 * - `personality` → 模板「性格描述」
 * - `scenario`    → 模板「当前剧情节点」
 * - `mes_example` → 模板「示例对话」（few-shot，社区卡片最有效的塑形手段）
 * - `first_mes`   → 角色开场白（新会话第一句话）
 * - `system_prompt` / `post_history_instructions` → 模板「额外补充」
 * - `creator_notes` / `tags` / `creator` 不进入提示词（那是给人类看的元数据）
 */
export function tavernCardToCharacterCard(
  card: ITavernCard,
  options: ITavernCardMappingOptions = {},
): ICharacterCard {
  const now = options.now ?? Date.now();
  const userName = options.userName?.trim() || "我";
  const name = card.name.trim() || "未命名角色";

  const replaceAll = (text: string): string =>
    substituteCardPlaceholders(text, name, userName);

  const extra = [card.systemPrompt, card.postHistoryInstructions]
    .map((part) => part.trim())
    .filter(Boolean)
    .map(replaceAll)
    .join("\n\n");

  const template: IPromptTemplate = {
    id: `tpl-tavern-${now}`,
    name: `${name} · 社区卡`,
    identityName: name,
    identityBackground: replaceAll(card.description).trim(),
    personalityTraits: replaceAll(card.personality).trim(),
    worldPlot: replaceAll(card.scenario).trim(),
    speechExamples: convertMessageExamples(card.messageExamples, name, userName),
    ...(extra ? { content: extra } : {}),
  };

  const greeting = replaceAll(card.firstMessage).trim();
  const character: ICharacterProfile = {
    id: `char-tavern-${now}`,
    displayName: name,
    // 简介同样要替换占位符：卡片里常写成 "{{char}} 是一名……"
    bio: summarize(replaceAll(card.description), `${name}（社区卡导入）`),
    visualMetadata: {
      avatarUrl: options.avatarUrl ?? "",
      sprites: [],
      supportsPinSprite: false,
      defaultSpriteAnchor: "left",
    },
    schedule: {
      wakeTime: "07:30",
      sleepTime: "23:30",
      scheduleEnabled: false,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "drowsy-burst",
    },
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 1,
      fragmentationBias: 0.5,
      hesitationProbability: 0.12,
      typoRate: 0,
      stickerFrequency: 0,
    },
    promptTemplateId: "",
    ...(greeting ? { greeting } : {}),
  };

  return buildCharacterCard(character, template, now);
}
