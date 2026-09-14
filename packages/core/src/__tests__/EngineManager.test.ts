/**
 * @file EngineManager.test.ts
 * 多会话引擎管理测试：重点是"角色编辑后档案更新到已存在引擎"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ICharacterProfile,
  ISimulationConfig,
} from "@wechat-rp/shared-types";
import { EngineManager } from "../EngineManager";
import { createMockAdapter } from "../llm/MockAdapter";
import type { ILLMConfigInternal } from "../llm/types";

const llmConfig: ILLMConfigInternal = {
  baseURL: "http://localhost",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 30000,
  maxRetries: 0,
  temperature: 0.8,
  maxTokens: 100,
};

const simulationConfig: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: true,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

const baseProfile: ICharacterProfile = {
  id: "char-1",
  displayName: "测试角色",
  bio: "测试用",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: true,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.3,
    hesitationProbability: 0,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

describe("EngineManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一会话复用同一引擎实例", () => {
    const manager = new EngineManager({
      userId: "user-1",
      defaultConfig: simulationConfig,
    });
    const first = manager.getOrCreate("s1", baseProfile);
    const second = manager.getOrCreate("s1", baseProfile);
    expect(second).toBe(first);
    expect(manager.size).toBe(1);
  });

  it("retainOnly：只保留还在的会话，其余引擎被收掉（删会话后不泄漏）", () => {
    const manager = new EngineManager({
      userId: "user-1",
      defaultConfig: simulationConfig,
    });
    manager.getOrCreate("s1", baseProfile);
    manager.getOrCreate("s2", baseProfile);
    manager.getOrCreate("s3", baseProfile);
    expect(manager.size).toBe(3);

    manager.retainOnly(["s1", "s3"]);

    expect(manager.size).toBe(2);
    expect(manager.get("s2")).toBeUndefined();
    // 保留的引擎还是同一个实例（不能顺手重建）
    expect(manager.get("s1")).toBeDefined();
  });

  it("retainOnly 传空数组等于清空全部引擎", () => {
    const manager = new EngineManager({
      userId: "user-1",
      defaultConfig: simulationConfig,
    });
    manager.getOrCreate("s1", baseProfile);
    manager.retainOnly([]);
    expect(manager.size).toBe(0);
  });

  it("角色档案更新后推送给已存在引擎：改为睡眠静默后立即不再回复", () => {
    // 固定"当前时间"，构造一个把角色夹在中间的睡眠窗口
    vi.setSystemTime(new Date(2026, 8, 12, 14, 0, 0));

    const manager = new EngineManager({
      userId: "user-1",
      defaultConfig: simulationConfig,
    });
    const engine = manager.getOrCreate("s1", baseProfile);
    const adapter = createMockAdapter({ config: llmConfig, tokenIntervalMs: 5 });

    // 对照组：编辑前（14:00 不在 23:30~07:30 睡眠窗口）能正常启动
    expect(engine.startStreamWithAdapter("你好", adapter)).toBe(true);
    // 复位本轮流（abort 会重置 streamInProgress），保持同一引擎实例
    engine.abort("test-reset");

    // 编辑器把角色改为"13:59~14:01 睡眠 + 静默"，并重新获取引擎
    const sleepingProfile: ICharacterProfile = {
      ...baseProfile,
      schedule: {
        wakeTime: "14:01",
        sleepTime: "13:59",
        scheduleEnabled: true,
        timezone: "Asia/Shanghai",
        sleepReplyPolicy: "silent",
      },
    };
    const sameEngine = manager.getOrCreate("s1", sleepingProfile);
    expect(sameEngine).toBe(engine);

    // 档案更新应立刻生效：silent 睡眠策略下不启动 LLM
    expect(sameEngine.startStreamWithAdapter("睡了吗", adapter)).toBe(false);
  });
});
