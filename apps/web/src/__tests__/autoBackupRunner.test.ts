/**
 * @file autoBackupRunner.test.ts
 * 自动备份组装层：快照存取 / 到期触发 / 保留裁剪 / 恢复 / 下载 / 删除。
 *
 * core 的 AutoBackup 已测过"到期判定 / 保留裁剪"的纯逻辑，
 * 这里测的是组装层：从 store 拍快照（**绝不能带上 API Key**）、
 * 写进注入的内存存储、恢复走"解析 → 合并 → 落库"的真实链路。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import {
  __resetAutoBackupStorage,
  __setAutoBackupStorage,
  applyRetentionCount,
  deleteAutoBackup,
  downloadAutoBackup,
  getLastManualExportAt,
  hasBackupData,
  listAutoBackups,
  maybeRunAutoBackup,
  recordManualExport,
  restoreAutoBackup,
  runAutoBackupNow,
} from "../autoBackupRunner";
import type { IAutoBackupStorage } from "../autoBackupRunner";
import { buildBackupText } from "../backupRunner";

const downloads: Array<{ text: string; filename: string }> = [];
vi.mock("../download", () => ({
  downloadTextFile: (text: string, filename: string) => {
    downloads.push({ text, filename });
  },
  sanitizeFileName: (name: string) => name,
}));

const NOW = new Date(2026, 8, 13, 15, 20, 0).getTime();
const CHAR = "char-1";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "苏晚晴",
  bio: "邻家姐姐",
  visualMetadata: {
    avatarUrl: "",
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
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

/** 内存存储假件（模拟 IndexedDB 的异步 kv）。 */
function memoryStorage(): IAutoBackupStorage {
  const map = new Map<string, unknown>();
  return {
    getItem: async <T>(key: string): Promise<T | null> =>
      (map.get(key) as T | undefined) ?? null,
    setItem: async <T>(key: string, value: T): Promise<void> => {
      map.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      map.delete(key);
    },
  };
}

let storage: IAutoBackupStorage;

beforeEach(() => {
  downloads.length = 0;
  storage = memoryStorage();
  __setAutoBackupStorage(storage);
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    contacts: {},
    sessions: {},
    promptTemplates: {},
    memories: {},
    loreEntries: {},
    plotStates: {},
    activeSessionId: null,
    apiKey: "sk-测试用的假钥匙",
    // store 是跨测试单例，恢复默认配置（上一个测试可能把它改成关闭了）
    autoBackupConfig: { enabled: true, intervalHours: 24, retentionCount: 10 },
  });
});

afterEach(() => {
  __resetAutoBackupStorage();
  vi.clearAllMocks();
});

describe("maybeRunAutoBackup（定时路径）", () => {
  it("首次打开 → 备份一份基线快照，索引与正文都落盘", async () => {
    const result = await maybeRunAutoBackup(NOW);

    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.meta.at).toBe(NOW);
    expect(result.meta.counts.characters).toBe(1);

    const index = await listAutoBackups();
    expect(index).toHaveLength(1);
    expect(index[0]!.id).toBe(String(NOW));
    expect(index[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it("间隔未到 → 不重复备份", async () => {
    await maybeRunAutoBackup(NOW);
    const result = await maybeRunAutoBackup(NOW + 60_000);
    expect(result.ran).toBe(false);
    expect(result).toMatchObject({ ran: false, reason: "not-due" });
  });

  it("间隔到点 → 再备份一份，新的排在前面", async () => {
    await maybeRunAutoBackup(NOW);
    const later = NOW + 24 * 3_600_000;
    const result = await maybeRunAutoBackup(later);

    expect(result.ran).toBe(true);
    const index = await listAutoBackups();
    expect(index).toHaveLength(2);
    expect(index[0]!.at).toBe(later);
  });

  it("配置关闭 → 不备份", async () => {
    useSessionStore.setState({ autoBackupConfig: { enabled: false, intervalHours: 24, retentionCount: 10 } });
    const result = await maybeRunAutoBackup(NOW);
    expect(result.ran).toBe(false);
    expect(result).toMatchObject({ ran: false, reason: "disabled" });
  });

  it("空白应用（无角色无会话）→ 不产生空快照", async () => {
    useSessionStore.setState({ characters: {}, sessions: {} });
    const result = await maybeRunAutoBackup(NOW);
    expect(result.ran).toBe(false);
    expect(result).toMatchObject({ ran: false, reason: "empty" });
    expect(await listAutoBackups()).toHaveLength(0);
  });

  it("超过保留份数时，旧的被裁掉（索引与正文都删）", async () => {
    useSessionStore.setState({
      autoBackupConfig: { enabled: true, intervalHours: 1, retentionCount: 2 },
    });
    await maybeRunAutoBackup(NOW);
    await maybeRunAutoBackup(NOW + 3_600_000);
    await maybeRunAutoBackup(NOW + 2 * 3_600_000);

    const index = await listAutoBackups();
    expect(index).toHaveLength(2);
    // 最旧的那份正文也不该还在库里
    const oldSnapshot = await storage.getItem<string>("auto-backup:snapshot:" + NOW);
    expect(oldSnapshot).toBeNull();
  });

  it("改小保留份数 → 立即清理超出的旧快照（不用等下次备份）", async () => {
    useSessionStore.setState({
      autoBackupConfig: { enabled: true, intervalHours: 1, retentionCount: 10 },
    });
    await maybeRunAutoBackup(NOW);
    await maybeRunAutoBackup(NOW + 3_600_000);
    await maybeRunAutoBackup(NOW + 2 * 3_600_000);
    expect(await listAutoBackups()).toHaveLength(3);

    await applyRetentionCount(1);
    const index = await listAutoBackups();
    expect(index).toHaveLength(1);
    expect(index[0]!.at).toBe(NOW + 2 * 3_600_000); // 只留最新
    // 被清掉的正文也删干净
    expect(await storage.getItem("auto-backup:snapshot:" + NOW)).toBeNull();
  });
});

describe("runAutoBackupNow（立即备份）", () => {
  it("无视开关与间隔，立即备份", async () => {
    useSessionStore.setState({ autoBackupConfig: { enabled: false, intervalHours: 24, retentionCount: 10 } });
    await maybeRunAutoBackup(NOW); // 不跑
    const result = await runAutoBackupNow(NOW);
    expect(result.ran).toBe(true);
    expect(await listAutoBackups()).toHaveLength(1);
  });

  it("空数据 → 不产生快照", async () => {
    useSessionStore.setState({ characters: {}, sessions: {} });
    const result = await runAutoBackupNow(NOW);
    expect(result.ran).toBe(false);
    expect(result).toMatchObject({ ran: false, reason: "empty" });
  });
});

describe("快照操作", () => {
  it("快照内容不含 API Key（安全红线）", async () => {
    await runAutoBackupNow(NOW);
    const text = await storage.getItem<string>("auto-backup:snapshot:" + NOW);
    expect(text).not.toContain("sk-测试用的假钥匙");
  });

  it("删除：索引与正文一起清掉", async () => {
    await runAutoBackupNow(NOW);
    await deleteAutoBackup(String(NOW));

    expect(await listAutoBackups()).toHaveLength(0);
    expect(await storage.getItem("auto-backup:snapshot:" + NOW)).toBeNull();
  });

  it("删除不存在的 id → 无副作用", async () => {
    await runAutoBackupNow(NOW);
    await deleteAutoBackup("nope");
    expect(await listAutoBackups()).toHaveLength(1);
  });

  it("下载：按快照时间戳命名，内容可解析", async () => {
    await runAutoBackupNow(NOW);
    const result = await downloadAutoBackup(String(NOW));

    expect(result.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe("zhichi-backup-20260913-152000.json");
    expect(JSON.parse(downloads[0]!.text)).toHaveProperty("format");
  });

  it("下载损坏的快照 → 可读提示，不触发下载", async () => {
    await storage.setItem("auto-backup:snapshot:bad", "不是 JSON");
    const result = await downloadAutoBackup("bad");
    expect(result.ok).toBe(false);
    expect(downloads).toHaveLength(0);
  });

  it("恢复：新数据合并进来，本地数据保留", async () => {
    await runAutoBackupNow(NOW);
    // 本地再加一个新角色（快照里没有），恢复后它应该还在
    useSessionStore.setState({
      characters: {
        [CHAR]: profile,
        "char-2": { ...profile, id: "char-2", displayName: "林笑笑" },
      },
    });

    const result = await restoreAutoBackup(String(NOW));
    expect(result.ok).toBe(true);

    const names = Object.values(useSessionStore.getState().characters).map(
      (c) => c.displayName,
    );
    expect(names).toContain("苏晚晴");
    expect(names).toContain("林笑笑");
  });

  it("恢复不存在的快照 → 可读提示", async () => {
    const result = await restoreAutoBackup("missing");
    expect(result.ok).toBe(false);
  });
});

describe("手动导出时间戳", () => {
  it("记录后能读回；没记录过是 null", async () => {
    expect(await getLastManualExportAt()).toBeNull();
    await recordManualExport(NOW);
    expect(await getLastManualExportAt()).toBe(NOW);
  });

  it("坏数据（字符串等）按 null 处理", async () => {
    await storage.setItem("auto-backup:lastManualExportAt", "oops");
    expect(await getLastManualExportAt()).toBeNull();
  });
});

describe("hasBackupData", () => {
  it("有角色或会话就算有数据", () => {
    expect(hasBackupData({ sessions: 0, characters: 1, memories: 0, messages: 0 })).toBe(true);
    expect(hasBackupData({ sessions: 1, characters: 0, memories: 0, messages: 0 })).toBe(true);
    expect(hasBackupData({ sessions: 0, characters: 0, memories: 3, messages: 10 })).toBe(false);
  });
});

describe("快照列表容错", () => {
  it("索引是坏形状（非数组）时按空列表处理，不炸", async () => {
    await storage.setItem("auto-backup:index", "bad");
    expect(await listAutoBackups()).toEqual([]);
  });

  it("索引里的坏条目被跳过，好的保留", async () => {
    await runAutoBackupNow(NOW);
    const good = await listAutoBackups();
    await storage.setItem("auto-backup:index", [...good, { id: "x" }]);
    const index = await listAutoBackups();
    expect(index).toHaveLength(1);
    expect(index[0]!.id).toBe(String(NOW));
  });
});

describe("桌面端落盘（Tauri）", () => {
  function mockTauri(impl?: (cmd: string, args?: Record<string, unknown>) => Promise<string>) {
    const invoke = vi.fn(
      impl ?? (async () => "D:\\Documents\\咫尺备份\\zhichi-backup-x.json"),
    );
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: invoke as unknown as <T>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => Promise<T>,
    };
    return invoke;
  }

  function clearTauri(): void {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }

  afterEach(clearTauri);

  it("桌面端备份成功时，快照同时写进「文档/咫尺备份」（同一个 buildBackup 内容）", async () => {
    const invoke = mockTauri();
    await runAutoBackupNow(NOW);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0]!;
    expect(cmd).toBe("save_backup_file");
    const payload = args as { text: string; filename: string };
    expect(payload.filename).toBe("zhichi-backup-20260913-152000.json");
    // 落盘内容与 IndexedDB 快照逐字节一致
    const snap = await storage.getItem<string>("auto-backup:snapshot:" + NOW);
    expect(payload.text).toBe(snap);
  });

  it("落盘失败**不影响**本地快照（备份主流程不受牵连）", async () => {
    mockTauri(async () => {
      throw new Error("磁盘满了");
    });
    const result = await runAutoBackupNow(NOW);

    expect(result.ran).toBe(true);
    expect(await listAutoBackups()).toHaveLength(1);
  });

  it("web 端（无 Tauri）不尝试落盘", async () => {
    await runAutoBackupNow(NOW);
    // 没有 internals 时 saveBackupToDisk 直接返回 not-desktop，不会调 invoke
    expect(await listAutoBackups()).toHaveLength(1);
  });
});

describe("与手动备份的一致性", () => {
  it("自动快照与手动导出的备份文本内容一致（同一个 buildBackup 路径）", async () => {
    const manual = buildBackupText(NOW);
    await runAutoBackupNow(NOW);
    const auto = await storage.getItem<string>("auto-backup:snapshot:" + NOW);
    expect(auto).toBe(manual);
  });
});
