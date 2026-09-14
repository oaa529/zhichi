/**
 * @file CharacterCard.ts
 * 角色卡：构造 / 序列化 / 容错解析 / 落库前的实例化。
 * 全部为纯函数——文件读写与 store 落库由组装层负责。
 */

import {
  CHARACTER_CARD_FORMAT,
  CHARACTER_CARD_VERSION,
  type CharacterCardParseResult,
  type ICharacterCard,
  type ICharacterProfile,
  type IPromptTemplate,
} from "@wechat-rp/shared-types";

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 构造角色卡（template 为 null 表示该角色没绑人设模板）。 */
export function buildCharacterCard(
  character: ICharacterProfile,
  template: IPromptTemplate | null,
  now: number = Date.now(),
): ICharacterCard {
  return {
    format: CHARACTER_CARD_FORMAT,
    version: CHARACTER_CARD_VERSION,
    exportedAt: now,
    character,
    ...(template ? { promptTemplate: template } : {}),
  };
}

/** 实例化选项。 */
export interface IInstantiateCardOptions {
  /** 已占用的角色显示名（用于避免重名，保持通讯录可辨认）。 */
  readonly takenNames?: ReadonlyArray<string>;
  /** 已有模板（内容完全一致时复用，不重复建同款）。 */
  readonly existingTemplates?: Record<string, IPromptTemplate>;
  /** 当前时间（测试可注入）。 */
  readonly now?: number;
  /** ID 生成器（测试可注入）。 */
  readonly idFactory?: () => string;
}

/** 实例化结果。 */
export interface IInstantiatedCard {
  readonly character: ICharacterProfile;
  /** 需要新建的模板（复用已有模板、或卡片没带模板时为 null）。 */
  readonly template: IPromptTemplate | null;
  /** 显示名是否因为重名被改过。 */
  readonly renamed: boolean;
}

/** 重名时依次尝试：小明 → 小明（导入） → 小明（导入 2） … */
function uniqueName(
  base: string,
  taken: ReadonlySet<string>,
): { name: string; renamed: boolean } {
  if (!taken.has(base)) return { name: base, renamed: false };
  const first = `${base}（导入）`;
  if (!taken.has(first)) return { name: first, renamed: true };
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}（导入 ${i}）`;
    if (!taken.has(candidate)) return { name: candidate, renamed: true };
  }
  return { name: `${base}（导入 ${Date.now()}）`, renamed: true };
}

/**
 * 把卡片变成"可以落库"的角色与模板。
 *
 * 导入**永远是新增**，不会覆盖已有角色：
 * 角色 ID 重新生成（避免撞掉别人的角色）；显示名重名时加后缀
 * （避免通讯录里出现两个一模一样的名字）；模板内容与已有模板完全相同时
 * 直接复用（不堆一堆同款模板）。
 */
export function instantiateCharacterCard(
  card: ICharacterCard,
  options: IInstantiateCardOptions = {},
): IInstantiatedCard {
  const now = options.now ?? Date.now();
  const idFactory =
    options.idFactory ??
    (() => `char-${now}-${Math.random().toString(36).slice(2, 8)}`);

  const taken = new Set(options.takenNames ?? []);
  const { name, renamed } = uniqueName(card.character.displayName.trim(), taken);
  // 先分配角色 ID，再分配模板 ID——顺序固定，测试与日志都好读
  const characterId = idFactory();

  const existingTemplates = options.existingTemplates ?? {};
  let template: IPromptTemplate | null = null;
  let promptTemplateId = "";

  if (card.promptTemplate) {
    const incoming = card.promptTemplate;
    const reused = existingTemplates[incoming.id];
    if (reused && JSON.stringify(reused) === JSON.stringify(incoming)) {
      // 完全同一份模板：直接复用，避免每导入一次就多一份副本
      promptTemplateId = reused.id;
    } else {
      template = { ...incoming, id: idFactory() };
      promptTemplateId = template.id;
    }
  }

  return {
    character: {
      ...card.character,
      id: characterId,
      displayName: name,
      promptTemplateId,
    },
    template,
    renamed,
  };
}

/** 序列化为可读 JSON（缩进方便肉眼检查与手工改）。 */
export function serializeCharacterCard(card: ICharacterCard): string {
  return JSON.stringify(card, null, 2);
}

/**
 * 容错解析角色卡文本。
 * 逐层校验：空内容 → JSON 语法 → 文件标识 → 版本 → 角色档案基本字段。
 */
export function parseCharacterCard(raw: string): CharacterCardParseResult {
  if (!raw || !raw.trim()) return { ok: false, error: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "not-card" };
  if (parsed.format !== CHARACTER_CARD_FORMAT) {
    return { ok: false, error: "not-card" };
  }

  const version = parsed.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return { ok: false, error: "not-card" };
  }
  if (version > CHARACTER_CARD_VERSION) {
    return { ok: false, error: "version-too-new" };
  }

  const character = parsed.character;
  // 只校验"没有它这个角色就没法用"的字段，其余交给默认值兜底
  if (!isRecord(character)) return { ok: false, error: "bad-character" };
  if (typeof character.id !== "string" || !character.id) {
    return { ok: false, error: "bad-character" };
  }
  if (typeof character.displayName !== "string" || !character.displayName.trim()) {
    return { ok: false, error: "bad-character" };
  }

  const exportedAt =
    typeof parsed.exportedAt === "number" && Number.isFinite(parsed.exportedAt)
      ? parsed.exportedAt
      : 0;

  return {
    ok: true,
    card: {
      format: CHARACTER_CARD_FORMAT,
      version,
      exportedAt,
      character: character as unknown as ICharacterProfile,
      ...(isRecord(parsed.promptTemplate)
        ? { promptTemplate: parsed.promptTemplate as unknown as IPromptTemplate }
        : {}),
    },
  };
}
