/**
 * @file download.ts
 * 触发浏览器下载的公共小工具（备份导出与角色卡导出共用）。
 */

/**
 * 把文本作为文件下载下来。
 *
 * @param text 文件内容
 * @param filename 文件名
 */
export function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器会打断下载，延后一拍更稳
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 把可能出现在文件名里的非法字符替换掉（Windows 与 macOS 都覆盖）。 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}
