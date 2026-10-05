/**
 * @file AutoBackup.ts
 * 自动备份的纯逻辑：什么时候该备份、保留多少份。
 *
 * 职责划分：
 * - 本文件 —— 纯函数（零副作用）：到期判定 / 保留份数裁剪 / 文案
 * - apps/web/autoBackupRunner.ts —— 读写 IndexedDB、触发、恢复、下载
 *
 * 自动备份的定位：把当前数据快照留在**浏览器本地**，防"数据被写坏 /
 * 误删 / 升级事故"这类同一台设备上的事故；它防不了"清缓存 / 换机器"
 * （那会连快照一起清掉），所以设置面板里仍提醒定期手动导出成文件。
 */

import type {
  IAutoBackupConfig,
  IAutoBackupSnapshotMeta,
} from "@wechat-rp/shared-types";

/** 默认自动备份配置：开启、每天一次、保留 10 份。 */
export const DEFAULT_AUTO_BACKUP_CONFIG: IAutoBackupConfig = {
  enabled: true,
  intervalHours: 24,
  retentionCount: 10,
};

/** 间隔档位（小时），设置面板下拉用。 */
export const AUTO_BACKUP_INTERVAL_OPTIONS: ReadonlyArray<number> = [
  1, 6, 24, 168,
];

/** 保留份数的合法范围。 */
export const AUTO_BACKUP_MIN_RETENTION = 1;
export const AUTO_BACKUP_MAX_RETENTION = 30;

/** 把 intervalHours 归一化到合法区间内（设置面板输入防呆）。 */
export function clampIntervalHours(hours: number): number {
  const rounded = Math.round(hours);
  if (Number.isNaN(rounded)) return DEFAULT_AUTO_BACKUP_CONFIG.intervalHours;
  const option = AUTO_BACKUP_INTERVAL_OPTIONS.find((o) => o === rounded);
  if (option !== undefined) return option;
  return DEFAULT_AUTO_BACKUP_CONFIG.intervalHours;
}

/** 把 retentionCount 归一化到合法区间内。 */
export function clampRetentionCount(count: number): number {
  const rounded = Math.round(count);
  if (Number.isNaN(rounded)) return DEFAULT_AUTO_BACKUP_CONFIG.retentionCount;
  return Math.min(
    AUTO_BACKUP_MAX_RETENTION,
    Math.max(AUTO_BACKUP_MIN_RETENTION, rounded),
  );
}

/**
 * 把（可能来自持久化、结构未知的）配置归一化成合法形状。
 *
 * hydration 的"进门先过安检"用：坏数据只损失它自己，而不是让
 * 自动备份 runner 或设置面板读到 `enabled: undefined` 之类的形状。
 */
export function normalizeAutoBackupConfig(value: unknown): IAutoBackupConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_AUTO_BACKUP_CONFIG;
  }
  const raw = value as Partial<IAutoBackupConfig>;
  return {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : DEFAULT_AUTO_BACKUP_CONFIG.enabled,
    intervalHours: clampIntervalHours(
      typeof raw.intervalHours === "number" ? raw.intervalHours : Number.NaN,
    ),
    retentionCount: clampRetentionCount(
      typeof raw.retentionCount === "number"
        ? raw.retentionCount
        : Number.NaN,
    ),
  };
}

/**
 * 判断是否到了该自动备份的时刻。
 *
 * - 关闭 → 永远不到点；
 * - 从未备份过 → 到点（第一次打开应用就留一份基线快照）；
 * - 否则按 `now - lastBackupAt >= interval` 判定。
 */
export function isAutoBackupDue(
  config: IAutoBackupConfig,
  lastBackupAt: number | null,
  now: number,
): boolean {
  if (!config.enabled) return false;
  if (lastBackupAt === null) return true;
  const intervalMs = clampIntervalHours(config.intervalHours) * 3_600_000;
  return now - lastBackupAt >= intervalMs;
}

/**
 * 裁剪快照索引：保留最新 retentionCount 份，返回应删除的快照 id。
 *
 * 入参顺序不限（内部按 at 排序）；已按 at 倒序排好的数组也直接可用。
 */
export function pruneAutoBackupSnapshots(
  metas: ReadonlyArray<IAutoBackupSnapshotMeta>,
  retentionCount: number,
): ReadonlyArray<string> {
  const keep = clampRetentionCount(retentionCount);
  if (metas.length <= keep) return [];
  const sorted = [...metas].sort((a, b) => b.at - a.at);
  return sorted.slice(keep).map((meta) => meta.id);
}

/** 间隔小时 → 中文文案（设置面板下拉显示用）。 */
export function formatAutoBackupIntervalLabel(hours: number): string {
  switch (clampIntervalHours(hours)) {
    case 1:
      return "每 1 小时";
    case 6:
      return "每 6 小时";
    case 24:
      return "每天";
    case 168:
      return "每周";
    default:
      return "每天";
  }
}
