/**
 * @file SettingsPanel.autoBackup.test.tsx
 * 设置面板「自动备份」区块：开关 / 间隔 / 保留份数 / 立即备份 / 快照列表。
 *
 * 组装层（IndexedDB 读写 / 恢复 / 下载）在 apps/web 的 autoBackupRunner 测试里，
 * 这里测的是 UI 层：配置读写走 sessionStore，快照操作走注入的 api。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { IAutoBackupSnapshotMeta } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import { SettingsPanel } from "../components/SettingsPanel";
import type { IAutoBackupApi, IBackupActionResult } from "../components/SettingsPanel";

const NOW = Date.now();
const ok = (message: string): IBackupActionResult => ({ ok: true, message });

function snapshot(at: number): IAutoBackupSnapshotMeta {
  return {
    id: String(at),
    at,
    sizeBytes: 2048,
    counts: { sessions: 1, characters: 1, memories: 2, messages: 40 },
  };
}

function makeApi(overrides: Partial<IAutoBackupApi> = {}): IAutoBackupApi {
  return {
    list: [snapshot(NOW)],
    lastManualExportAt: null,
    desktop: false,
    refresh: vi.fn(async () => undefined),
    runNow: vi.fn(async () => ok("已备份：1 个会话 / 40 条消息 / 1 个角色")),
    restore: vi.fn(async () => ok("导入完成：1 个会话 / 40 条消息 / 2 条记忆")),
    download: vi.fn(async () => ok("已下载为备份文件。")),
    remove: vi.fn(async () => undefined),
    applyRetention: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPanel(api: IAutoBackupApi): ReturnType<typeof render> {
  return render(<SettingsPanel autoBackup={api} />);
}

/** 自动备份开关（区块里唯一的 checkbox，面板其他部分还有别的 checkbox）。 */
function autoBackupToggle(): HTMLInputElement {
  return document.querySelector(
    ".zhichi-settings__auto-backup-toggle input",
  ) as HTMLInputElement;
}

beforeEach(() => {
  useSessionStore.setState({
    autoBackupConfig: { enabled: true, intervalHours: 24, retentionCount: 10 },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("自动备份区块渲染", () => {
  it("提供 api 时渲染开关 / 间隔 / 保留份数 / 快照列表", () => {
    const api = makeApi({ list: [snapshot(NOW - 60_000)] });
    renderPanel(api);

    expect(screen.getByText("自动备份")).toBeTruthy();
    expect(screen.getByText("备份间隔")).toBeTruthy();
    expect(screen.getByText("保留份数")).toBeTruthy();
    // 快照列表：时间 + 元数据 + 三个操作按钮
    expect(screen.getByText("1 分钟前")).toBeTruthy();
    expect(screen.getByText(/2.0 KB · 1 会话 \/ 40 消息/)).toBeTruthy();
    expect(screen.getByText("下载")).toBeTruthy();
    expect(screen.getByText("恢复")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("不提供 api 时不渲染自动备份区块（老调用方不受影响）", () => {
    render(<SettingsPanel />);
    expect(screen.queryByText("自动备份")).toBeNull();
  });

  it("关闭开关后隐藏配置与列表", () => {
    const api = makeApi();
    renderPanel(api);
    fireEvent.click(autoBackupToggle());

    expect(useSessionStore.getState().autoBackupConfig.enabled).toBe(false);
    expect(screen.queryByText("备份间隔")).toBeNull();
    expect(screen.queryByText("立即备份一份")).toBeNull();
  });
});

describe("自动备份交互", () => {
  it("切换间隔档位写入 store", () => {
    const api = makeApi();
    renderPanel(api);

    fireEvent.change(screen.getByText("备份间隔").closest("label")!.querySelector("select")!, {
      target: { value: "6" },
    });
    expect(useSessionStore.getState().autoBackupConfig.intervalHours).toBe(6);
  });

  it("改小保留份数会立即清理超出部分（调用 api.applyRetention）", () => {
    const api = makeApi();
    renderPanel(api);

    const input = screen
      .getByText("保留份数")
      .closest("label")!
      .querySelector("input")!;
    fireEvent.change(input, { target: { value: "3" } });

    expect(useSessionStore.getState().autoBackupConfig.retentionCount).toBe(3);
    expect(api.applyRetention).toHaveBeenCalledWith(3);
  });

  it("越界的保留份数不入 store、不触发清理", () => {
    const api = makeApi();
    renderPanel(api);

    const input = screen
      .getByText("保留份数")
      .closest("label")!
      .querySelector("input")!;
    fireEvent.change(input, { target: { value: "99" } });

    expect(useSessionStore.getState().autoBackupConfig.retentionCount).toBe(10);
    expect(api.applyRetention).not.toHaveBeenCalled();
  });

  it("点「立即备份一份」调用 api.runNow 并显示回执", async () => {
    const api = makeApi();
    renderPanel(api);

    fireEvent.click(screen.getByText("立即备份一份"));
    await waitFor(() => {
      expect(api.runNow).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/已备份：1 个会话/)).toBeTruthy();
    });
  });

  it("点「下载」调用 api.download", async () => {
    const api = makeApi();
    renderPanel(api);

    fireEvent.click(screen.getByText("下载"));
    await waitFor(() => {
      expect(api.download).toHaveBeenCalledWith(String(NOW));
    });
  });

  it("点「删除」需确认，确认后调用 api.remove", async () => {
    const api = makeApi();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel(api);

    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => {
      expect(api.remove).toHaveBeenCalledWith(String(NOW));
    });
    confirmSpy.mockRestore();
  });

  it("点「删除」取消确认时不调用 api.remove", async () => {
    const api = makeApi();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel(api);

    fireEvent.click(screen.getByText("删除"));
    expect(api.remove).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("点「恢复」需确认，确认后调用 api.restore", async () => {
    const api = makeApi();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel(api);

    fireEvent.click(screen.getByText("恢复"));
    await waitFor(() => {
      expect(api.restore).toHaveBeenCalledWith(String(NOW));
    });
    confirmSpy.mockRestore();
  });

  it("状态行显示手动导出时间（记录过时才出现）", () => {
    const api = makeApi({
      lastManualExportAt: Date.now() - 2 * 3_600_000,
    });
    renderPanel(api);

    expect(screen.getByText(/上次手动导出：2 小时前/)).toBeTruthy();
  });

  it("没有快照时显示提示而不是列表", () => {
    const api = makeApi({ list: [] });
    renderPanel(api);

    expect(screen.getByText(/还没有自动备份快照/)).toBeTruthy();
    expect(screen.queryByText("下载")).toBeNull();
  });

  it("桌面端在提示文案里说明「额外写进文档/咫尺备份」", () => {
    renderPanel(makeApi({ desktop: true }));
    expect(screen.getByText(/文档\/咫尺备份/)).toBeTruthy();
  });

  it("web 端不显示落盘提示", () => {
    renderPanel(makeApi({ desktop: false }));
    expect(screen.queryByText(/文档\/咫尺备份/)).toBeNull();
  });
});
