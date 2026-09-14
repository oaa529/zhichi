/**
 * @file BackupFile.ts
 * 数据备份：导出文件构造 / 容错解析 / 非破坏性合并。
 *
 * 全部为纯函数，不触碰 IndexedDB 与 DOM——文件读写与 store 落库
 * 由组装层（apps/web/src/backupRunner.ts）负责。
 *
 * 合并语义（导入时**不删除**任何现有数据）：
 * - 记录型（会话/角色/通讯录/提示词模板）：同 ID 以导入文件为准，新 ID 追加
 * - 记忆：按 ID 求并集，两边都不丢
 * - 剧情：事件按 ID 求并集；状态卡取 `updatedAt` 更新的那一份
 * - 消息：按消息 ID 去重后按时间排序
 * - 输入草稿：本地非空的保留（避免覆盖用户正在打的内容）
 * - 活跃会话：本地有则保留，否则用导入文件里的
 * - 用户人设「关于你」：以导入文件为准；文件里没有就保留本地的
 * - 整理账本：按完成时间求并集（这些报告没有 ID，只有 `at`）
 */

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupParseResult,
  type IBackupCounts,
  type IBackupFile,
  type IBackupPayload,
  type IDigestReport,
  type IPlotEvent,
  type IPlotState,
  type ISessionRuntimeSnapshot,
} from "@wechat-rp/shared-types";

/** 判断是否为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取对象字段，非对象时返回空对象（用于容错归一化）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * 把字段当成目标类型使用：非对象一律退化成空对象。
 *
 * 这里刻意不做逐字段深校验——备份数据量大、字段多，逐字段校验既冗长
 * 又容易在加字段时漏改；结构不对的条目会在 UI 渲染或迁移阶段被自然丢弃。
 * 契约层只保证"顶层是可用的记录"，让导入尽可能成功。
 */
function asTyped<T>(value: unknown): T {
  return asRecord(value) as unknown as T;
}

/**
 * 从运行时消息里读消息 ID。
 * 备份里的消息是 `IMessageRuntime` 形状，但 core 层不认识该类型，
 * 因此按结构读取，读不到就返回 null（调用方按"无法去重"处理）。
 */
function messageIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = value.message;
  if (!isRecord(message)) return null;
  const id = message.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** 从运行时消息里读时间戳，读不到按 0 处理。 */
function messageTimeOf(value: unknown): number {
  if (!isRecord(value)) return 0;
  const message = value.message;
  if (!isRecord(message)) return 0;
  const timestamp = message.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

/** 统计备份里的消息总数。 */
export function countBackupMessages(payload: IBackupPayload): number {
  let total = 0;
  for (const runtime of Object.values(payload.sessionRuntimes)) {
    const messages = (runtime as { messages?: unknown }).messages;
    if (Array.isArray(messages)) total += messages.length;
  }
  return total;
}

/** 汇总备份统计信息。 */
export function countBackup(payload: IBackupPayload): IBackupCounts {
  let memories = 0;
  for (const list of Object.values(payload.memories)) {
    if (Array.isArray(list)) memories += list.length;
  }
  return {
    sessions: Object.keys(payload.sessions).length,
    characters: Object.keys(payload.characters).length,
    memories,
    messages: countBackupMessages(payload),
  };
}

/**
 * 构造备份文件对象。
 *
 * @param payload 当前 store 的持久化快照
 * @param now 导出时间（测试可注入）
 */
export function buildBackup(
  payload: IBackupPayload,
  now: number = Date.now(),
): IBackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    counts: countBackup(payload),
    data: payload,
  };
}

/**
 * 序列化为可直接写盘的 JSON 文本。
 * 带缩进是为了让文件在文本编辑器里可读、可手工抢救。
 */
export function serializeBackup(file: IBackupFile): string {
  return JSON.stringify(file, null, 2);
}

/** 把任意输入归一化为合法备份内容（缺字段补空，类型不符则丢弃该字段）。 */
function normalizePayload(value: unknown): IBackupPayload | null {
  if (!isRecord(value)) return null;
  const raw = value;

  const activeSessionId = raw.activeSessionId;

  return {
    sessions: asTyped(raw.sessions),
    activeSessionId:
      typeof activeSessionId === "string" && activeSessionId
        ? activeSessionId
        : null,
    sessionRuntimes: asTyped(raw.sessionRuntimes),
    drafts: asTyped(raw.drafts),
    contacts: asTyped(raw.contacts),
    characters: asTyped(raw.characters),
    promptTemplates: asTyped(raw.promptTemplates),
    apiConfig: asTyped(raw.apiConfig),
    realtimeAIConfig: asTyped(raw.realtimeAIConfig),
    memories: asTyped(raw.memories),
    loreEntries: asTyped(raw.loreEntries),
    plotStates: asTyped(raw.plotStates),
    digestCursors: asTyped(raw.digestCursors),
    digestConfig: asTyped(raw.digestConfig),
    /**
     * 可选字段。
     *
     * 这里是**显式白名单**：备份文件是外部输入，不能把任意字段（比如有人
     * 手工塞进来的 apiKey）原样带进内存，所以不用 `...raw`。
     * 代价是——**以后往 IBackupPayload 加字段，必须同时改这里、
     * mergeBackup 与 applySnapshot**，否则换机器还原时它会安静地消失
     * （`userProfile` 就是这么丢过一次的，BackupFile.test.ts 里有守卫用例）。
     */
    // 人设是对象（不是 record 映射），缺失时留 undefined，别变成 {}
    userProfile: isRecord(raw.userProfile)
      ? (raw.userProfile as unknown as IBackupPayload["userProfile"])
      : undefined,
    digestReports: asTyped(raw.digestReports),
  };
}

/**
 * 容错解析备份文本。
 *
 * 逐层校验：空内容 → JSON 语法 → 文件标识 → 版本 → data 结构。
 * 任何一层不通过都返回可读原因，绝不抛异常。
 */
export function parseBackup(raw: string): BackupParseResult {
  if (!raw || !raw.trim()) return { ok: false, error: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "not-backup" };

  if (parsed.format !== BACKUP_FORMAT) {
    return { ok: false, error: "not-backup" };
  }

  const version = parsed.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return { ok: false, error: "not-backup" };
  }
  if (version > BACKUP_VERSION) {
    return { ok: false, error: "version-too-new" };
  }

  const payload = normalizePayload(parsed.data);
  if (!payload) return { ok: false, error: "bad-payload" };

  const exportedAt =
    typeof parsed.exportedAt === "number" && Number.isFinite(parsed.exportedAt)
      ? parsed.exportedAt
      : 0;

  return {
    ok: true,
    file: {
      format: BACKUP_FORMAT,
      version,
      exportedAt,
      counts: countBackup(payload),
      data: payload,
    },
  };
}

/**
 * 合并两批运行时消息：按消息 ID 去重（导入文件优先），按时间升序排列。
 * 读不到 ID 的消息一律保留，宁可重复也不丢内容。
 */
export function mergeRuntimeMessages(
  local: ReadonlyArray<unknown>,
  incoming: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const byId = new Map<string, unknown>();
  const idless: unknown[] = [];

  const collect = (items: ReadonlyArray<unknown>): void => {
    for (const item of items) {
      const id = messageIdOf(item);
      if (id) byId.set(id, item);
      else idless.push(item);
    }
  };
  collect(local);
  collect(incoming);

  // Array.prototype.sort 在现代 JS 引擎里是稳定排序，同时间戳保持插入顺序
  return [...byId.values(), ...idless].sort(
    (a, b) => messageTimeOf(a) - messageTimeOf(b),
  );
}

/**
 * 合并"角色 ID → 条目数组"这类映射（记忆与世界书同构）：
 * 按条目 ID 求并集，同 ID 以导入文件为准。
 */
function mergeEntryMap<T extends { readonly id: string }>(
  local: Record<string, ReadonlyArray<T>>,
  incoming: Record<string, ReadonlyArray<T>>,
): Record<string, ReadonlyArray<T>> {
  const result: Record<string, ReadonlyArray<T>> = { ...local };
  for (const [characterId, list] of Object.entries(incoming)) {
    if (!Array.isArray(list)) continue;
    const existing = result[characterId] ?? [];
    const byId = new Map<string, T>();
    for (const memory of existing) {
      if (memory && typeof memory.id === "string") byId.set(memory.id, memory);
    }
    for (const memory of list) {
      if (memory && typeof memory.id === "string") byId.set(memory.id, memory);
    }
    result[characterId] = [...byId.values()];
  }
  return result;
}

/**
 * 合并整理账本（每会话**最近一次**整理的摘要）。
 *
 * 每个会话只留一条，所以不求和、只比新旧：谁的时间戳更晚用谁的。
 */
function mergeReportMap(
  local: Record<string, IDigestReport>,
  incoming: Record<string, IDigestReport>,
): Record<string, IDigestReport> {
  const result: Record<string, IDigestReport> = { ...local };
  for (const [sessionId, report] of Object.entries(incoming)) {
    if (!report || typeof report.at !== "number") continue;
    const current = result[sessionId];
    if (!current || report.at >= current.at) result[sessionId] = report;
  }
  return result;
}

/** 合并剧情：事件按 ID 求并集；状态卡取更新时间更晚的一份。 */
function mergePlotMap(
  local: IBackupPayload["plotStates"],
  incoming: IBackupPayload["plotStates"],
): IBackupPayload["plotStates"] {
  const result: Record<string, IPlotState> = { ...local };
  for (const [sessionId, state] of Object.entries(incoming)) {
    if (!state || typeof state !== "object") continue;
    const current = result[sessionId];
    if (!current) {
      result[sessionId] = state;
      continue;
    }

    const eventsById = new Map<string, IPlotEvent>();
    for (const event of current.events ?? []) {
      if (event && typeof event.id === "string") eventsById.set(event.id, event);
    }
    for (const event of state.events ?? []) {
      if (event && typeof event.id === "string") eventsById.set(event.id, event);
    }
    const events = [...eventsById.values()].sort((a, b) => a.at - b.at);

    const localUpdated = current.updatedAt ?? 0;
    const incomingUpdated = state.updatedAt ?? 0;
    const card = incomingUpdated >= localUpdated ? state : current;
    result[sessionId] = { ...card, events };
  }
  return result;
}

/** 合并会话运行时快照：消息求并集，其余字段以导入文件为准。 */
function mergeRuntimeMap(
  local: IBackupPayload["sessionRuntimes"],
  incoming: IBackupPayload["sessionRuntimes"],
): IBackupPayload["sessionRuntimes"] {
  const result: Record<string, ISessionRuntimeSnapshot> = { ...local };
  for (const [sessionId, runtime] of Object.entries(incoming)) {
    if (!runtime || typeof runtime !== "object") continue;
    const current = result[sessionId];
    if (!current) {
      result[sessionId] = runtime;
      continue;
    }
    result[sessionId] = {
      ...runtime,
      messages: mergeRuntimeMessages(
        current.messages ?? [],
        runtime.messages ?? [],
      ),
    };
  }
  return result;
}

/** 合并草稿：本地非空的保留，其余用导入文件补齐。 */
function mergeDrafts(
  local: IBackupPayload["drafts"],
  incoming: IBackupPayload["drafts"],
): IBackupPayload["drafts"] {
  const result: Record<string, string> = { ...incoming };
  for (const [sessionId, text] of Object.entries(local)) {
    if (text) result[sessionId] = text;
  }
  return result;
}

/**
 * 把导入的备份合并进本地数据（不删除任何本地内容）。
 *
 * @param local 当前本地快照
 * @param incoming 备份文件里的快照
 * @returns 合并后的快照（不修改入参）
 */
export function mergeBackup(
  local: IBackupPayload,
  incoming: IBackupPayload,
): IBackupPayload {
  const merged: IBackupPayload = {
    sessions: { ...local.sessions, ...incoming.sessions },
    characters: { ...local.characters, ...incoming.characters },
    contacts: { ...local.contacts, ...incoming.contacts },
    promptTemplates: { ...local.promptTemplates, ...incoming.promptTemplates },
    memories: mergeEntryMap(local.memories, incoming.memories),
    loreEntries: mergeEntryMap(local.loreEntries ?? {}, incoming.loreEntries ?? {}),
    plotStates: mergePlotMap(local.plotStates, incoming.plotStates),
    sessionRuntimes: mergeRuntimeMap(
      local.sessionRuntimes,
      incoming.sessionRuntimes,
    ),
    drafts: mergeDrafts(local.drafts, incoming.drafts),
    // 配置类：以导入文件为准（这正是"换机器还原"想要的）
    apiConfig: incoming.apiConfig,
    realtimeAIConfig: incoming.realtimeAIConfig,
    digestConfig: incoming.digestConfig,
    // 用户自己写的人设：同样是"以导入文件为准"，但没有就保留本地的
    userProfile: incoming.userProfile ?? local.userProfile,
    digestReports: mergeReportMap(
      local.digestReports ?? {},
      incoming.digestReports ?? {},
    ),
    digestCursors: { ...local.digestCursors, ...incoming.digestCursors },
    activeSessionId: null,
  };

  // 活跃会话：本地有且仍然存在就用本地的，否则回退到导入文件指定的那个，
  // 再否则取排序后的第一个会话——保证导入后不会停在"无会话"界面。
  const candidates = [
    local.activeSessionId,
    incoming.activeSessionId,
    ...Object.keys(merged.sessions).sort(),
  ];
  const activeSessionId =
    candidates.find((id) => !!id && !!merged.sessions[id]) ?? null;

  return { ...merged, activeSessionId };
}
