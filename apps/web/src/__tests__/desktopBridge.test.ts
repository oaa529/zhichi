/**
 * @file desktopBridge.test.ts
 * 桌面端能力桥：环境探测、备份落盘调用、失败不抛。
 *
 * 关键就是"两副面孔"：web 端（jsdom，__TAURI_INTERNALS__ 不存在）必须
 * 安全返回"非桌面端"；有 Tauri 注入时按约定调 invoke。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isDesktopApp, saveBackupToDisk } from "../desktopBridge";

const TAURI_KEY = "__TAURI_INTERNALS__";

/** 往 window 上塞一个假的 Tauri 内部对象，返回收集调用参数用的 spy。 */
function mockTauri(impl?: (cmd: string, args?: Record<string, unknown>) => Promise<string>) {
  const invoke = vi.fn(
    impl ??
      (async (cmd: string) => {
        expect(cmd).toBe("save_backup_file");
        return "C:\\Users\\u\\Documents\\咫尺备份\\zhichi-backup-20261005-120000.json";
      }),
  );
  (window as unknown as Record<string, unknown>)[TAURI_KEY] = {
    invoke: invoke as unknown as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  };
  return invoke;
}

function clearTauri(): void {
  delete (window as unknown as Record<string, unknown>)[TAURI_KEY];
}

beforeEach(() => {
  clearTauri();
});

afterEach(() => {
  clearTauri();
  vi.clearAllMocks();
});

describe("isDesktopApp", () => {
  it("web 端（无 Tauri 注入）→ false", () => {
    expect(isDesktopApp()).toBe(false);
  });

  it("有 Tauri 注入 → true", () => {
    mockTauri();
    expect(isDesktopApp()).toBe(true);
  });
});

describe("saveBackupToDisk", () => {
  it("web 端调用 → 返回可读原因，不抛异常", async () => {
    const result = await saveBackupToDisk("{}", "a.json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("桌面端");
  });

  it("桌面端 → 按约定调用 save_backup_file 并回传路径", async () => {
    const invoke = mockTauri();
    const result = await saveBackupToDisk("备份内容", "zhichi-backup-x.json");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toContain("zhichi-backup-20261005-120000.json");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("save_backup_file", {
      text: "备份内容",
      filename: "zhichi-backup-x.json",
    });
  });

  it("桌面端命令失败（磁盘满/无权限）→ 返回可读原因，不抛", async () => {
    mockTauri(async () => {
      throw new Error("写入备份文件失败：拒绝访问");
    });
    const result = await saveBackupToDisk("内容", "a.json");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("拒绝访问");
  });

  it("桌面端丢出非 Error 也不炸", async () => {
    mockTauri(async () => {
      throw "raw string failure";
    });
    const result = await saveBackupToDisk("内容", "a.json");
    expect(result.ok).toBe(false);
  });
});
