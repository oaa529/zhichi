/**
 * @file MemoryDigest.ts
 * 后台整理：把一段对话交给 LLM 提炼为「记忆 + 剧情事件 + 状态卡补丁」。
 *
 * 组成：
 * - buildDigestPrompt：构造"只输出 JSON"的整理指令
 * - parseDigest：容错解析（剥离 markdown 围栏、坏 JSON 返回 null）
 * - runDigest：复用 ILLMAdapter 执行一次非流式语义的整理调用
 * - mergeMemories：按字符 bigram 相似度去重合并
 *
 * 除 runDigest 外均为纯函数，可直接单测。
 */

import type {
  IBackgroundDigest,
  IMemory,
  IMemoryDraft,
    IPlotEventDraft,
    IPlotRelation,
    IPlotStatePatch,
    IPlotState,
  MemoryImportance,
  MemoryKind,
} from "@wechat-rp/shared-types";

import type { ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMMessage, ILLMRequest } from "../llm/types";
import { bigramSimilarity } from "./MemoryRetriever";

/** 允许的记忆类别白名单。 */
const MEMORY_KINDS: ReadonlyArray<MemoryKind> = [
  "fact",
  "preference",
  "event",
  "promise",
  "relation",
  "other",
];

/** 单条记忆内容长度上限。 */
const MAX_MEMORY_CONTENT_CHARS = 120;
/** 单条关键词长度上限。 */
const MAX_KEYWORD_CHARS = 16;
/** 单次整理最多产出的记忆条数。 */
const MAX_DIGEST_MEMORIES = 12;
/** 单次整理最多产出的剧情事件条数。 */
const MAX_DIGEST_EVENTS = 8;
/** 相似度阈值（≥ 视为同一条记忆）。 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/**
 * 判定"这条旧记忆就是被取代的那条"的相似度阈值。
 * 比普通去重更严：模型抄错几个字要仍能命中，但不能错删无关记忆
 * （漏删的代价是用户手动删一条，错删的代价是丢信息）。
 */
const SUPERSEDE_SIMILARITY_THRESHOLD = 0.8;

/**
 * 单次整理最多允许取代几条旧记忆。
 *
 * 正常一次整理（约 20 条消息）里真正"状态变了"的事通常只有一两条。
 * 设上限是为了兜住模型偶发的乱标：即使它把一堆无关记忆都标成 supersedes，
 * 也最多误删这么多，而不是一次清空整个记忆库。
 */
const MAX_SUPERSEDES_PER_RUN = 3;

/** 整理用的 system 指令。 */
const DIGEST_SYSTEM_PROMPT = [
  "你是一个对话整理助手，负责从角色扮演聊天记录中提炼长期记忆与剧情进展。",
  "只输出一个 JSON 对象，不要输出任何解释、前言或 markdown 代码块以外的文字。",
  "JSON 结构：",
  '{"memories":[{"kind":"fact|preference|event|promise|relation|other","content":"一句话","keywords":["关键词"],"importance":1,"supersedes":"被取代的旧记忆原文（没有冲突就不填）"}],',
  '"events":[{"summary":"一句话","importance":1}],',
  '"plot":{"chapter":"","scene":"","timeLabel":"","location":"","synopsis":"","openThreads":[""],"relations":[{"characterId":"","label":""}]}}',
  "规则：",
  "1. memories 记录这些（没有就给空数组）：对方的姓名、喜好、经历、工作与生活变动；**有明确时间的近期安排**（出差、考试、生日、聚会、面试）；**工作任务与截止日期**（下周要交报告、月底前完成提案、下周一面谈）；你们的约定与承诺；关系变化（吵架、道歉、和好、疏远）。",
  "2. 不记寒暄、天气、今天吃了什么这类随口内容。**情感上有分量的事优先于琐碎的生活细节**——吵架、道歉、约定，比\"对方有很多书要搬\"重要得多。",
  "   特别注意：**别把无关的两件事塞进一条**（\"用户分享工作压力并提及晚餐选择\"这种把正事和吃什么揉在一起的写法要拆开，或者干脆只留正事）。",
  "3. 一条记忆只写一件事：不要把相邻但无关的两句并成一条（\"他姐姐来住\"和\"房租要涨\"必须是两条）。",
  "4. importance 取值 1~5，5 表示最重要；keywords 给 2~6 个检索关键词。**关键词里必须包含这句话提到的具体名词**——宠物名（豆豆）、品类（柯基/猫/狗）、食物（花生/香菜）、地点（杭州）、病症（过敏）、公司类型（互联网公司）等；",
  "   对方之后很可能用**另一个说法**来问（问「我家那只狗」而记忆里写的是「柯基」），所以同一个东西的常见说法尽量都写上（柯基/狗，花生/坚果）。",
  "5. events 记录剧情上有推进意义的关键事件（见面、约定、冲突、关系变化、**一件正事做完**），只记录本轮新发生的；没有则给空数组。判断标准：**这条会不会影响之后怎么聊**——吃了什么、买了什么、天气如何都不算，\"约好了周六见面\"\"报告终于交掉了\"算。",
  "6. plot 只填写可以从对话中确认的字段；无法确认的字段请省略（不要给空字符串）。relations 中 characterId 使用给定角色 ID。",
  "7. plot 是**整张状态卡的最新版本**：参考【当前状态卡】把这一轮的信息并进去、整体返回——已经了结的未解线索要删掉（例如展览已经看完了），仍未了结的必须原样保留，不要只写这一轮提到的那条。状态卡没有任何变化时可以省略 plot。",
  "   注意 openThreads 要装**所有还没了结的事**：约好还没见的面、还没送出的东西、用户手上没做完的任务与截止日期（\"下周要交报告\"就算），了结之后必须从数组里去掉；**一条都没有时给空数组 `[]`，不要省略这个字段**——省略会被当成\"没提供\"而把旧线索留着。",
  "8. content / summary 均使用第三人称的一句话中文。",
  "9. 新信息如果**推翻或取代**了【已知的长期记忆】里的某一条（喜好改变、习惯戒断、约定完成、状态更新、关系变化），把那条旧记忆的原文一字不差地填进 supersedes；没有冲突就不要填这个字段。只更新真正矛盾的那一条，不要顺手把无关的旧记忆也标成 supersedes。",
].join("\n");

/**
 * 构造整理请求的 system / user 文本。
 *
 * @param history 待整理的对话消息（user/assistant 交替）
 * @param characterName 角色显示名
 * @param characterId 角色 ID（用于 relations.characterId）
 * @param userName 用户称呼（默认"用户"）
 */
export function buildDigestPrompt(
  history: ReadonlyArray<ILLMMessage>,
  characterName: string,
  characterId: string,
  userName = "用户",
  existingMemories: ReadonlyArray<string> = [],
  currentPlot?: IPlotState | null,
): { readonly system: string; readonly user: string } {
  const lines = history.map((message) => {
    const speaker = message.role === "user" ? userName : characterName;
    return `${speaker}：${message.content}`;
  });

  const user = [
    `角色 ID：${characterId}`,
    `角色名：${characterName}`,
    `用户称呼：${userName}`,
    ...(existingMemories.length > 0
      ? [
          "",
          "【已知的长期记忆】不要重复输出以下内容；只有当你发现需要修正或补充时，才输出该条目的更新版本：",
          ...existingMemories.slice(0, 40).map((content) => `- ${content}`),
        ]
      : []),
    ...(renderCurrentCard(currentPlot)
      ? ["", "【当前状态卡】（把它更新成最新版本后整体返回）：", renderCurrentCard(currentPlot)!]
      : []),
    "",
    "以下是待整理的对话记录（按时间正序）：",
    ...lines,
    "",
    "请输出整理结果 JSON。",
  ].join("\n");

  return { system: DIGEST_SYSTEM_PROMPT, user };
}

/**
 * 把当前状态卡渲染成几行文本（没有内容时返回空串）。
 *
 * 只列有值的字段：空字段写出来只会让模型以为"要清空它"。
 */
function renderCurrentCard(state?: IPlotState | null): string {
  if (!state) return "";
  const lines: string[] = [];
  if (state.chapter) lines.push(`- 章节：${state.chapter}`);
  if (state.scene) lines.push(`- 场景：${state.scene}`);
  if (state.timeLabel) lines.push(`- 时间：${state.timeLabel}`);
  if (state.location) lines.push(`- 地点：${state.location}`);
  if (state.synopsis) lines.push(`- 概要：${state.synopsis}`);
  if (state.openThreads.length > 0) {
    lines.push(`- 未解线索：${state.openThreads.map((t) => `「${t}」`).join("、")}`);
  }
  if (state.relations.length > 0) {
    lines.push(
      `- 关系：${state.relations.map((r) => `${r.characterId}＝${r.label}`).join("；")}`,
    );
  }
  return lines.join("\n");
}

/**
 * 去掉 JSON 里的**尾随逗号**（`{"a":1,}` / `[1,2,]`）。
 *
 * 这是模型最常见的一种"几乎合法"的写法，真机实测确实撞到过
 * （`"openThreads":["…","搬家当天能否顺利"],}`）——一旦 JSON.parse 失败，
 * 整段记忆就全丢了，代价太大，不值得为这种小毛病判死刑。
 *
 * 只在**字符串之外**动手：正文里本来就可能有逗号（"他说，好，"），
 * 那些一个都不能碰。
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      // 往后看：中间只有空白、紧跟着 } 或 ] 的逗号是多余的
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      const next = text[j];
      if (next === "}" || next === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * 抢救"写到一半"的 JSON（漏了闭合花括号，或被输出预算截断）。
 *
 * 真机实测确实撞到过：模型把 memories / events 都写完了，
 * 到 plot 那里尾巴断掉就直接收了代码围栏——整段 JSON 非法，
 * 于是**最有价值的记忆全被判死刑**。
 *
 * 做法保守：只保留**最后一个结构完整的顶层字段**，把半截尾部整段丢掉，
 * 再补上根对象的闭合。宁可少一个 plot 字段，也不丢 memories/events。
 * 结构已经错乱（括号对不上）时返回 null，交给调用方重试。
 */
function repairTruncatedJson(text: string): string | null {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  /** 根对象里最后一个"完整字段结束"的位置（depth===1 处遇到逗号之后） */
  let lastTopLevelEnd = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack[stack.length - 1] !== char) return null; // 结构乱了，不猜
      stack.pop();
    } else if (char === "," && stack.length === 1 && stack[0] === "}") {
      lastTopLevelEnd = i + 1;
    }
  }

  if (lastTopLevelEnd <= 0) return null;
  return `${text.slice(0, lastTopLevelEnd).replace(/,\s*$/, "")}}`;
}

/**
 * 容错解析整理输出。
 *
 * 处理：markdown 代码块围栏、JSON 前后夹杂说明文字、尾随逗号、
 * 以及被截断/漏闭合的尾巴（尽量保住已写完的内容）；
 * 校验失败返回 null（调用方静默放弃本次整理）。
 *
 * @param raw LLM 原始输出
 * @param fallbackCharacterId relations 缺少 characterId 时的回填值
 */
export function parseDigest(
  raw: string,
  fallbackCharacterId = "",
): IBackgroundDigest | null {
  /**
   * 候选文本都要试一遍，**取内容最全的那个**而不是第一个能用的。
   *
   * 因为"首个 { 到最后一个 }"在截断场景下会解析出一个残缺但合法的结果
   * （只剩 memories），先入为主就会把 events 丢掉；反过来，
   * "首个 { 到结尾"在"JSON 前后夹着说明文字"的场景下又会丢字段。
   * 与其猜哪种情况，不如都解析出来比一比谁保留的内容多。
   */
  let best: IBackgroundDigest | null = null;
  let bestScore = -1;
  for (const candidate of extractJsonCandidates(raw)) {
    const parsed = tryParseJson(candidate);
    if (!parsed) continue;

    const memories = parseMemories(parsed.memories);
    const events = parseEvents(parsed.events);
    const plot = parsePlotPatch(parsed.plot, fallbackCharacterId);
    if (memories.length === 0 && events.length === 0 && isEmptyPlotPatch(plot)) {
      continue;
    }
    const score =
      memories.length + events.length + (isEmptyPlotPatch(plot) ? 0 : 0.5);
    if (score > bestScore) {
      best = { memories, events, plot };
      bestScore = score;
    }
  }
  return best;
}

/** 尝试把一段文本解析成对象（严格 → 去尾随逗号 → 抢救截断的尾巴）。 */
function tryParseJson(text: string): Record<string, unknown> | null {
  const attempts = [text, stripTrailingCommas(text)];
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 继续下一种修法
    }
  }
  const repaired = repairTruncatedJson(stripTrailingCommas(text));
  if (repaired) {
    try {
      const parsed: unknown = JSON.parse(repaired);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 修不动就放弃这个候选
    }
  }
  return null;
}

/**
 * 从原始输出中提取**候选 JSON 文本**（去围栏 / 定位首个花括号）。
 *
 * 两个候选，顺序有讲究：
 * 1. "首个 { 到最后一个 }"——标准的"JSON 前后夹着说明文字"场景；
 * 2. "首个 { 到结尾"——**被截断**的场景（模型没写完就收了尾）。
 *    这一条是必须的：截断时最后一个 } 往往是内层对象的，
 *    按它裁会把 events / plot 整段切掉（真机踩过：只剩下 memories）。
 */
function extractJsonCandidates(raw: string): ReadonlyArray<string> {
  let text = raw.trim();
  if (!text) return [];

  // 剥离 ```json ... ``` 围栏；允许围栏没闭合（截断时常见）
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  const start = text.indexOf("{");
  if (start === -1) return [];
  const fromStart = text.slice(start);

  const candidates: string[] = [];
  const lastBrace = fromStart.lastIndexOf("}");
  if (lastBrace > 0) candidates.push(fromStart.slice(0, lastBrace + 1));
  candidates.push(fromStart);
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxChars);
}

function clampImportance(value: unknown): MemoryImportance {
  const n = typeof value === "number" ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return 3;
  const clamped = Math.min(5, Math.max(1, n));
  return clamped as MemoryImportance;
}

function parseMemories(value: unknown): ReadonlyArray<IMemoryDraft> {
  if (!Array.isArray(value)) return [];
  const result: IMemoryDraft[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const content = asTrimmedString(item.content, MAX_MEMORY_CONTENT_CHARS);
    if (!content) continue;

    const kind = MEMORY_KINDS.includes(item.kind as MemoryKind)
      ? (item.kind as MemoryKind)
      : "other";

    const keywords: string[] = [];
    if (Array.isArray(item.keywords)) {
      for (const keyword of item.keywords) {
        const text = asTrimmedString(keyword, MAX_KEYWORD_CHARS);
        if (text && !keywords.includes(text)) keywords.push(text);
        if (keywords.length >= 6) break;
      }
    }

    // 被取代的旧记忆原文（改状态类信息才会填）
    const supersedes = asTrimmedString(item.supersedes, MAX_MEMORY_CONTENT_CHARS);

    result.push({
      kind,
      content,
      keywords,
      importance: clampImportance(item.importance),
      ...(supersedes ? { supersedes } : {}),
    });
    if (result.length >= MAX_DIGEST_MEMORIES) break;
  }
  return result;
}

function parseEvents(value: unknown): ReadonlyArray<IPlotEventDraft> {
  if (!Array.isArray(value)) return [];
  const result: IPlotEventDraft[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const summary = asTrimmedString(item.summary, MAX_MEMORY_CONTENT_CHARS);
    if (!summary) continue;
    result.push({ summary, importance: clampImportance(item.importance) });
    if (result.length >= MAX_DIGEST_EVENTS) break;
  }
  return result;
}

function parsePlotPatch(
  value: unknown,
  fallbackCharacterId: string,
): IPlotStatePatch {
  if (!isRecord(value)) return {};
  const patch: {
    chapter?: string;
    scene?: string;
    timeLabel?: string;
    location?: string;
    synopsis?: string;
    openThreads?: ReadonlyArray<string>;
    relations?: ReadonlyArray<IPlotRelation>;
  } = {};

  const fields: ReadonlyArray<
    "chapter" | "scene" | "timeLabel" | "location" | "synopsis"
  > = ["chapter", "scene", "timeLabel", "location", "synopsis"];
  for (const field of fields) {
    const text = asTrimmedString(value[field], 500);
    if (text) patch[field] = text;
  }

  if (Array.isArray(value.openThreads)) {
    const threads: string[] = [];
    for (const thread of value.openThreads) {
      const text = asTrimmedString(thread, 80);
      if (text && !threads.includes(text)) threads.push(text);
      if (threads.length >= 8) break;
    }
    /**
     * **空数组也算数**：它是"没有未解线索了"的明确回答，必须能清掉旧线索。
     *
     * 此前这里写着 `if (threads.length > 0)`，于是模型回 `"openThreads": []`
     * 时字段被丢掉 → 合并时按"没提供"处理 → **保留旧线索**。
     * 真机探针（`work/agnes_plot_accumulation_probe.mts`）里正好撞到：
     * 展都看完了，模型也说了"线索=(无)"，卡上却还挂着"摄影展行程"。
     * 万一模型偷懒乱给空数组，用户还能用状态卡的"← 回滚"退回上一版。
     */
    patch.openThreads = threads;
  }

  if (Array.isArray(value.relations)) {
    const relations: IPlotRelation[] = [];
    for (const relation of value.relations) {
      if (!isRecord(relation)) continue;
      const label = asTrimmedString(relation.label, 60);
      if (!label) continue;
      const characterId =
        asTrimmedString(relation.characterId, 80) ?? fallbackCharacterId;
      relations.push({ characterId, label });
      if (relations.length >= 8) break;
    }
    // 同上：空数组是"没有特别的关系标注"，要能覆盖旧值
    patch.relations = relations;
  }

  return patch;
}

function isEmptyPlotPatch(patch: IPlotStatePatch): boolean {
  return (
    patch.chapter === undefined &&
    patch.scene === undefined &&
    patch.timeLabel === undefined &&
    patch.location === undefined &&
    patch.synopsis === undefined &&
    patch.openThreads === undefined &&
    patch.relations === undefined
  );
}

/**
 * 整理失败的原因。
 *
 * 之前 runDigest 失败只会返回 null，调用方一律静默跳过——
 * 用户看到的是"待整理 N 条"越积越多，却不知道卡在哪一步。
 */
export type DigestFailureReason =
  /** 待整理窗口里没有可用的文本消息。 */
  | "no-history"
  /** 模型返回了空内容。 */
  | "empty-output"
  /** 模型输出不是能解析的整理结果（JSON 坏了或字段全空）。 */
  | "unparsable"
  /** 适配器报错（网络 / 鉴权 / 服务端）。 */
  | "adapter-error"
  /** 超时。 */
  | "timeout"
  /** 调用方主动中止（会话卸载等，不算故障）。 */
  | "aborted";

/** 运行整理的选项。 */
export interface IRunDigestOptions {
  /** LLM 适配器（复用当前 API 配置）。 */
  readonly adapter: ILLMAdapter;
  /** 待整理的对话消息。 */
  readonly history: ReadonlyArray<ILLMMessage>;
  /** 角色显示名。 */
  readonly characterName: string;
  /** 角色 ID（用于 relations 回填）。 */
  readonly characterId: string;
  /** 用户称呼（默认"用户"）。 */
  readonly userName?: string;
  /** 已存在的记忆内容（提示模型避免重复提炼）。 */
  readonly existingMemories?: ReadonlyArray<string>;
  /**
   * 当前状态卡（有的话随请求下发）。
   *
   * 状态卡是"整卡维护"：不给模型看现有卡，它只能按这一段对话写出零碎字段——
   * 要么整组覆盖把还没了结的线索抹掉，要么干脆省略字段、让已经了结的线索
   * 永远挂在卡上（真机实测就是这样：展都看完了还挂着）。
   */
  readonly currentPlot?: IPlotState | null;
  /** 模型名。 */
  readonly model: string;
  /** 温度（默认 0.2，整理任务需要稳定输出）。 */
  readonly temperature?: number;
  /** 最大输出 token（默认 1024）。 */
  readonly maxTokens?: number;
  /** 超时 ms（默认 30000）。 */
  readonly timeoutMs?: number;
  /** 外部中止信号（会话卸载 / 手动取消）。 */
  readonly signal?: AbortSignal;
  /**
   * 失败回调（可选）。
   * 主动中止属于正常流程，不会回调。
   */
  readonly onFailure?: (reason: DigestFailureReason) => void;
}

/**
 * 执行一次整理调用。
 *
 * 复用 ILLMAdapter 的流式接口，丢弃增量、只取完整文本；
 * 超时、中止、解析失败均返回 null（调用方静默跳过，保留游标待下次重试）。
 */
export function runDigest(
  options: IRunDigestOptions,
): Promise<IBackgroundDigest | null> {
  const {
    adapter,
    history,
    characterName,
    characterId,
    userName = "用户",
    existingMemories = [],
    currentPlot,
    model,
    temperature = 0.2,
    maxTokens = 1024,
    timeoutMs = 30000,
    signal,
    onFailure,
  } = options;

  if (history.length === 0) {
    onFailure?.("no-history");
    return Promise.resolve(null);
  }

  const prompt = buildDigestPrompt(
    history,
    characterName,
    characterId,
    userName,
    existingMemories,
    currentPlot,
  );
  const req: ILLMRequest = {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    model,
    maxTokens,
    temperature,
  };

  return new Promise<IBackgroundDigest | null>((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let abortHandle: { abort(reason?: string): void } | null = null;

    const finish = (
      result: IBackgroundDigest | null,
      reason?: DigestFailureReason,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleExternalAbort);
      if (result === null && reason) onFailure?.(reason);
      resolve(result);
    };

    const handleExternalAbort = (): void => {
      abortHandle?.abort("digest-aborted");
      // 主动中止不算故障，不回调 onFailure
      finish(null);
    };

    const timer = setTimeout(() => {
      abortHandle?.abort("digest-timeout");
      finish(null, "timeout");
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        finish(null);
        return;
      }
      signal.addEventListener("abort", handleExternalAbort, { once: true });
    }

    try {
      abortHandle = adapter.stream(
        req,
        {
          onDelta: () => {
            // 整理不需要流式反馈，仅等待完整文本
          },
          onComplete: (fullText) => {
            if (!fullText.trim()) {
              finish(null, "empty-output");
              return;
            }
            const parsed = parseDigest(fullText, characterId);
            finish(parsed, parsed ? undefined : "unparsable");
          },
          onError: () => {
            finish(null, "adapter-error");
          },
          onAbort: () => {
            // 超时/外部中止各自已经带了原因，这里不重复报
            finish(null);
          },
        },
        controller.signal,
      );
    } catch {
      finish(null, "adapter-error");
    }
  });
}

/** 记忆合并选项。 */
export interface IMergeMemoriesOptions {
  readonly characterId: string;
  /** 已有记忆。 */
  readonly existing: ReadonlyArray<IMemory>;
  /** 新整理出的记忆草稿。 */
  readonly drafts: ReadonlyArray<IMemoryDraft>;
  /** 本批记忆的来源消息 ID。 */
  readonly sourceMessageIds?: ReadonlyArray<string>;
  /** 当前时间（测试可注入）。 */
  readonly now?: number;
  /** 记忆 ID 生成器（测试可注入）。 */
  readonly idFactory?: () => string;
  /** 去重相似度阈值（默认 0.7）。 */
  readonly similarityThreshold?: number;
}

/**
 * 把整理草稿合并进已有记忆。
 *
 * 相似度 ≥ 阈值的草稿与已有记忆合并：内容取更长者、重要度取更高、
 * 关键词与来源消息取并集、更新时间刷新；否则新增一条。
 *
 * @returns 合并后的完整记忆数组（不修改入参）
 */
export function mergeMemories(
  options: IMergeMemoriesOptions,
): ReadonlyArray<IMemory> {
  const {
    characterId,
    existing,
    drafts,
    sourceMessageIds = [],
    now = Date.now(),
    idFactory = (): string =>
      `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
  } = options;

  const result: IMemory[] = existing.map((memory) => ({ ...memory }));
  /** 本次已应用多少次"取代"（用来兜住模型的乱标）。 */
  let supersedeCount = 0;

  for (const draft of drafts) {
    /** 这一次被取代掉的旧记忆原文（写进新记忆，供界面回显）。 */
    let replacedContent: string | undefined;
    /** 与受保护记忆（手动/置顶）冲突时，那条记忆的原文。 */
    let conflictContent: string | undefined;

    // 0) 先处理"取代"：模型明确指出这条新信息推翻了哪条旧记忆，
    //    直接把它摘掉，否则下面还会因为"不够相似"而把新信息当成新增，
    //    记忆库里就会同时留着互相矛盾的两条。
    if (draft.supersedes && supersedeCount < MAX_SUPERSEDES_PER_RUN) {
      /**
       * 指向的是受保护的记忆（手动/置顶）：**不删**用户的版本，但也不丢新信息——
       * 并存，并在这条新记忆上记下"和谁冲突"，面板会把两条一起摆给用户看。
       * （旧行为是默默并存、不说明冲突，用户只能自己发现矛盾。）
       */
      conflictContent = findProtectedMatch(result, draft.supersedes) ?? undefined;
      const replacedIndex = findSupersededIndex(result, draft.supersedes);
      if (replacedIndex >= 0) {
        replacedContent = result[replacedIndex]?.content;
        result.splice(replacedIndex, 1);
        supersedeCount += 1;
      }
    }

    let bestIndex = -1;
    let bestScore = 0;
    /**
     * 这条草稿是不是撞上了"受保护的记忆"。
     *
     * 受保护 = 用户手动维护（origin: manual）或置顶。它们的原文以用户为准：
     * 自动整理既不能改写、也不能删（supersedes 也不许），
     * 撞上了就直接丢掉这条草稿——否则会出现"用户刚改完又被改回去"，
     * 或者同一条事实在库里躺着两份互相矛盾的说法。
     */
    let clashesWithProtected = false;
    for (let i = 0; i < result.length; i += 1) {
      const candidate = result[i];
      if (!candidate) continue;
      // 相似度之外再做"包含式"判定：模型常把多个已有事实合并成一句更完整的话
      //（如"用户名叫小明，喜欢冰美式"），仅靠 bigram 相似度识别不出，
      // 会导致记忆里不断累积语义重复的条目。
      const containment =
        candidate.content.includes(draft.content) ||
        draft.content.includes(candidate.content)
          ? 1
          : 0;
      const score = Math.max(
        bigramSimilarity(candidate.content, draft.content),
        containment,
      );
      if (isProtected(candidate)) {
        if (score >= similarityThreshold) clashesWithProtected = true;
        continue;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (clashesWithProtected) continue;

    if (bestIndex >= 0 && bestScore >= similarityThreshold) {
      const target = result[bestIndex];
      if (!target) continue;
      result[bestIndex] = {
        ...target,
        content:
          draft.content.length > target.content.length
            ? draft.content
            : target.content,
        keywords: unionStrings(target.keywords, draft.keywords),
        importance:
          draft.importance > target.importance
            ? draft.importance
            : target.importance,
        updatedAt: now,
        sourceMessageIds: unionStrings(target.sourceMessageIds, sourceMessageIds),
        // 记下"替掉了什么"：用户要靠它判断自动整理有没有改错
        ...(replacedContent
          ? { supersedesContent: replacedContent, supersededAt: now }
          : {}),
        // 与用户手动维护/置顶的记忆冲突：两条并存，但要标明冲突关系
        ...(conflictContent ? { conflictsWith: conflictContent } : {}),
      };
    } else {
      result.push({
        id: idFactory(),
        characterId,
        kind: draft.kind,
        content: draft.content,
        keywords: [...draft.keywords],
        importance: draft.importance,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        sourceMessageIds: [...sourceMessageIds],
        ...(replacedContent
          ? { supersedesContent: replacedContent, supersededAt: now }
          : {}),
        ...(conflictContent ? { conflictsWith: conflictContent } : {}),
      });
    }
  }

  return result;
}

/**
 * 这条记忆是否"受保护"——用户手动维护或置顶的记忆。
 *
 * 后台整理不会改写、也不会删除它们：需要交给自动整理接管时，
 * 用户自己删掉即可（"我刚改完它又给我改回去"最伤信任）。
 */
function isProtected(memory: IMemory): boolean {
  return memory.pinned || memory.origin === "manual";
}

/**
 * quoted 指向的那条受保护记忆（没有则返回 null）。
 *
 * 用在 supersedes 上：模型说"这条新信息推翻了 X"，而 X 是用户手动写的——
 * 那就保留用户的版本、把新信息并存，并记下冲突关系让用户自己定。
 */
function findProtectedMatch(
  memories: ReadonlyArray<IMemory>,
  quoted: string,
): string | null {
  const normalizedQuoted = normalizeForMatch(quoted);
  if (!normalizedQuoted) return null;
  for (const memory of memories) {
    if (!isProtected(memory)) continue;
    if (normalizeForMatch(memory.content) === normalizedQuoted) {
      return memory.content;
    }
    if (
      bigramSimilarity(memory.content, quoted) >= SUPERSEDE_SIMILARITY_THRESHOLD
    ) {
      return memory.content;
    }
  }
  return null;
}

/** 字符串数组并集（保序去重）。 */
function unionStrings(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const result = [...a];
  for (const item of b) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

/** 比较用归一化：去空白 + 小写（用于识别"同一句话"）。 */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 找出 supersedes 指向的旧记忆下标。
 *
 * 先按归一化后的完全相等匹配（模型照抄的情况），再退化为 bigram 相似度，
 * 阈值取得比去重更高，避免模型抄错时误删无关记忆。
 *
 * **置顶记忆不参与自动取代**：置顶是用户显式表达的"永远记住这条"，
 * 让模型一句话就把它删掉，代价（静默丢失 + 难以察觉）高于残留一条过时信息。
 * 这类情况留给用户在记忆面板里手动处理。
 */
function findSupersededIndex(
  memories: ReadonlyArray<IMemory>,
  quoted: string,
): number {
  const normalizedQuoted = normalizeForMatch(quoted);
  if (!normalizedQuoted) return -1;

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < memories.length; i += 1) {
    const candidate = memories[i];
    // 受保护的记忆（手动维护 / 置顶）不参与"被取代"：用户的原文以用户为准
    if (!candidate || isProtected(candidate)) continue;
    const content = candidate.content;
    if (normalizeForMatch(content) === normalizedQuoted) return i;
    const score = bigramSimilarity(content, quoted);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestScore >= SUPERSEDE_SIMILARITY_THRESHOLD ? bestIndex : -1;
}
