/**
 * @file TypingSimulator.ts
 * 打字模拟器：根据角色性格与拟真配置，为每个 MessageChunk 计算：
 * - preDeliveryDelayMs: 该 chunk 距离上一条送达的延迟
 * - revealDelays: chunk 内逐字揭示延迟（打字机动画）
 * - 错别字注入与自动纠错时间点
 * - 是否触发"对方正在输入..."指示器
 *
 * 关键算法：使用正态分布采样延迟，避免机械感。
 */

import type {
  ICharacterProfile,
  ISimulationConfig,
  TypingSpeedPreset,
} from "@wechat-rp/shared-types";

import type { ITypingPlan, MessageChunk } from "./types";

/** 各档位对应每分钟字符数。 */
const SPEED_CPM: Record<TypingSpeedPreset, number> = {
  slow: 120,
  normal: 200,
  fast: 300,
  turbo: 450,
};

/**
 * 随机源接口：可注入的伪随机生成器。
 * 生产环境使用 Math.random；测试环境注入 seeded RNG 保证可复现性。
 */
export interface IRandomSource {
  /** 返回 [0, 1) 区间均匀分布的浮点数。 */
  next(): number;
}

/** 默认随机源：基于 Math.random。 */
const defaultRandom: IRandomSource = {
  next: () => Math.random(),
};

/**
 * Box-Muller 正态分布采样。返回均值 μ、标准差 σ 的样本。
 * 用于让延迟呈现自然抖动。
 *
 * @param rng 可注入随机源，默认 Math.random
 */
function gaussianSample(mean: number, sigma: number, rng: IRandomSource = defaultRandom): number {
  // 伪随机：用 rng 生成两个 (0,1) 样本
  const u1 = Math.max(Number.EPSILON, rng.next());
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sigma;
}

/** 把延迟 clamp 到 [min, max]，避免极端抖动破坏体验。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 错别字字典：近形/近音替换候选。
 * 实际生产应外置为可扩展资源，此处仅示例。
 */
const TYPO_MAP: ReadonlyArray<readonly [string, string]> = [
  ["的", "得"],
  ["了", "嘞"],
  ["是", "事"],
  ["在", "再"],
  ["呢", "勒"],
];

export class TypingSimulator {
  private readonly rng: IRandomSource;

  constructor(
    private readonly profile: ICharacterProfile,
    private readonly config: ISimulationConfig,
    rng?: IRandomSource,
  ) {
    this.rng = rng ?? defaultRandom;
  }

  /**
   * 为单个 chunk 生成打字时序规划。
   *
   * 算法步骤：
   * 1. 计算 baseDelay = chunkText.length / (cpm * personalityMultiplier) * 60000
   * 2. 叠加 gaussian 抖动
   * 3. 注入 hesitationProbability: 随机增加 800~3000ms 思考停顿
   * 4. revealDelays[i] = basePerChar * (0.6 ~ 1.4) 随机
   * 5. typoRate: 随机选 chunk 内一个字符替换为错字，correctAt = revealTime + 800ms
   */
  public plan(chunk: MessageChunk, isFirst: boolean): ITypingPlan {
    const cpm = SPEED_CPM[this.config.typingSpeedCpm];
    const multiplier = this.profile.personalityTraits.typingSpeedMultiplier;
    const effectiveCpm = cpm * multiplier;
    const charCount = chunk.text.length;

    // 基础逐字延迟
    const basePerCharMs = 60000 / effectiveCpm;
    const revealDelays: number[] = new Array<number>(charCount);
    let cursor = 0;
    for (let i = 0; i < charCount; i += 1) {
      const jitter = gaussianSample(1, 0.25, this.rng);
      const perChar = basePerCharMs * clamp(jitter, 0.5, 1.6);
      cursor += perChar;
      revealDelays[i] = Math.round(cursor);
    }

    // 预送达延迟（两条 bubble 之间的停顿）
    let preDelay = 0;
    if (!isFirst) {
      const baseInterDelay = charCount * basePerCharMs * 0.4;
      preDelay = clamp(
        gaussianSample(baseInterDelay, baseInterDelay * 0.3, this.rng),
        200,
        this.config.maxInterChunkDelayMs,
      );
      // 犹豫概率
      if (this.rng.next() < this.config.hesitationProbability) {
        preDelay += clamp(gaussianSample(2000, 800, this.rng), 800, 5000);
      }
    }

    // 错别字注入
    const containsTypo =
      charCount > 4 && this.rng.next() < this.config.typoRate;
    let typoCorrectAtMs: number | null = null;
    if (containsTypo) {
      // 选取 chunk 中部某个字符，标记纠错时间点
      const typoIdx = Math.floor(charCount / 2);
      const revealAt = revealDelays[typoIdx] ?? cursor;
      typoCorrectAtMs = revealAt + 800;
    }

    return {
      preDeliveryDelayMs: Math.round(preDelay),
      revealDelays,
      triggersTypingIndicator: charCount > 6 || preDelay > 1000,
      containsTypo,
      typoCorrectAtMs,
    };
  }

  /**
   * 应用错别字替换：返回带错字的 chunk 文本（UI 渲染时使用）。
   * 纠错时间点到达后，UI 用正字替换。
   */
  public applyTypo(text: string): { typoText: string; correctedText: string } {
    if (text.length < 4) {
      return { typoText: text, correctedText: text };
    }
    // 选取一个出现在 TYPO_MAP 中的字符
    const candidates: Array<{ idx: number; wrong: string; right: string }> = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === undefined) continue;
      for (const [right, wrong] of TYPO_MAP) {
        if (ch === right) {
          candidates.push({ idx: i, wrong, right });
          break;
        }
      }
    }
    if (candidates.length === 0) {
      return { typoText: text, correctedText: text };
    }
    const pick = candidates[Math.floor(this.rng.next() * candidates.length)]!;
    const typoText =
      text.slice(0, pick.idx) + pick.wrong + text.slice(pick.idx + 1);
    return { typoText, correctedText: text };
  }

  /** 估算"对方正在输入"剩余时长（粗略）。 */
  public estimateTypingDurationMs(totalChars: number): number {
    const cpm = SPEED_CPM[this.config.typingSpeedCpm];
    const multiplier = this.profile.personalityTraits.typingSpeedMultiplier;
    return Math.round((totalChars / (cpm * multiplier)) * 60000);
  }
}

/** 导出供引擎注入的错别字字典类型，便于扩展。 */
export type TypoDictionary = ReadonlyArray<readonly [string, string]>;
