/**
 * @file backup.ts
 * 数据备份文件契约。
 *
 * 背景：本应用是纯本地自用工具，角色 / 会话 / 消息 / 记忆 / 剧情全部存在
 * 浏览器 IndexedDB 里——清缓存、换浏览器、换机器都会丢。所以提供
 * 「导出成 JSON 文件 / 从 JSON 文件导入」的离线备份能力。
 *
 * 安全约定：备份文件**不含 API Key**（它本来就不落盘，只驻留内存）。
 */

import type { ICharacterProfile } from "./character";
import type { IDigestConfig, IDigestReport, IMemory } from "./memory";
import type { ILoreEntry } from "./lore";
import type { IPlotState } from "./plot";
import type {
  IApiConfig,
  IContact,
  IPromptTemplate,
  IRealtimeAIConfig,
  ISession,
  ISessionRuntimeSnapshot,
  IUserProfile,
} from "./session";

/** 备份文件标识（用于识别文件类型，拒绝导入无关 JSON）。 */
export const BACKUP_FORMAT = "zhichi-backup";

/** 备份文件结构版本。字段不兼容变更时递增。 */
export const BACKUP_VERSION = 1;

/**
 * 备份内容，与 sessionStore 的持久化字段一一对应。
 *
 * `sessionRuntimes` 是全量消息的单一来源：活跃会话的运行时快照也会
 * 随消息变化实时写入，因此不需要额外保存 chatStore 的消息数组。
 */
export interface IBackupPayload {
  readonly sessions: Record<string, ISession>;
  readonly activeSessionId: string | null;
  readonly sessionRuntimes: Record<string, ISessionRuntimeSnapshot>;
  readonly drafts: Record<string, string>;
  readonly contacts: Record<string, IContact>;
  readonly characters: Record<string, ICharacterProfile>;
  readonly promptTemplates: Record<string, IPromptTemplate>;
  /** API 配置（不含 Key）。 */
  readonly apiConfig: IApiConfig;
  readonly realtimeAIConfig: IRealtimeAIConfig;
  /** 长期记忆，按角色 ID 归属。 */
  readonly memories: Record<string, ReadonlyArray<IMemory>>;
  /** 世界书条目，按角色 ID 归属（社区卡导入或手动添加）。 */
  readonly loreEntries: Record<string, ReadonlyArray<ILoreEntry>>;
  /** 剧情状态卡，按会话 ID 归属。 */
  readonly plotStates: Record<string, IPlotState>;
  readonly digestCursors: Record<string, number>;
  readonly digestConfig: IDigestConfig;
  /**
   * 用户人设（"关于你"）。
   *
   * 可选字段：老备份文件里没有它。**这是用户自己写的内容**——
   * 早先忘了带进备份，导出再导入就整段丢了（角色从此不知道在跟谁说话）。
   */
  readonly userProfile?: IUserProfile;
  /**
   * 整理账本（每会话**最近一次**整理改了什么）。
   *
   * 可选字段：老备份里没有它。属于"派生但用户看得见"的历史记录。
   */
  readonly digestReports?: Record<string, IDigestReport>;
}

/** 备份统计（导出回执与导入预览用）。 */
export interface IBackupCounts {
  readonly sessions: number;
  readonly characters: number;
  readonly memories: number;
  readonly messages: number;
}

/** 备份文件顶层结构。 */
export interface IBackupFile {
  readonly format: string;
  readonly version: number;
  /** 导出时间（ms）。 */
  readonly exportedAt: number;
  readonly counts: IBackupCounts;
  readonly data: IBackupPayload;
}

/** 导入失败原因（用于给出可读提示）。 */
export type BackupParseError =
  /** 文件内容为空。 */
  | "empty"
  /** 不是合法 JSON。 */
  | "not-json"
  /** 是 JSON，但不是本应用的备份文件。 */
  | "not-backup"
  /** 备份文件版本高于当前应用支持的版本。 */
  | "version-too-new"
  /** 缺少 data 字段或结构不可用。 */
  | "bad-payload";

/** 解析结果（成功携带归一化后的备份，失败携带原因）。 */
export type BackupParseResult =
  | { readonly ok: true; readonly file: IBackupFile }
  | { readonly ok: false; readonly error: BackupParseError };
