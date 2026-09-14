/**
 * @file emotionLabel.ts
 * 情绪枚举 → 中文标签。
 *
 * 之前这套映射只存在于角色编辑器的下拉选项里，立绘查看器直接把
 * 枚举值（"happy"）显示给用户看。抽出来一处维护，两边都用。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

/** 八种情绪的中文标签（顺序与枚举一致）。 */
export const EMOTION_LABELS: Record<CharacterEmotion, string> = {
  neutral: "平静",
  happy: "开心",
  sad: "难过",
  angry: "生气",
  shy: "害羞",
  surprised: "惊讶",
  thinking: "思考",
  sleepy: "困倦",
};

/** 取情绪中文名；遇到未知值原样返回（不显示空白）。 */
export function emotionLabel(emotion: string): string {
  return EMOTION_LABELS[emotion as CharacterEmotion] ?? emotion;
}
