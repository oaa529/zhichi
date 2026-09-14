/**
 * @file pacingPresets.ts
 * 回复节奏预设。
 *
 * 拟真参数彼此耦合（打字速度 × 犹豫概率 × 气泡间隔上限），
 * 逐项调节很难调到"顺手"的组合，这里提供三档一键预设。
 */

import type { ISimulationConfig } from "@wechat-rp/shared-types";

/** 节奏档位标识。 */
export type PacingPresetId = "chatty" | "standard" | "slow";

/** 档位定义。 */
export interface IPacingPreset {
  readonly id: PacingPresetId;
  readonly label: string;
  /** 说明文案（告诉用户这档的体感）。 */
  readonly hint: string;
  /** 该档位覆盖的拟真参数。 */
  readonly patch: Partial<ISimulationConfig>;
}

/** 三档节奏预设（默认档 = standard）。 */
export const PACING_PRESETS: ReadonlyArray<IPacingPreset> = [
  {
    id: "chatty",
    label: "轻快闲聊",
    hint: "秒回感更强，气泡间隔短",
    patch: {
      typingSpeedCpm: "fast",
      hesitationProbability: 0.05,
      maxInterChunkDelayMs: 1500,
    },
  },
  {
    id: "standard",
    label: "标准",
    hint: "接近普通人的聊天节奏",
    patch: {
      typingSpeedCpm: "normal",
      hesitationProbability: 0.15,
      maxInterChunkDelayMs: 3500,
    },
  },
  {
    id: "slow",
    label: "慢热",
    hint: "打字更慢、停顿更多，适合沉浸式 RP",
    patch: {
      typingSpeedCpm: "slow",
      hesitationProbability: 0.25,
      maxInterChunkDelayMs: 6000,
    },
  },
];

/** 按 id 取预设；未知 id 返回 null。 */
export function getPacingPreset(id: string): IPacingPreset | null {
  return PACING_PRESETS.find((preset) => preset.id === id) ?? null;
}
