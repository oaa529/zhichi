/**
 * @file digestRunner.ts
 * 后台整理编排器：触发条件判断 + LLM 调用 + 结果落库。
 *
 * 数据流：
 *   会话消息数 − 整理游标 ≥ 阈值
 *     → toLLMHistory（取最近 maxWindow 条）
 *     → runDigest（复用当前 LLM 适配器，独立 AbortController）
 *     → mergeMemories → sessionStore.applyMemories
 *     → applyDigest   → sessionStore.setPlotState
 *     → setDigestCursor
 *
 * 失败（超时/解析失败/网络错误）静默跳过并设置冷却，
 * 游标不推进，下次有足够新消息时重试。
 */

import type { IMessageRuntime } from "@wechat-rp/ui-wechat";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import {
  applyDigest,
  mergeMemories,
  runDigest,
  toLLMHistory,
} from "@wechat-rp/core";
import type { DigestFailureReason } from "@wechat-rp/core";
import { getApiConfigFromStore, getLLMAdapter } from "./llmRuntime";

/** 整理失败后的冷却时间（避免每次发消息都重试）。 */
const FAILURE_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * 整理窗口前面多带几条**已经整理过**的消息当上下文。
 *
 * 只为了让模型明白"他/那个/上一句"指的是谁——它们不会产生新记忆，
 * 但少了它们，一段从中间截断的对话很容易被误读。
 */
const CONTEXT_OVERLAP_MESSAGES = 4;

/**
 * 值得立刻重试一次的失败原因。
 *
 * 真机实测：agnes 偶发返回**空内容**（3 次里就能撞到 1 次），
 * 格式跑偏（模型写了散文 / JSON 结构不对）也时有时无——
 * 这两类重试一次基本就好，而"整段记忆直接丢掉"的代价要大得多。
 *
 * 网络错误与超时不在这里重试：那会让等待翻倍，交给失败冷却之后自动重试。
 */
const RETRYABLE_FAILURES: ReadonlySet<DigestFailureReason> = new Set([
  "empty-output",
  "unparsable",
]);

/** 整理最多尝试几次（首次 + 一次重试）。 */
const MAX_DIGEST_ATTEMPTS = 2;

/** 重试前的短暂等待：给服务端一点缓冲，也不想让用户等。 */
const RETRY_DELAY_MS = 400;

/**
 * 整理请求的输出预算。
 *
 * 比聊天用的默认值宽：一次整理最多 12 条记忆 + 8 个事件 + 状态卡，
 * 真机实测输出能到 1200 字（≈900 token），贴着 1024 的旧上限，
 * 于是出现过"写到 plot 那里尾巴断掉"的截断。多给一点预算换来的是
 * 不用走抢救解析那套兜底。
 */
const DIGEST_MAX_TOKENS = 2048;

/** 可被中止的等待（取消整理时立刻返回）。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 正在整理的会话（防并发）。 */
const runningSessions = new Set<string>();
/** 每会话的整理中止控制器（页面卸载时统一取消）。 */
const runningControllers = new Map<string, AbortController>();
/** 每会话最近一次失败时间。 */
const lastFailureAt = new Map<string, number>();

/**
 * 计算某会话"待整理"的消息条数（消息总数 − 整理游标）。
 */
export function getPendingDigestCount(sessionId: string): number {
  const state = useSessionStore.getState();
  const runtime = state.sessionRuntimes[sessionId];
  if (!runtime) return 0;
  const cursor = state.digestCursors[sessionId] ?? 0;
  return Math.max(0, runtime.messages.length - cursor);
}

/**
 * 满足阈值时执行后台整理（自动路径）。
 * @returns 是否真正执行了整理
 */
export function maybeRunDigest(sessionId: string): Promise<boolean> {
  return executeDigest(sessionId, false);
}

/**
 * 立即执行一次整理（手动路径，"立即整理"按钮）。
 * 忽略阈值与自动整理开关，但仍在 Mock 模式下跳过。
 */
export function runDigestNow(sessionId: string): Promise<boolean> {
  return executeDigest(sessionId, true);
}

/** 取消所有进行中的整理（页面卸载时调用）。 */
export function cancelAllDigests(): void {
  for (const controller of runningControllers.values()) {
    controller.abort();
  }
  runningControllers.clear();
}

/**
 * 清空编排器的内存态（失败冷却 + 在途标记）。
 *
 * 用在"重建适配器"之后：用户很可能就是去设置里把 API Key / 模型改好了，
 * 之前失败的会话不该继续被冷却挡着，应该马上能重试。
 */
export function resetDigestRunnerState(): void {
  lastFailureAt.clear();
  runningSessions.clear();
  runningControllers.clear();
}

async function executeDigest(
  sessionId: string,
  force: boolean,
): Promise<boolean> {
  const state = useSessionStore.getState();
  const config = state.digestConfig;

  if (!force && !config.enabled) return false;
  if (runningSessions.has(sessionId)) return false;

  if (!force) {
    const lastFailure = lastFailureAt.get(sessionId);
    if (lastFailure && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) {
      return false;
    }
  }

  // Mock 适配器不产出可解析的 JSON，静默跳过
  const apiConfig = getApiConfigFromStore();
  if (apiConfig.adapter === "mock") return false;

  const runtime = state.sessionRuntimes[sessionId];
  const session = state.sessions[sessionId];
  if (!runtime || !session) return false;

  const characterId = session.participantIds.find((id) => id !== "user");
  const character = characterId ? state.characters[characterId] : undefined;
  if (!characterId || !character) return false;

  const messages = (runtime.messages as ReadonlyArray<IMessageRuntime>).map(
    (item) => item.message,
  );
  if (messages.length === 0) return false;

  const cursor = state.digestCursors[sessionId] ?? 0;
  const pending = messages.length - cursor;
  if (!force && pending < config.threshold) return false;

  /**
   * 窗口锚在"还没整理的那一段"的开头，而不是永远取最后 maxWindow 条。
   *
   * 之前是 `slice(-maxWindow)` + 游标直接跳到 `messages.length`：
   * 未整理的消息一旦超过窗口（导入备份、关掉自动整理很久再打开、
   * 手动点"立即整理"一大段），**中间那批就永远不会被整理**，
   * 而游标却声称它们整理过了——内容悄悄丢掉，界面上还看不出来。
   *
   * 现在：一次只吃 maxWindow 条未整理消息（积压就分几次），
   * 游标按实际吃掉的段推进。
   */
  const undigestedStart = Math.max(0, Math.min(cursor, messages.length));
  const windowStart = Math.max(0, undigestedStart - CONTEXT_OVERLAP_MESSAGES);
  const windowEnd = Math.min(
    messages.length,
    undigestedStart + config.maxWindow,
  );
  const windowMessages = messages.slice(windowStart, windowEnd);
  const history = toLLMHistory(windowMessages);
  if (history.length === 0) {
    // 窗口内没有可整理的文本（全为系统/撤回消息）：跳过这一段，
    // 同样只推进"这一段"——推进到 messages.length 会在积压时跳过中间内容
    state.setDigestCursor(sessionId, windowEnd);
    return false;
  }

  const controller = new AbortController();
  runningSessions.add(sessionId);
  runningControllers.set(sessionId, controller);

  // 已在库的记忆：作为"已知内容"随请求下发，避免模型每轮重复提炼同一条事实
  const knownMemories = state.memories[characterId] ?? [];
  const knownContents = knownMemories.map((memory) => memory.content);
  /**
   * 当前状态卡也要一起下发。
   *
   * 状态卡是"整卡维护"：不给模型看现有卡，它只能按这一段对话写出零碎字段——
   * 要么整组覆盖把还没了结的线索抹掉，要么干脆省略、让已经了结的线索
   * 永远挂在卡上（真机实测就是后者：展览都看完了还挂着）。
   */
  const currentPlot = state.plotStates[sessionId] ?? null;

  try {
    let digest = null as Awaited<ReturnType<typeof runDigest>>;
    let lastFailure: DigestFailureReason | null = null;

    for (let attempt = 1; attempt <= MAX_DIGEST_ATTEMPTS; attempt += 1) {
      lastFailure = null;
      digest = await runDigest({
        adapter: getLLMAdapter(),
        history,
        characterName: character.displayName,
        characterId,
        existingMemories: knownContents,
        currentPlot,
        model: apiConfig.model,
        maxTokens: DIGEST_MAX_TOKENS,
        timeoutMs: Math.max(5000, apiConfig.timeoutMs),
        signal: controller.signal,
        // 失败原因记到会话上，界面才能告诉用户"卡在哪一步"（此前是全静默）
        onFailure: (reason) => {
          lastFailure = reason;
          useSessionStore.getState().setDigestFailure(sessionId, reason);
        },
      });
      if (digest) break;
      // 只有"模型这次没给好输出"这类才立刻重试；网络/超时留着以后再说
      if (
        !lastFailure ||
        !RETRYABLE_FAILURES.has(lastFailure) ||
        controller.signal.aborted
      ) {
        break;
      }
      await delay(RETRY_DELAY_MS, controller.signal);
    }

    if (!digest) {
      lastFailureAt.set(sessionId, Date.now());
      return false;
    }

    const sourceMessageIds = windowMessages.map((message) => message.id);

    // 1. 合并长期记忆
    const latest = useSessionStore.getState();
    const existingMemories = latest.memories[characterId] ?? [];
    /** 这次整理的时间戳：合并与"本次改了什么"的统计都以它为准。 */
    const digestAt = Date.now();
    const existingIds = new Set(existingMemories.map((memory) => memory.id));
    const merged = mergeMemories({
      characterId,
      existing: existingMemories,
      drafts: digest.memories,
      sourceMessageIds,
      now: digestAt,
    });
    latest.applyMemories(characterId, merged);

    // 2. 应用剧情状态卡与事件
    const existingPlot = latest.plotStates[sessionId] ?? null;
    const nextPlot = applyDigest({
      sessionId,
      state: existingPlot,
      digest,
      sourceMessageIds,
      maxEvents: latest.digestConfig.maxEvents,
      maxHistory: latest.digestConfig.maxHistory,
    });
    latest.setPlotState(sessionId, nextPlot);

    /**
     * 3. 记一条"这次改了什么"的摘要。
     *
     * 整理是自动跑的，用户最容易犯嘀咕的就是"它刚才偷偷改了什么"。
     * 这里只统计**本次**的改动：新增看 id 是不是新的，
     * 取代看总数少了几条，冲突看这次新写过的条目里带没带 conflictsWith。
     */
    const added = merged.filter((memory) => !existingIds.has(memory.id)).length;
    const replaced = Math.max(
      0,
      existingMemories.length + added - merged.length,
    );
    const conflicts = merged.filter(
      (memory) =>
        memory.conflictsWith !== undefined && memory.updatedAt >= digestAt,
    ).length;
    const previousEvents = (existingPlot?.events ?? []).length;
    latest.setDigestReport(sessionId, {
      at: digestAt,
      messageCount: windowMessages.length,
      added,
      replaced,
      conflicts,
      events: Math.max(0, nextPlot.events.length - previousEvents),
    });

    // 4. 推进游标：只推进这次真正整理过的那一段（积压分批处理，一条都不跳过）
    latest.setDigestCursor(sessionId, windowEnd);
    // 这次成功了，清掉之前的失败记录
    latest.setDigestFailure(sessionId, null);
    lastFailureAt.delete(sessionId);
    return true;
  } catch {
    lastFailureAt.set(sessionId, Date.now());
    return false;
  } finally {
    runningSessions.delete(sessionId);
    runningControllers.delete(sessionId);
  }
}
