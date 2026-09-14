/**
 * @file imageFile.ts
 * 本地图片 → 内联 data URL。
 *
 * 为什么内联：现在头像与立绘都是外链 URL，图床挂掉、对方删图、换机器之后
 * 就只剩一个破图标；角色卡本来该是自包含的。
 *
 * 代价是体积，所以先等比缩到合理边长再存：头像 256、立绘 512。
 */

/** 等比缩放到不超过 maxEdge 的尺寸（只缩不放）。 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: maxEdge, height: maxEdge };
  }
  if (width <= 0 || height <= 0) return { width: maxEdge, height: maxEdge };

  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 把 data URL 载入为 Image（失败时 reject）。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = src;
  });
}

/** 读取文件为 data URL。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 读取本地图片并等比缩放成 data URL。
 *
 * 输出统一用 PNG：立绘常是带透明通道的素材，转 JPEG 会把背景涂黑。
 * 环境不支持 canvas 时退回未缩放的原始 data URL（宁可大一点也不能丢图）。
 *
 * @param file 用户选择的图片文件
 * @param maxEdge 最长边上限（像素）
 */
export async function readImageAsDataUrl(
  file: File,
  maxEdge = 256,
): Promise<string> {
  const original = await readAsDataUrl(file);
  if (!original.startsWith("data:image/")) {
    throw new Error("这不是图片文件");
  }

  const image = await loadImage(original);
  const size = fitWithin(image.naturalWidth, image.naturalHeight, maxEdge);

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return original;

  ctx.drawImage(image, 0, 0, size.width, size.height);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    // 某些环境（离屏 canvas 被禁用）会抛错，退回原图
    return original;
  }
}
