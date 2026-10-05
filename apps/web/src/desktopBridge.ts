/**
 * @file desktopBridge.ts
 * 桌面端（Tauri）能力桥。
 *
 * 刻意不引 @tauri-apps/api：本应用只有"备份落盘"一个 command，
 * 直接走 Tauri 注入的 `window.__TAURI_INTERNALS__.invoke` 就够了——
 * 少一个依赖，web 端也不必为用不到的东西付出体积。
 * （Tauri v2 的 @tauri-apps/api/core 内部也是调这个入口。）
 *
 * 所有函数在 web 端必须安全：探测不到 Tauri 时按"非桌面端"处理，
 * 调用则返回可读原因，绝不抛异常打断备份主流程。
 */

/** Tauri v2 注入到 WebView 的内部对象（invoke 是它暴露的核心入口）。 */
interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/** 取 Tauri 内部对象；web 端（含 jsdom 测试）恒为 null。 */
function internals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

/** 是否跑在桌面端（Tauri WebView）里。web 端恒为 false。 */
export function isDesktopApp(): boolean {
  return internals() !== null;
}

/** 备份落盘结果（成功带文件路径，失败带可读原因）。 */
export type DiskSaveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * 把备份 JSON 写进「文档/咫尺备份/」（仅桌面端有效）。
 *
 * 定位是 IndexedDB 快照的补充：本地快照跟着 WebView 数据走
 * （清缓存会没），磁盘上的文件才是能扛过清缓存/换浏览器真备份。
 * 因此失败**不影响**调用方的本地快照——返回值里给可读原因，
 * 由界面决定要不要提示，不向上抛。
 */
export async function saveBackupToDisk(
  text: string,
  filename: string,
): Promise<DiskSaveResult> {
  const api = internals();
  if (!api) return { ok: false, message: "当前不是桌面端，没有落盘出口。" };

  try {
    const path = await api.invoke<string>("save_backup_file", { text, filename });
    return { ok: true, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}
