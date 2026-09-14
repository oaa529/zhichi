/**
 * @file characterCardRunner.ts
 * 角色卡的组装层：读写 store、触发下载、把导入结果落库。
 *
 * 纯逻辑在 core/backup/CharacterCard.ts，这里只负责"接线"。
 */

import type {
  CharacterCardParseError,
  ICharacterCard,
  ILoreEntry,
} from "@wechat-rp/shared-types";
import {
  buildCharacterCard,
  instantiateCharacterCard,
  parseCharacterCard,
  parseTavernCard,
  serializeCharacterCard,
  tavernCardToCharacterCard,
  type TavernCardParseError,
} from "@wechat-rp/core";
import { readImageAsDataUrl, useSessionStore } from "@wechat-rp/ui-wechat";
import { downloadTextFile, sanitizeFileName } from "./download";

/** 角色卡操作结果（界面据此提示）。 */
export interface ICharacterCardResult {
  readonly ok: boolean;
  readonly message: string;
}

/** 解析失败原因 → 给用户看的中文提示。 */
const ERROR_MESSAGES: Record<CharacterCardParseError, string> = {
  empty: "文件是空的，没有可导入的角色卡。",
  "not-json": "这个文件不是合法的 JSON，可能已损坏。",
  "not-card": "这不是「咫尺」导出的角色卡。",
  "version-too-new": "角色卡来自更新版本的应用，当前版本读不了。",
  "bad-character": "角色卡里的角色信息不完整（缺 ID 或名字）。",
};

/** 社区卡解析失败原因 → 中文提示。 */
const TAVERN_ERROR_MESSAGES: Record<TavernCardParseError, string> = {
  empty: "文件是空的，没有可导入的角色卡。",
  "no-card-chunk": "这张 PNG 里没有角色卡数据（可能只是普通图片）。",
  "not-tavern-card": "这不是可识别的角色卡。",
};

/**
 * 导出单个角色为角色卡文件。
 *
 * 卡片自包含角色绑定的人设模板，但不含记忆与聊天记录
 * （那些多半是"关于用户本人的事"，不该跟着卡片传播）。
 */
export function exportCharacterCardToFile(
  characterId: string,
  now: number = Date.now(),
): ICharacterCardResult {
  const state = useSessionStore.getState();
  const character = state.characters[characterId];
  if (!character) return { ok: false, message: "找不到这个角色。" };

  const template = character.promptTemplateId
    ? state.promptTemplates[character.promptTemplateId] ?? null
    : null;

  try {
    const text = serializeCharacterCard(
      buildCharacterCard(character, template, now),
    );
    downloadTextFile(
      text,
      `zhichi-card-${sanitizeFileName(character.displayName)}.json`,
    );
  } catch (error) {
    console.warn("[characterCard] 导出失败：", error);
    return { ok: false, message: "导出失败，请检查浏览器是否拦截了下载。" };
  }

  return {
    ok: true,
    message: `已导出角色卡「${character.displayName}」${
      template ? "（含人设模板）" : ""
    }`,
  };
}

/**
 * 落库一张（已解析好的）角色卡。
 *
 * 导入**永远是新增**：角色 ID 重新生成、重名加后缀、模板相同则复用，
 * 不会覆盖或改动任何已有角色。
 */
function storeCharacterCard(
  card: ICharacterCard,
  note?: string,
  loreEntries?: ReadonlyArray<ILoreEntry>,
): ICharacterCardResult {
  try {
    const state = useSessionStore.getState();
    const instantiated = instantiateCharacterCard(card, {
      takenNames: Object.values(state.characters).map((c) => c.displayName),
      existingTemplates: state.promptTemplates,
    });

    if (instantiated.template) {
      state.createPromptTemplate(instantiated.template);
    }
    state.createCharacter(instantiated.character);
    // 社区卡里的世界书条目跟着角色走（按角色 ID 归属）
    if (loreEntries && loreEntries.length > 0) {
      state.setLoreEntries(instantiated.character.id, loreEntries);
    }

    return {
      ok: true,
      message:
        `已导入角色「${instantiated.character.displayName}」` +
        (instantiated.renamed ? "（原名已存在，自动加了后缀）" : "") +
        (note ? `（${note}）` : ""),
    };
  } catch (error) {
    console.warn("[characterCard] 导入失败：", error);
    return { ok: false, message: "导入过程中出错，已有数据未被修改。" };
  }
}

/** 社区卡转成本项目角色卡时的附加说明。 */
function tavernNote(card: {
  readonly loreEntries: ReadonlyArray<ILoreEntry>;
  readonly specVersion: 1 | 2;
}): string {
  const parts = [`社区卡 V${card.specVersion}`];
  if (card.loreEntries.length > 0) {
    parts.push(`含 ${card.loreEntries.length} 条世界设定`);
  }
  return parts.join("，");
}

/**
 * 从文件导入角色卡。
 *
 * 同时支持两种格式，按内容自动识别、无需用户选择：
 * 1. 「咫尺」自己的角色卡（JSON）
 * 2. 社区角色卡（SillyTavern / TavernAI V1 & V2）——
 *    JSON 或**把卡数据塞进文本块的 PNG**；PNG 版还能顺带把图当头像。
 */
export async function importCharacterCardFile(
  file: File,
): Promise<ICharacterCardResult> {
  const isPng =
    file.type === "image/png" || /\.png$/i.test(file.name);

  // ---------- PNG 社区卡 ----------
  if (isPng) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return { ok: false, message: "读取文件失败，请重试。" };
    }

    const parsed = parseTavernCard({ bytes });
    if (!parsed.ok) {
      return { ok: false, message: TAVERN_ERROR_MESSAGES[parsed.error] };
    }

    // 头像内联保存：卡片自带的那张图就是角色形象，没必要让用户再传一次
    let avatarUrl = "";
    try {
      avatarUrl = await readImageAsDataUrl(file, 256);
    } catch (error) {
      console.warn("[characterCard] PNG 头像处理失败，改为无头像导入：", error);
    }

    return storeCharacterCard(
      tavernCardToCharacterCard(parsed.card, { avatarUrl }),
      tavernNote(parsed.card),
      parsed.card.loreEntries,
    );
  }

  // ---------- JSON：先当自家卡，再当社区卡 ----------
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: "读取文件失败，请重试。" };
  }

  const ours = parseCharacterCard(text);
  if (ours.ok) return storeCharacterCard(ours.card);

  const tavern = parseTavernCard({ text });
  if (tavern.ok) {
    return storeCharacterCard(
      tavernCardToCharacterCard(tavern.card),
      tavernNote(tavern.card),
      tavern.card.loreEntries,
    );
  }

  // 都是 JSON 解析失败时，优先报「咫尺卡」的口径更贴近用户直觉
  if (ours.error === "not-json" && tavern.error !== "not-tavern-card") {
    return { ok: false, message: ERROR_MESSAGES["not-json"] };
  }
  return {
    ok: false,
    message:
      "这不是可识别的角色卡（支持「咫尺」角色卡，以及 SillyTavern / TavernAI 的社区卡）。",
  };
}
