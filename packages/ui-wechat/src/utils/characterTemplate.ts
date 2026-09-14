/**
 * @file characterTemplate.ts
 * 角色编辑器与提示词模板之间的桥接。
 *
 * 背景：角色编辑器里的"提示词"输入此前从未被保存——保存角色时直接丢弃，
 * 同时把 `promptTemplateId` 指向一个并不存在的模板（`tpl-<archetype>`），
 * 导致用户在编辑器里写的人设既没落库、也没注入对话。
 *
 * 现在：每个角色至多拥有一个专属模板（id 由角色 ID 派生，稳定且唯一），
 * 内容为空时不创建模板并解绑 promptTemplateId。
 */

import type { IPromptTemplate } from "@wechat-rp/shared-types";

/** 角色专属提示词模板的 ID（由角色 ID 派生，编辑时保持稳定）。 */
export function resolveCharacterTemplateId(characterId: string): string {
  return `tpl-char-${characterId}`;
}

/**
 * 由编辑器输入构建角色专属模板。
 *
 * @param characterId 角色 ID
 * @param displayName 角色显示名（用于模板名）
 * @param content 用户填写的提示词
 * @returns 内容为空时返回 null（调用方据此解绑）
 */
export function buildCharacterTemplate(
  characterId: string,
  displayName: string,
  content: string,
): IPromptTemplate | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    id: resolveCharacterTemplateId(characterId),
    name: `${displayName.trim() || "角色"} 的人设`,
    content: trimmed,
    variables: [],
  };
}
