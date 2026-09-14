/**
 * @file sanitize.ts
 * 持久化快照的容错清洗。
 *
 * 由来：一次实测中发现，只要 IndexedDB 里的 sessions 混进一个 null
 * （写入中断、手工改过、旧版本遗留都可能），应用启动时就会在 useEffect
 * 里抛 TypeError 并**整页白屏**——而且错误边界救不了：React 的错误边界
 * 只能接住渲染期异常，接不住 effect 里的。
 *
 * 所以真正的修法是"进门先过安检"：hydration 时把结构不对的条目丢掉，
 * 让坏数据只损失它自己，而不是让整个应用打不开。
 *
 * 校验只覆盖**启动路径上会被读到的字段**（id / displayName / participantIds 等），
 * 不追求把每层结构都验一遍：验得越细，加字段时越容易漏改。
 */

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按谓词过滤一个"ID → 条目"的记录，丢掉不合格的条目。 */
export function sanitizeRecord<T>(
  value: unknown,
  isValid: (item: unknown) => boolean,
): { readonly kept: Record<string, T>; readonly dropped: string[] } {
  const source = isRecord(value) ? value : {};
  const kept: Record<string, T> = {};
  const dropped: string[] = [];
  for (const [key, item] of Object.entries(source)) {
    if (isValid(item)) kept[key] = item as T;
    else dropped.push(key);
  }
  return { kept, dropped };
}

/** 会话：必须有 id、显示名与参与者列表（启动时会遍历后者）。 */
function isValidSession(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return (
    typeof item.id === "string" &&
    typeof item.displayName === "string" &&
    Array.isArray(item.participantIds)
  );
}

/** 角色：必须有 id 与显示名（提示词里会直接引用）。 */
function isValidCharacter(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return typeof item.id === "string" && typeof item.displayName === "string";
}

/** 通讯录条目。 */
function isValidContact(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return (
    typeof item.characterId === "string" && typeof item.displayName === "string"
  );
}

/** 提示词模板。 */
function isValidTemplate(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return typeof item.id === "string" && typeof item.name === "string";
}

/** 会话运行时快照：messages 必须是数组，否则渲染时会炸。 */
function isValidRuntime(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return Array.isArray(item.messages);
}

/** 剧情状态卡：至少要有 sessionId 与 events 数组。 */
function isValidPlotState(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return typeof item.sessionId === "string" && Array.isArray(item.events);
}

/** 清洗结果里被丢掉的字段名（用于打日志）。 */
export interface ISanitizeReport {
  readonly dropped: ReadonlyArray<string>;
}

/**
 * 清洗 sessionStore 的持久化快照。
 *
 * @param snapshot 原始快照（结构未知）
 * @returns 清洗后的快照；传入非对象时返回 null（等价于"没有可用数据"）
 */
export function sanitizeSessionSnapshot<T>(
  snapshot: unknown,
): { readonly value: T | null; readonly report: ISanitizeReport } {
  if (!isRecord(snapshot)) {
    return { value: null, report: { dropped: [] } };
  }

  const dropped: string[] = [];
  const track = (prefix: string, keys: ReadonlyArray<string>): void => {
    for (const key of keys) dropped.push(`${prefix}.${key}`);
  };

  const sessions = sanitizeRecord(snapshot.sessions, isValidSession);
  track("sessions", sessions.dropped);
  const characters = sanitizeRecord(snapshot.characters, isValidCharacter);
  track("characters", characters.dropped);
  const contacts = sanitizeRecord(snapshot.contacts, isValidContact);
  track("contacts", contacts.dropped);
  const templates = sanitizeRecord(snapshot.promptTemplates, isValidTemplate);
  track("promptTemplates", templates.dropped);
  const runtimes = sanitizeRecord(snapshot.sessionRuntimes, isValidRuntime);
  track("sessionRuntimes", runtimes.dropped);
  const plotStates = sanitizeRecord(snapshot.plotStates, isValidPlotState);
  track("plotStates", plotStates.dropped);

  // 记忆是"角色 ID → 数组"，只保留数组值
  const memoriesRaw = isRecord(snapshot.memories) ? snapshot.memories : {};
  const memories: Record<string, unknown> = {};
  for (const [key, list] of Object.entries(memoriesRaw)) {
    if (Array.isArray(list)) memories[key] = list;
    else dropped.push(`memories.${key}`);
  }

  // 世界书与记忆同构（角色 ID → 数组），但条目要逐条过一遍结构校验：
  // 注入时要读 keys / content，形状不对的条目会让检索逻辑读到 undefined。
  const isValidLoreEntry = (item: unknown): boolean => {
    if (!isRecord(item)) return false;
    if (typeof item.id !== "string" || typeof item.content !== "string") return false;
    return Array.isArray(item.keys);
  };
  const loreRaw = isRecord(snapshot.loreEntries) ? snapshot.loreEntries : {};
  const loreEntries: Record<string, ReadonlyArray<unknown>> = {};
  for (const [key, list] of Object.entries(loreRaw)) {
    if (!Array.isArray(list)) {
      dropped.push(`loreEntries.${key}`);
      continue;
    }
    const kept = list.filter(isValidLoreEntry);
    if (kept.length !== list.length) {
      dropped.push(`loreEntries.${key}.${list.length - kept.length}`);
    }
    if (kept.length > 0) loreEntries[key] = kept;
  }

  // 草稿只留字符串，游标只留有限数字
  const draftsRaw = isRecord(snapshot.drafts) ? snapshot.drafts : {};
  const drafts: Record<string, string> = {};
  for (const [key, text] of Object.entries(draftsRaw)) {
    if (typeof text === "string") drafts[key] = text;
    else dropped.push(`drafts.${key}`);
  }

  const cursorsRaw = isRecord(snapshot.digestCursors)
    ? snapshot.digestCursors
    : {};
  const digestCursors: Record<string, number> = {};
  for (const [key, cursor] of Object.entries(cursorsRaw)) {
    if (typeof cursor === "number" && Number.isFinite(cursor)) {
      digestCursors[key] = cursor;
    } else {
      dropped.push(`digestCursors.${key}`);
    }
  }

  const activeSessionId = snapshot.activeSessionId;
  const safeActiveSessionId =
    typeof activeSessionId === "string" && sessions.kept[activeSessionId]
      ? activeSessionId
      : null;

  // 累计用量：只保留 "会话 → { requests, tokens }" 且两个值都是有限数字的条目
  const usageRaw = isRecord(snapshot.tokenUsageBySession)
    ? snapshot.tokenUsageBySession
    : {};
  const tokenUsageBySession: Record<
    string,
    { requests: number; tokens: number }
  > = {};
  for (const [key, value] of Object.entries(usageRaw)) {
    if (!isRecord(value)) {
      dropped.push(`tokenUsageBySession.${key}`);
      continue;
    }
    const requests = value.requests;
    const tokens = value.tokens;
    if (
      typeof requests === "number" &&
      Number.isFinite(requests) &&
      typeof tokens === "number" &&
      Number.isFinite(tokens)
    ) {
      tokenUsageBySession[key] = { requests, tokens };
    } else {
      dropped.push(`tokenUsageBySession.${key}`);
    }
  }

  const value = {
    ...snapshot,
    sessions: sessions.kept,
    characters: characters.kept,
    contacts: contacts.kept,
    promptTemplates: templates.kept,
    sessionRuntimes: runtimes.kept,
    plotStates: plotStates.kept,
    memories,
    loreEntries,
    drafts,
    digestCursors,
    tokenUsageBySession,
    activeSessionId: safeActiveSessionId,
  } as unknown as T;

  return { value, report: { dropped } };
}
