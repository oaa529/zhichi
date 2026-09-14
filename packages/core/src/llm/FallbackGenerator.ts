/**
 * @file FallbackGenerator.ts
 * 角色 fallback 拟真回复生成器。
 *
 * 职责：
 * - 当 LLM 调用失败（重试耗尽/超时/错误）时，生成符合角色性格的短句
 * - 依据 personalityTraits.archetype + presence 状态选择回复模板
 * - 保证 UI 永不白屏/卡死
 *
 * 纯函数，无副作用。
 */

import type { ICharacterProfile } from "@wechat-rp/shared-types";
import type { IPresenceDecision } from "../PresenceManager";

/** 角色原型分类。 */
type Archetype = ICharacterProfile["personalityTraits"]["archetype"];

/**
 * Fallback 回复模板库。
 * 按角色原型 + 在场状态分类。
 */
const FALLBACK_TEMPLATES: Record<Archetype, {
  online: ReadonlyArray<string>;
  sleeping: ReadonlyArray<string>;
}> = {
  gentle: {
    online: [
      "嗯…我刚才走神了。",
      "抱歉，信号不太好。",
      "我在的，稍等一下。",
    ],
    sleeping: [
      "嗯…",
      "（揉眼睛）",
      "我先睡了…晚点聊。",
    ],
  },
  energetic: {
    online: [
      "啊！刚才断线了！",
      "等等等等我来了！",
      "网络你给我站住！",
    ],
    sleeping: [
      "唔…困…",
      "（翻了个身）",
      "明早再聊…",
    ],
  },
  serious: {
    online: [
      "…信号问题。",
      "刚断了一下。",
      "继续。",
    ],
    sleeping: [
      "…睡了。",
      "（已读不回）",
      "明天说。",
    ],
  },
  playful: {
    online: [
      "哎呀断网了！",
      "呜呜呜网络你不要走！",
      "等我一下下！",
    ],
    sleeping: [
      "唔…不要吵…",
      "（抱紧枕头）",
      "明天找你玩…",
    ],
  },
  reserved: {
    online: [
      "…断了一下。",
      "在。",
      "信号不好。",
    ],
    sleeping: [
      "…嗯。",
      "（安静）",
      "明天。",
    ],
  },
  "night-owl": {
    online: [
      "刚网络抽了一下。",
      "还在的，夜深了。",
      "断线了，重新连。",
    ],
    sleeping: [
      "难得早睡…",
      "（翻了个身）",
      "明天晚上聊…",
    ],
  },
};

/**
 * 生成 fallback 回复。
 *
 * @param profile 角色档案
 * @param sleepDecision 睡眠决策（来自 PresenceManager.evaluate()）
 * @returns fallback 短句（2-12 字）
 */
export function generateFallback(
  profile: ICharacterProfile,
  sleepDecision?: IPresenceDecision,
): string {
  const archetype = profile.personalityTraits.archetype;
  const templates = FALLBACK_TEMPLATES[archetype] ?? FALLBACK_TEMPLATES.gentle;

  const pool = sleepDecision?.isSleeping ? templates.sleeping : templates.online;

  // 伪随机选择（不用 Math.random，保证可测试）
  const idx = Date.now() % pool.length;
  const fallback = pool[idx] ?? templates.online[0] ?? "…";

  return fallback;
}
