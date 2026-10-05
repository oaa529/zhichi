/**
 * @file AutoBackup.test.ts
 * 自动备份纯逻辑：到期判定 / 保留裁剪 / 配置归一化。
 *
 * 读写 IndexedDB 与"读 store 拍快照"的组装逻辑在
 * apps/web/src/__tests__/autoBackupRunner.test.ts 覆盖。
 */

import { describe, it, expect } from "vitest";
import {
  AUTO_BACKUP_INTERVAL_OPTIONS,
  AUTO_BACKUP_MAX_RETENTION,
  AUTO_BACKUP_MIN_RETENTION,
  DEFAULT_AUTO_BACKUP_CONFIG,
  clampIntervalHours,
  clampRetentionCount,
  formatAutoBackupIntervalLabel,
  isAutoBackupDue,
  normalizeAutoBackupConfig,
  pruneAutoBackupSnapshots,
} from "../backup/AutoBackup";
import type { IAutoBackupSnapshotMeta } from "@wechat-rp/shared-types";

const HOUR = 3_600_000;

function meta(id: string, at: number): IAutoBackupSnapshotMeta {
  return {
    id,
    at,
    sizeBytes: 100,
    counts: { sessions: 1, characters: 1, memories: 0, messages: 10 },
  };
}

describe("isAutoBackupDue", () => {
  const config = { ...DEFAULT_AUTO_BACKUP_CONFIG };

  it("关闭时永远不到点", () => {
    expect(isAutoBackupDue({ ...config, enabled: false }, null, 1000)).toBe(false);
    expect(
      isAutoBackupDue({ ...config, enabled: false }, 0, 1000),
    ).toBe(false);
  });

  it("从未备份过 → 到点（第一次打开就留一份基线）", () => {
    expect(isAutoBackupDue(config, null, 0)).toBe(true);
  });

  it("间隔刚满 → 到点；差一分钟 → 不到点", () => {
    const start = 1_000_000;
    expect(isAutoBackupDue(config, start, start + 24 * HOUR)).toBe(true);
    expect(isAutoBackupDue(config, start, start + 24 * HOUR - 1)).toBe(false);
  });

  it("间隔为 1 小时档也正确", () => {
    const config1h = { ...config, intervalHours: 1 };
    const start = 5_000;
    expect(isAutoBackupDue(config1h, start, start + HOUR)).toBe(true);
    expect(isAutoBackupDue(config1h, start, start + HOUR - 1)).toBe(false);
  });

  it("奇怪的间隔值会回退到默认档，不会算出离谱结果", () => {
    const bad = { ...config, intervalHours: 0.5 };
    const start = 1_000;
    // 0.5h 若被直接采用，30 分钟就该备份；回退到 24h 后不到点
    expect(isAutoBackupDue(bad, start, start + 30 * 60 * 1000)).toBe(false);
  });
});

describe("pruneAutoBackupSnapshots", () => {
  const list = [
    meta("t1", 100),
    meta("t2", 300),
    meta("t3", 200),
  ];

  it("未超上限 → 全保留、不删任何东西", () => {
    expect(pruneAutoBackupSnapshots(list, 5)).toEqual([]);
    expect(pruneAutoBackupSnapshots(list, 3)).toEqual([]);
  });

  it("超上限 → 按时间从旧到新删，留下最新的 N 份", () => {
    const toDelete = pruneAutoBackupSnapshots(list, 2);
    expect(toDelete).toEqual(["t1"]); // t1(100) 最旧，被删
  });

  it("入参顺序无关：t2 最新（300），超限时保的是它", () => {
    const toDelete = pruneAutoBackupSnapshots([...list].reverse(), 2);
    expect(toDelete).toEqual(["t1"]);
  });

  it("保留份数夹取到合法区间（0 / 负数按 1 处理）", () => {
    // 时间倒序：t2(300) 最新 → t3(200) → t1(100) 最旧；保留 1 份删后两个
    expect(pruneAutoBackupSnapshots(list, 0)).toEqual(["t3", "t1"]);
    expect(pruneAutoBackupSnapshots(list, -5)).toEqual(["t3", "t1"]);
  });

  it("空列表 → 无事可做", () => {
    expect(pruneAutoBackupSnapshots([], 1)).toEqual([]);
  });
});

describe("配置归一化", () => {
  it("默认值即合法配置", () => {
    expect(DEFAULT_AUTO_BACKUP_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AUTO_BACKUP_CONFIG.intervalHours).toBe(24);
    expect(DEFAULT_AUTO_BACKUP_CONFIG.retentionCount).toBe(10);
  });

  it("合法配置原样通过", () => {
    expect(normalizeAutoBackupConfig(DEFAULT_AUTO_BACKUP_CONFIG)).toEqual(
      DEFAULT_AUTO_BACKUP_CONFIG,
    );
  });

  it("null / 非对象 → 整体回退默认（防持久化坏数据）", () => {
    expect(normalizeAutoBackupConfig(null)).toEqual(DEFAULT_AUTO_BACKUP_CONFIG);
    expect(normalizeAutoBackupConfig("oops")).toEqual(DEFAULT_AUTO_BACKUP_CONFIG);
    expect(normalizeAutoBackupConfig([])).toEqual(DEFAULT_AUTO_BACKUP_CONFIG);
  });

  it("字段级坏值逐个回退，好的保留", () => {
    const result = normalizeAutoBackupConfig({
      enabled: "yes" as unknown as boolean,
      intervalHours: 6,
      retentionCount: -3,
    });
    expect(result.enabled).toBe(true);
    expect(result.intervalHours).toBe(6);
    expect(result.retentionCount).toBe(AUTO_BACKUP_MIN_RETENTION);
  });

  it("intervalHours 不在档位里时回退默认档", () => {
    const result = normalizeAutoBackupConfig({
      enabled: false,
      intervalHours: 12,
      retentionCount: 20,
    });
    expect(result.enabled).toBe(false);
    expect(result.intervalHours).toBe(24);
    expect(result.retentionCount).toBe(20);
  });
});

describe("辅助函数", () => {
  it("clamp 区间", () => {
    expect(clampIntervalHours(1)).toBe(1);
    expect(clampIntervalHours(6)).toBe(6);
    expect(clampRetentionCount(0)).toBe(AUTO_BACKUP_MIN_RETENTION);
    expect(clampRetentionCount(999)).toBe(AUTO_BACKUP_MAX_RETENTION);
    expect(clampRetentionCount(Number.NaN)).toBe(10);
  });

  it("间隔档位文案", () => {
    expect(AUTO_BACKUP_INTERVAL_OPTIONS).toEqual([1, 6, 24, 168]);
    expect(formatAutoBackupIntervalLabel(1)).toBe("每 1 小时");
    expect(formatAutoBackupIntervalLabel(6)).toBe("每 6 小时");
    expect(formatAutoBackupIntervalLabel(24)).toBe("每天");
    expect(formatAutoBackupIntervalLabel(168)).toBe("每周");
  });
});
