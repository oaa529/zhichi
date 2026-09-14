/**
 * @file placeholderSticker.ts
 * 内置贴图素材生成（SVG data URL）。
 *
 * 为什么现画、不放图片文件：贴图是聊天高频内容，外链失效就是满屏破图，
 * 而简笔表情完全可以用几十行 SVG 画出来——没有体积、不失真、
 * 换机器/导出备份都不受影响。
 *
 * 贴图 ID 与 core 的 `BASIC_STICKERS` 一一对应；未知 ID 退回"微笑"。
 */

/** 单个表情的五官参数。 */
interface IStickerFace {
  /** 底色（两个 stop 的渐变）。 */
  readonly from: string;
  readonly to: string;
  /** 眼睛 SVG 片段。 */
  readonly eyes: string;
  /** 嘴巴 SVG 片段。 */
  readonly mouth: string;
  /** 额外装饰（腮红、泪滴、Z 之类）。 */
  readonly extra?: string;
  /** 线条颜色。 */
  readonly ink: string;
}

const FACES: Record<string, IStickerFace> = {
  smile: {
    from: "#fff3d6",
    to: "#ffd98a",
    ink: "#8a5a12",
    eyes: `<circle cx="44" cy="52" r="6"/><circle cx="76" cy="52" r="6"/>`,
    mouth: `<path d="M42 72 q18 16 36 0" fill="none"/>`,
  },
  grin: {
    from: "#fff0c9",
    to: "#ffc46b",
    ink: "#8a5512",
    eyes: `<path d="M36 50 q8 -8 16 0" fill="none"/><path d="M68 50 q8 -8 16 0" fill="none"/>`,
    mouth: `<path d="M40 68 q20 22 40 0 z" fill="#8a5512"/>`,
  },
  cry: {
    from: "#d8ecff",
    to: "#8fc4ff",
    ink: "#1f4f8a",
    eyes: `<circle cx="44" cy="54" r="6"/><circle cx="76" cy="54" r="6"/>`,
    mouth: `<path d="M44 78 q16 -14 32 0" fill="none"/>`,
    extra: `<path d="M44 62 q-4 12 0 16 q4 -4 0 -16 z" fill="#5fa8f5"/><path d="M76 62 q-4 12 0 16 q4 -4 0 -16 z" fill="#5fa8f5"/>`,
  },
  rage: {
    from: "#ffe0da",
    to: "#ff9d8a",
    ink: "#8a2418",
    eyes: `<circle cx="44" cy="56" r="6"/><circle cx="76" cy="56" r="6"/>`,
    mouth: `<path d="M42 80 h36" fill="none"/>`,
    extra: `<path d="M34 40 l20 8" fill="none"/><path d="M86 40 l-20 8" fill="none"/>`,
  },
  shy: {
    from: "#ffe6ef",
    to: "#ffb7c5",
    ink: "#8a2f4a",
    eyes: `<path d="M38 54 q6 -6 12 0" fill="none"/><path d="M70 54 q6 -6 12 0" fill="none"/>`,
    mouth: `<path d="M50 74 q10 8 20 0" fill="none"/>`,
    extra: `<circle cx="34" cy="66" r="8" fill="#ff8fa8" opacity="0.5"/><circle cx="86" cy="66" r="8" fill="#ff8fa8" opacity="0.5"/>`,
  },
  wow: {
    from: "#e6e0ff",
    to: "#b3a4ff",
    ink: "#3f2f8a",
    eyes: `<circle cx="44" cy="52" r="8"/><circle cx="76" cy="52" r="8"/>`,
    mouth: `<ellipse cx="60" cy="78" rx="9" ry="12" fill="none"/>`,
  },
  think: {
    from: "#e4f6e6",
    to: "#a8e0b1",
    ink: "#2c6b3a",
    eyes: `<circle cx="46" cy="54" r="6"/><path d="M70 54 h12" fill="none"/>`,
    mouth: `<path d="M46 76 h20" fill="none"/>`,
    extra: `<circle cx="88" cy="34" r="4" fill="#2c6b3a" stroke="none" opacity="0.6"/><circle cx="96" cy="24" r="6" fill="#2c6b3a" stroke="none" opacity="0.45"/>`,
  },
  sleepy: {
    from: "#e8e8f7",
    to: "#b9bce8",
    ink: "#3a3d6b",
    eyes: `<path d="M36 56 q8 6 16 0" fill="none"/><path d="M68 56 q8 6 16 0" fill="none"/>`,
    mouth: `<ellipse cx="60" cy="78" rx="7" ry="9" fill="none"/>`,
    extra: `<text x="84" y="34" font-family="sans-serif" font-size="20" font-weight="700" fill="#3a3d6b" stroke="none" opacity="0.75">Z</text>`,
  },
};

/**
 * 生成一张贴图（正方形，120×120）。

 * @param stickerId core `BASIC_STICKERS` 里的 ID
 */
export function buildPlaceholderSticker(stickerId: string): string {
  const face = FACES[stickerId] ?? FACES.smile!;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">`,
    `<defs><radialGradient id="bg" cx="50%" cy="38%" r="72%">`,
    `<stop offset="0%" stop-color="${face.from}"/>`,
    `<stop offset="100%" stop-color="${face.to}"/>`,
    `</radialGradient></defs>`,
    `<circle cx="60" cy="60" r="56" fill="url(#bg)"/>`,
    `<g fill="${face.ink}" stroke="${face.ink}" stroke-width="4" stroke-linecap="round">`,
    face.eyes,
    face.mouth,
    face.extra ?? "",
    `</g>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
