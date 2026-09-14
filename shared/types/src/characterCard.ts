/**
 * @file characterCard.ts
 * 角色卡（单角色导入导出）契约。
 *
 * 与「全量备份」的区别：备份是为了不丢数据，角色卡是为了**复用与分享**——
 * 一张卡片自包含角色档案 + 它绑定的人设模板，可以直接发给别人，
 * 或者在同一台机器上复制一份改着玩。
 *
 * 刻意**不含记忆与聊天记录**：记忆里存的多半是"关于用户本人的事"
 * （过敏、住址、工作），跟着角色卡传播出去并不合适。
 */

import type { ICharacterProfile } from "./character";
import type { IPromptTemplate } from "./session";

/** 角色卡文件标识。 */
export const CHARACTER_CARD_FORMAT = "zhichi-character";

/** 角色卡结构版本。 */
export const CHARACTER_CARD_VERSION = 1;

/** 一张角色卡。 */
export interface ICharacterCard {
  readonly format: string;
  readonly version: number;
  /** 导出时间（ms）。 */
  readonly exportedAt: number;
  /** 角色档案。 */
  readonly character: ICharacterProfile;
  /** 角色绑定的人设模板（自包含，导入方不需要再去别处找）。 */
  readonly promptTemplate?: IPromptTemplate;
}

/** 导入失败原因。 */
export type CharacterCardParseError =
  | "empty"
  | "not-json"
  | "not-card"
  | "version-too-new"
  | "bad-character";

/** 解析结果。 */
export type CharacterCardParseResult =
  | { readonly ok: true; readonly card: ICharacterCard }
  | { readonly ok: false; readonly error: CharacterCardParseError };
