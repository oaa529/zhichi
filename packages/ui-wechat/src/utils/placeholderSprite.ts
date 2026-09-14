/**
 * @file placeholderSprite.ts
 * 内置占位素材生成（SVG data URL）。
 *
 * 由来：演示角色原本指向第三方图床，图床失效后新装用户第一眼看到的就是破图
 * （实测缩略图全是碎图标）。外链不可控，而占位素材完全可以当场画出来——
 * 自包含、不请求网络、体积几百字节。
 *
 * 这里生成的是**诚实的占位图**：一块柔和底色 + 简单人形 + 情绪表情，
 * 不假装是精修立绘。用户想换成自己的图，在角色编辑器里选本地图片即可。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

/** XML 文本转义（名字里可能有 & < > 等字符）。 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 情绪 → 中文标签（与角色编辑器里的选项保持一致）。 */
const EMOTION_LABELS: Record<CharacterEmotion, string> = {
  neutral: "平静",
  happy: "开心",
  sad: "难过",
  angry: "生气",
  shy: "害羞",
  surprised: "惊讶",
  thinking: "思考",
  sleepy: "困倦",
};

/** 眼睛画法（按情绪挑一种）。 */
function eyesPath(emotion: CharacterEmotion, cx: number, cy: number): string {
  const left = cx - 22;
  const right = cx + 22;
  switch (emotion) {
    case "happy":
      return `<path d="M${left - 10} ${cy + 4} q10 -12 20 0" /><path d="M${right - 10} ${cy + 4} q10 -12 20 0" />`;
    case "sad":
      return `<path d="M${left - 10} ${cy - 4} q10 12 20 0" /><path d="M${right - 10} ${cy - 4} q10 12 20 0" />`;
    case "shy":
    case "sleepy":
      return `<path d="M${left - 10} ${cy} q10 10 20 0" /><path d="M${right - 10} ${cy} q10 10 20 0" />`;
    case "angry":
      return `<path d="M${left - 10} ${cy - 6} l20 6" /><path d="M${right - 10} ${cy} l20 -6" />`;
    case "surprised":
      return `<circle cx="${left}" cy="${cy}" r="7" /><circle cx="${right}" cy="${cy}" r="7" />`;
    case "thinking":
      return `<path d="M${left - 10} ${cy} h20" /><path d="M${right - 10} ${cy - 4} h20" />`;
    case "neutral":
    default:
      return `<circle cx="${left}" cy="${cy}" r="4.5" /><circle cx="${right}" cy="${cy}" r="4.5" />`;
  }
}

/** 嘴形（按情绪挑一种）。 */
function mouthPath(emotion: CharacterEmotion, cx: number, cy: number): string {
  switch (emotion) {
    case "happy":
      return `<path d="M${cx - 14} ${cy} q14 14 28 0" />`;
    case "sad":
    case "angry":
      return `<path d="M${cx - 12} ${cy + 6} q12 -12 24 0" />`;
    case "surprised":
      return `<ellipse cx="${cx}" cy="${cy + 2}" rx="8" ry="10" />`;
    case "shy":
      return `<path d="M${cx - 8} ${cy + 2} q8 6 16 0" />`;
    case "sleepy":
      return `<path d="M${cx - 8} ${cy + 2} q8 4 16 0" />`;
    case "thinking":
      return `<path d="M${cx - 10} ${cy + 2} h20" />`;
    case "neutral":
    default:
      return `<path d="M${cx - 10} ${cy} q10 6 20 0" />`;
  }
}

/**
 * 生成一张占位立绘（竖构图，5:8）。
 *
 * @param name 角色名（用于底部标注与配色区分）
 * @param emotion 情绪
 * @param hue 主色相 0~360，用来让不同角色有不同的底色
 */
export function buildPlaceholderSprite(
  name: string,
  emotion: CharacterEmotion,
  hue: number,
): string {
  const safeName = escapeXml(name.slice(0, 8));
  const label = EMOTION_LABELS[emotion];
  const head = 150;
  const faceY = 132;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 480" width="300" height="480">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hue} 62% 92%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue} 46% 78%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="300" height="480" rx="24" fill="url(#bg)"/>`,
    // 肩部与身体
    `<path d="M60 480 q0 -120 90 -120 q90 0 90 120 z" fill="hsl(${hue} 40% 62%)" opacity="0.85"/>`,
    // 头部
    `<circle cx="150" cy="${faceY}" r="78" fill="hsl(${hue} 40% 96%)"/>`,
    // 头发
    `<path d="M72 ${faceY - 6} q8 -86 78 -86 q70 0 78 86 q-26 -34 -78 -34 q-52 0 -78 34 z" fill="hsl(${hue} 34% 46%)"/>`,
    `<g fill="none" stroke="hsl(${hue} 30% 26%)" stroke-width="5" stroke-linecap="round">`,
    eyesPath(emotion, head, faceY),
    mouthPath(emotion, head, faceY + 34),
    `</g>`,
    `<text x="150" y="452" text-anchor="middle" font-family="sans-serif" font-size="22" fill="hsl(${hue} 30% 30%)">${safeName} · ${label}</text>`,
    `</svg>`,
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 生成一张占位头像（正方形，取名字首字）。
 * 有它就不必依赖各处的 CSS 占位，任何 `<img src>` 都能拿到一张有效图片。
 */
export function buildPlaceholderAvatar(name: string, hue: number): string {
  const initial = escapeXml(name.trim().slice(0, 1) || "?");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hue} 68% 76%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue + 24} 58% 62%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="256" height="256" rx="48" fill="url(#bg)"/>`,
    `<text x="128" y="168" text-anchor="middle" font-family="sans-serif" font-size="112" font-weight="600" fill="#ffffff">${initial}</text>`,
    `</svg>`,
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
