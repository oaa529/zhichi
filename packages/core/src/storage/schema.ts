/**
 * @file schema.ts
 * DB schema 版本与迁移函数。
 *
 * 用于 zustand persist 的 version + migrate 配置。
 * 未来字段变更时递增 SCHEMA_VERSION 并添加迁移逻辑。
 */

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 3;

/**
 * 迁移函数：将旧版本快照迁移到当前版本。
 *
 * v1 → v2：多会话架构重构。
 *   - 旧 chatStore 的消息没有 sessionId，且属于单会话时代。
 *   - 多会话架构下，chatStore 仅作为活跃会话的运行时缓存，
 *     消息真正归属由 sessionStore.sessionRuntimes 管理。
 *   - 迁移策略：重置 chatStore（返回 null），让 App.tsx 从 sessionStore 重新加载。
 *
 * v2 → v3：新增长期记忆与剧情字段（sessionStore.memories / plotStates /
 * digestCursors / digestConfig）。旧快照缺少这些字段时，由 zustand persist 的
 * 浅合并自动用初始值（空对象 / 默认配置）补齐，因此无需额外转换。
 *
 * @param persistedState 旧版本的持久化状态
 * @param version 旧版本号
 * @returns 迁移后的状态
 */
export function migrateSnapshot<T>(
  persistedState: unknown,
  version: number,
): T | null {
  if (persistedState === null || persistedState === undefined) {
    return null;
  }

  // v0/v1 → v2：单会话 → 多会话架构，旧数据无法归属到具体会话，重置
  if (version < 2) {
    return null;
  }

  // 当前版本，无需迁移
  return persistedState as T;
}
