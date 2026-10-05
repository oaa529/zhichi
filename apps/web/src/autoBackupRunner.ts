/**
 * @file autoBackupRunner.ts
 * 自动备份编排器：定时把当前数据快照存进浏览器本地（IndexedDB），
 * 按保留份数裁剪；支持列出 / 下载 / 恢复 / 删除。
 *
 * 与手动备份的分工：
 * - 手动导出（backupRunner.ts）→ 下载成 JSON 文件，防"换机器 / 清缓存"；
 * - 自动备份（本文件）→ 留在同一台设备的 IndexedDB 里，防"数据被写坏 /
 *   误删 / 升级事故"。它防不了"清缓存"（那会连快照一起清掉），
 *   所以设置面板里仍提醒定期做一次手动导出。
 *
 * 安全：快照内容与手动备份完全一致（**不含 API Key**）。
 *
 * 职责划分：
 * - core/backup/AutoBackup.ts —— 纯函数：到期判定 / 保留裁剪
 * - 本文件 —— 读写存储、触发、恢复、下载
 *
 * 存储抽象：默认走 core 的 ChatStorage（IndexedDB），测试注入内存假件。
 */

import type {
  IAutoBackupConfig,
  IAutoBackupSnapshotMeta,
  IBackupCounts,
} from "@wechat-rp/shared-types";
import {
  buildBackup,
  clampRetentionCount,
  getItem,
  isAutoBackupDue,
  parseBackup,
  pruneAutoBackupSnapshots,
  removeItem,
  serializeBackup,
  setItem,
} from "@wechat-rp/core";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import { downloadTextFile } from "./download";
import { readLocalSnapshot, restoreFromBackupText } from "./backupRunner";
import type { IImportResult } from "./backupRunner";

/** 快照索引的存储 key（只放元数据，正文单独存）。 */
const INDEX_KEY = "auto-backup:index";
/** 快照正文的 key 前缀（后缀为快照 id）。 */
const SNAPSHOT_KEY_PREFIX = "auto-backup:snapshot:";
/** 最近一次"手动导出成文件"的时间（用于提醒：该换台机器存一份了）。 */
const LAST_MANUAL_EXPORT_KEY = "auto-backup:lastManualExportAt";

/** 可注入的存储接口（测试用内存假件，生产走 ChatStorage）。 */
export interface IAutoBackupStorage {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** 生产默认：core 的 ChatStorage（IndexedDB，隐私模式下静默失败）。 */
export const defaultAutoBackupStorage: IAutoBackupStorage = {
  getItem,
  setItem,
  removeItem,
};

/** 当前使用的存储实例（测试可替换）。 */
let storage: IAutoBackupStorage = defaultAutoBackupStorage;

/** 替换存储实现（仅测试用）。 */
export function __setAutoBackupStorage(next: IAutoBackupStorage): void {
  storage = next;
}

/** 恢复默认存储（仅测试用）。 */
export function __resetAutoBackupStorage(): void {
  storage = defaultAutoBackupStorage;
}

function snapshotKey(id: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${id}`;
}

/** 从 store 读取当前自动备份配置（归一化兜底）。 */
export function getAutoBackupConfig(): IAutoBackupConfig {
  return useSessionStore.getState().autoBackupConfig;
}

/**
 * 列出全部快照（按时间倒序，新的在前）。
 *
 * 只读索引，不读正文——长会话的备份可能有几 MB，列出不该把它们全加载进来。
 * 索引本身是外部输入，结构不对就按空列表处理（只损失快照列表，不炸界面）。
 */
export async function listAutoBackups(): Promise<ReadonlyArray<IAutoBackupSnapshotMeta>> {
  const raw = await storage.getItem<unknown>(INDEX_KEY);
  if (!Array.isArray(raw)) return [];
  const metas: IAutoBackupSnapshotMeta[] = [];
  for (const item of raw) {
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as IAutoBackupSnapshotMeta).id === "string" &&
      typeof (item as IAutoBackupSnapshotMeta).at === "number" &&
      typeof (item as IAutoBackupSnapshotMeta).sizeBytes === "number"
    ) {
      metas.push(item as IAutoBackupSnapshotMeta);
    }
  }
  return metas.sort((a, b) => b.at - a.at);
}

/** 当前是否有值得备份的数据（全新安装的空白应用不产生空快照）。 */
export function hasBackupData(counts: IBackupCounts): boolean {
  return counts.characters > 0 || counts.sessions > 0;
}

/**
 * 执行一次自动备份（内部实现）。
 *
 * @param now 当前时间（测试注入）
 * @param force 为 true 时忽略到期判定（"立即备份"按钮）；仍跳过空数据
 */
async function writeSnapshot(now: number): Promise<IAutoBackupSnapshotMeta> {
  const file = buildBackup(readLocalSnapshot(), now);
  const text = serializeBackup(file);
  const meta: IAutoBackupSnapshotMeta = {
    id: String(now),
    at: now,
    sizeBytes: text.length,
    counts: file.counts,
  };

  await storage.setItem(snapshotKey(meta.id), text);

  const index = [...(await listAutoBackups())];
  index.push(meta);
  index.sort((a, b) => b.at - a.at);

  const pruneIds = pruneAutoBackupSnapshots(index, getAutoBackupConfig().retentionCount);
  const kept = index.filter((item) => !pruneIds.includes(item.id));
  await storage.setItem(INDEX_KEY, kept);

  // 裁剪掉的那几份连正文一起删（避免只删索引、正文烂在库里）
  for (const id of pruneIds) {
    if (id === meta.id) continue;
    await storage.removeItem(snapshotKey(id));
  }

  return meta;
}

/** 自动备份的执行结果（供界面与日志区分"没跑"的原因）。 */
export type AutoBackupRunResult =
  | { readonly ran: true; readonly meta: IAutoBackupSnapshotMeta }
  | { readonly ran: false; readonly reason: "disabled" | "not-due" | "empty" };

/**
 * 到点就自动备份一次（定时路径；也用于启动时补一次）。
 *
 * - 配置关闭 → 不跑；
 * - 距上次不足一个间隔 → 不跑；
 * - 空数据（没有任何角色与会话）→ 不跑，避免刷出一堆空白快照。
 */
export async function maybeRunAutoBackup(
  now: number = Date.now(),
): Promise<AutoBackupRunResult> {
  const config = getAutoBackupConfig();
  if (!config.enabled) return { ran: false, reason: "disabled" };

  const index = await listAutoBackups();
  const lastBackupAt = index.length > 0 ? index[0]!.at : null;
  if (!isAutoBackupDue(config, lastBackupAt, now)) {
    return { ran: false, reason: "not-due" };
  }

  // 先确认有值得备份的数据，再动手写盘
  const file = buildBackup(readLocalSnapshot(), now);
  if (!hasBackupData(file.counts)) return { ran: false, reason: "empty" };

  const meta = await writeSnapshot(now);
  return { ran: true, meta };
}

/**
 * 立即备份一次（"立即备份"按钮；无视到期判定与开关，仍跳过空数据）。
 */
export async function runAutoBackupNow(
  now: number = Date.now(),
): Promise<AutoBackupRunResult> {
  const file = buildBackup(readLocalSnapshot(), now);
  if (!hasBackupData(file.counts)) return { ran: false, reason: "empty" };
  const meta = await writeSnapshot(now);
  return { ran: true, meta };
}

/** 删除某份快照（索引 + 正文一起删）。 */
export async function deleteAutoBackup(id: string): Promise<void> {
  const index = await listAutoBackups();
  const kept = index.filter((item) => item.id !== id);
  if (kept.length === index.length) return; // 本来就不存在，无事可做
  await storage.setItem(INDEX_KEY, kept);
  await storage.removeItem(snapshotKey(id));
}

/** 把某份快照下载成 JSON 文件（给快照一个"离开这台设备"的出口）。 */
export async function downloadAutoBackup(id: string): Promise<IImportResult> {
  const text = await storage.getItem<string>(snapshotKey(id));
  if (text === null || typeof text !== "string") {
    return { ok: false, message: "快照内容不存在或已损坏。" };
  }
  const parsed = parseBackup(text);
  if (!parsed.ok) {
    return { ok: false, message: "这份快照读不出来（可能已损坏）。" };
  }
  const d = new Date(parsed.file.exportedAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  downloadTextFile(text, `zhichi-backup-${stamp}.json`);
  return { ok: true, message: "已下载为备份文件。" };
}

/**
 * 从某份自动快照恢复（与手动导入同一条链路：解析 → 合并 → 落库）。
 * 合并模式，不会删除本地数据。
 */
export async function restoreAutoBackup(id: string): Promise<IImportResult> {
  const text = await storage.getItem<string>(snapshotKey(id));
  if (text === null || typeof text !== "string") {
    return { ok: false, message: "快照内容不存在或已损坏。" };
  }
  return restoreFromBackupText(text);
}

/** 记录一次"手动导出成文件"（供设置面板显示提醒）。 */
export async function recordManualExport(now: number = Date.now()): Promise<void> {
  await storage.setItem(LAST_MANUAL_EXPORT_KEY, now);
}

/** 最近一次"手动导出成文件"的时间（null = 从没手动导出过）。 */
export async function getLastManualExportAt(): Promise<number | null> {
  const value = await storage.getItem<unknown>(LAST_MANUAL_EXPORT_KEY);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 把保留份数配置应用到现有索引的入口（设置面板改份数时调用，顺手清理超出部分）。 */
export async function applyRetentionCount(count: number): Promise<void> {
  const clamped = clampRetentionCount(count);
  const index = [...(await listAutoBackups())];
  index.sort((a, b) => b.at - a.at);
  const pruneIds = pruneAutoBackupSnapshots(index, clamped);
  if (pruneIds.length === 0) return;
  const kept = index.filter((item) => !pruneIds.includes(item.id));
  await storage.setItem(INDEX_KEY, kept);
  for (const id of pruneIds) {
    await storage.removeItem(snapshotKey(id));
  }
}
