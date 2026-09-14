/**
 * @file EngineManager.ts
 * 多引擎实例管理器。每个会话拥有独立的 RealismEngine 实例。
 *
 * 职责：
 * - Map<sessionId, RealismEngine> 懒创建与缓存
 * - dispose 单个 / 全部引擎
 * - 共享 LLM adapter 单例
 */

import { RealismEngine } from "./RealismEngine";
import type { ICharacterProfile, ISimulationConfig, ILLMConfig } from "@wechat-rp/shared-types";

export interface IEngineManagerOptions {
  readonly userId: string;
  readonly defaultConfig: ISimulationConfig;
}

export class EngineManager {
  private readonly engines = new Map<string, RealismEngine>();
  private readonly userId: string;
  private readonly defaultConfig: ISimulationConfig;
  private sharedLLMConfig: ILLMConfig | null = null;

  constructor(opts: IEngineManagerOptions) {
    this.userId = opts.userId;
    this.defaultConfig = opts.defaultConfig;
  }

  /**
   * 获取或创建会话引擎。
   * 如果引擎已存在，则把最新角色档案推送进去再返回——
   * 角色编辑器改动的作息 / 性格 / 人设需要立刻生效，
   * 否则用户改完设置却发现当前会话仍按旧档案运行（要刷新页面才生效）。
   */
  getOrCreate(
    sessionId: string,
    profile: ICharacterProfile,
    configOverride?: Partial<ISimulationConfig>,
  ): RealismEngine {
    const existing = this.engines.get(sessionId);
    if (existing) {
      existing.updateProfile(profile);
      return existing;
    }

    const engine = new RealismEngine({
      profile,
      config: { ...this.defaultConfig, ...configOverride },
      sessionId,
      userId: this.userId,
    });

    if (this.sharedLLMConfig) {
      engine.setLLMConfig(this.sharedLLMConfig);
    }

    this.engines.set(sessionId, engine);
    return engine;
  }

  /** 获取已有引擎（不创建）。 */
  get(sessionId: string): RealismEngine | undefined {
    return this.engines.get(sessionId);
  }

  /** 销毁单个会话引擎。 */
  dispose(sessionId: string): void {
    const engine = this.engines.get(sessionId);
    if (engine) {
      engine.abort("session-disposed");
      this.engines.delete(sessionId);
    }
  }

  /** 销毁所有引擎。 */
  disposeAll(): void {
    for (const engine of this.engines.values()) {
      engine.abort("manager-disposed");
    }
    this.engines.clear();
  }

  /**
   * 只保留给定会话的引擎，其余销毁。
   *
   * 用途：会话被删除（或角色被删除连带删会话）后，它的引擎不该继续留在池子里。
   * 引擎常驻之后不再随"切换会话"销毁，必须显式收口，否则会泄漏。
   */
  retainOnly(sessionIds: ReadonlyArray<string>): void {
    const keep = new Set(sessionIds);
    for (const [sessionId, engine] of [...this.engines]) {
      if (keep.has(sessionId)) continue;
      engine.abort("session-removed");
      this.engines.delete(sessionId);
    }
  }

  /** 设置共享 LLM 配置，同步到所有已创建的引擎。 */
  setLLMConfig(config: ILLMConfig): void {
    this.sharedLLMConfig = config;
    for (const engine of this.engines.values()) {
      engine.setLLMConfig(config);
    }
  }

  /** 更新所有引擎的拟真配置。 */
  updateAllConfigs(patch: Partial<ISimulationConfig>): void {
    for (const engine of this.engines.values()) {
      engine.updateConfig(patch);
    }
  }

  /** 获取活跃引擎数量。 */
  get size(): number {
    return this.engines.size;
  }
}
