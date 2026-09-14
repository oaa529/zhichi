/**
 * @file MemoryRetriever.ts
 * 记忆检索：从用户当前输入（+ 最近对话）提取关键词，
 * 对候选记忆打分排序，按条数与字数预算截断。
 *
 * 零依赖设计：中文用字符 bigram 近似分词，英文/数字用单词匹配。
 * 纯函数，可直接单测。
 */

import type { IMemory } from "@wechat-rp/shared-types";

/** 单次检索的默认条数上限。 */
const DEFAULT_MAX_ITEMS = 10;
/** 单次检索的默认字数预算。 */
const DEFAULT_MAX_CHARS = 800;
/** 时间衰减半衰期：14 天。 */
const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** 关键词提取数量上限（防止长文本产生过多 bigram）。 */
const MAX_KEYWORDS = 64;

/**
 * 相关性门槛：IDF 加权命中量低于它的记忆**不进 Prompt**。
 *
 * 由来（真机量化）：此前没有任何门槛，于是一句"在吗"也会按
 * "重要度 + 新鲜度"塞满 10 条记忆——实测无关提问平均注入 9 条，
 * 每轮白烧 ~700 字，还可能把角色带偏（张口就提"你花生过敏"）。
 * 现在只有**命中足够区分度的关键词**才注入，置顶条目不受影响。
 */
export const DEFAULT_MIN_MATCHED_IDF = 1.0;

/** IDF 饱和点：命中一条只在极少记忆里出现的关键词，就视为"完全相关"。 */
const IDF_FULL_MATCH = 3.4;

/** 没有 IDF 信息时的兜底权重（单条关键词）。 */
const FALLBACK_IDF = 1;

/**
 * 单字弱匹配的折扣。
 *
 * 中文没有词形变化，"那个展"和关键词"摄影展"只共享一个"展"——
 * 这正是纯 bigram 匹配抓不到、而人一眼就懂的联系。给它一部分权重：
 * 稀有词（IDF 高）弱命中也能过门槛，泛词弱命中则过不了。
 */
const WEAK_MATCH_FACTOR = 0.35;

/**
 * 弱匹配时要忽略的"泛字"。
 *
 * 真机量化里踩到的坑：`上` `下` `周` `工` 这种字几乎出现在每句话里，
 * 靠它们沾边会让"晚上点外卖"召回"用户报了吉他班（上课）"、
 * 让"工作怎么样"召回"工位上的绿萝"。这些字本身不携带信息，直接不参与弱匹配。
 */
const WEAK_MATCH_STOPCHARS: ReadonlySet<string> = new Set([
  "上", "下", "周", "工", "吃", "睡", "要", "会", "能", "去", "来", "说", "好",
  "不", "很", "都", "就", "还", "个", "们", "这", "那", "你", "我", "他", "她",
  "了", "地", "得", "着", "过", "把", "被", "给", "和", "与", "在", "是", "有",
  "没", "一", "二", "三", "大", "小", "新", "旧", "前", "后", "里", "外", "中",
  "多", "少", "天", "年", "月", "日", "点", "分",
]);

/**
 * 构建关键词的区分度权重（近似 IDF）。
 *
 * 在越多记忆里出现的关键词越不值钱："工作""喜欢"这类泛词命中说明不了什么，
 * 而"团团""蝴蝶兰"这种只出现在一条记忆里的词，一旦命中就几乎锁定答案。
 */
function buildIdf(memories: ReadonlyArray<IMemory>): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const memory of memories) {
    const keywords = memoryKeywordsOf(memory);
    for (const keyword of new Set(keywords)) {
      docFreq.set(keyword, (docFreq.get(keyword) ?? 0) + 1);
    }
  }
  const total = memories.length;
  const idf = new Map<string, number>();
  for (const [keyword, count] of docFreq) {
    idf.set(keyword, Math.log(1 + total / count));
  }
  return idf;
}

/**
 * 取一条记忆的关键词（没写就从句子里抽）。
 *
 * 这里曾经改成"自带关键词 ∪ 正文关键词"，想兜住"关键词漏写具体名词"
 * 的情况（端到端探针里出现过：正文有"花生过敏"、关键词只有「体检/过敏」）。
 * **但实测太贪**：正文 2-gram 又碎又常见，无关闲聊也开始命中记忆
 * （精度用例从 15 条涨到 43 条，`MemoryRetrieverParaphrase` 的零注入用例
 * 直接红）。所以撤回，改在**提炼提示词**里要求关键词必须包含具体名词——
 * 治源头，而不是在检索端放水。
 */
function memoryKeywordsOf(memory: IMemory): ReadonlyArray<string> {
  return memory.keywords.length > 0
    ? memory.keywords
    : extractKeywords(memory.content);
}

/** 中文连续片段匹配（含常见全角标点分隔）。 */
const CJK_RUN_PATTERN = /[\u4e00-\u9fff]+/g;
/** 英文单词/数字匹配。 */
const WORD_PATTERN = /[a-zA-Z0-9]+/g;

/**
 * 提取文本关键词。
 *
 * - 英文/数字：整词（小写）
 * - 中文：长度 1 的片段保留单字；长度 ≥2 的片段生成相邻 2-gram（如"我喜欢猫" → 我喜/喜欢/欢猫）
 *
 * @param text 任意文本
 * @returns 去重后的关键词数组（最多 64 个）
 */
export function extractKeywords(text: string): ReadonlyArray<string> {
  const result = new Set<string>();

  const words = text.toLowerCase().match(WORD_PATTERN);
  if (words) {
    for (const word of words) {
      result.add(word);
    }
  }

  const runs = text.match(CJK_RUN_PATTERN);
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) {
        result.add(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i += 1) {
        result.add(run.slice(i, i + 2));
      }
    }
  }

  return [...result].slice(0, MAX_KEYWORDS);
}

/**
 * 计算两段中文/混合文本的字符 bigram 相似度（Jaccard 系数）。
 * 用于记忆去重合并（阈值 0.7）。
 */
export function bigramSimilarity(a: string, b: string): number {
  const setA = toBigramSet(a);
  const setB = toBigramSet(b);
  if (setA.size === 0 || setB.size === 0) {
    return a.trim() === b.trim() ? 1 : 0;
  }

  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 归一化文本并生成 bigram 集合（长度 1 时保留单字）。 */
function toBigramSet(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  const set = new Set<string>();
  if (normalized.length === 0) return set;
  if (normalized.length === 1) {
    set.add(normalized);
    return set;
  }
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

/** 检索选项。 */
export interface IRetrieveMemoriesOptions {
  /** 最多返回条数（默认 10）。 */
  readonly maxItems?: number;
  /** 总字数预算（默认 800）。 */
  readonly maxChars?: number;
  /** 注入判定用的当前时间（测试可注入）。 */
  readonly now?: number;
  /** 时间衰减半衰期（ms，默认 14 天）。 */
  readonly halfLifeMs?: number;
  /**
   * 相关性门槛（IDF 命中量，默认 1.0）。
   *
   * 设为 0 就退回"谁都能进"的老行为（保留给特殊场景与测试）。
   */
  readonly minMatchedIdf?: number;
}

/**
 * 计算单条记忆与查询的相关度得分。
 *
 * score = 0.6×命中率 + 0.25×(重要度/5) + 0.15×时间衰减 + 0.2×置顶加成
 *
 * @param query 查询原文（用户当前输入 + 最近消息）
 */
export function scoreMemory(
  memory: IMemory,
  query: string,
  now: number,
  halfLifeMs: number = DEFAULT_HALF_LIFE_MS,
  /**
   * 关键词的区分度权重（可选）。
   *
   * 传了就用 IDF 加权命中；不传保持老的"命中率"口径
   * （老调用方与既有单测不受影响）。
   */
  idf?: ReadonlyMap<string, number>,
  /** 话题扩展词（可选，见 TOPIC_GROUPS）。 */
  expansion: ReadonlyArray<string> = [],
): number {
  const memoryKeywords = memoryKeywordsOf(memory);
  const relevance = idf
    ? computeIdfRelevance(query, memoryKeywords, idf, expansion)
    : computeHitRatio(query, memoryKeywords, expansion);

  const ageMs = Math.max(0, now - memory.updatedAt);
  const decay = Math.pow(0.5, ageMs / halfLifeMs);

  const importanceScore = (memory.importance / 5) * 0.25;
  const pinnedBonus = memory.pinned ? 0.2 : 0;

  return 0.6 * relevance + importanceScore + 0.15 * decay + pinnedBonus;
}

/** IDF 加权命中量（越大说明命中的词越有区分度）。 */
function computeMatchedIdf(
  query: string,
  memoryKeywords: ReadonlyArray<string>,
  idf: ReadonlyMap<string, number>,
  expansion: ReadonlyArray<string> = [],
): number {
  const normalizedQuery = normalizeText(query);
  const queryGrams = toBigramSet(normalizedQuery);
  let matched = 0;

  for (const keyword of memoryKeywords) {
    const weight = idf.get(normalizeText(keyword)) ?? FALLBACK_IDF;
    if (matchesKeyword(normalizedQuery, queryGrams, keyword, expansion)) {
      matched += weight;
      continue;
    }
    // 弱匹配：只共享一个汉字（"那个展" ↔ "摄影展"）
    if (sharesCjkChar(normalizedQuery, keyword)) {
      matched += weight * WEAK_MATCH_FACTOR;
    }
  }
  return matched;
}

/** 关键词里有没有哪个汉字出现在查询里（中文的"沾边"信号）。 */
function sharesCjkChar(normalizedQuery: string, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (normalizedKeyword.length < 2) return false;
  for (const char of normalizedKeyword) {
    if (!/[\u4e00-\u9fff]/.test(char)) continue;
    if (WEAK_MATCH_STOPCHARS.has(char)) continue;
    if (normalizedQuery.includes(char)) return true;
  }
  return false;
}

/**
 * 用 IDF 命中量换算 0~1 的相关度。
 *
 * 饱和式：命中一条稀有词（如"团团"）就已经算完全相关，
 * 不必因为这条记忆还有几个没命中的关键词而被稀释——老口径
 * "命中数 ÷ 关键词总数"恰恰会让**关键词写得多的记忆吃亏**。
 */
function computeIdfRelevance(
  query: string,
  memoryKeywords: ReadonlyArray<string>,
  idf: ReadonlyMap<string, number>,
  expansion: ReadonlyArray<string> = [],
): number {
  if (memoryKeywords.length === 0) return 0;
  const matched = computeMatchedIdf(query, memoryKeywords, idf, expansion);
  return Math.min(1, matched / IDF_FULL_MATCH);
}

/**
 * 单个关键词是否命中（子串命中、bigram 覆盖度过半，或命中话题扩展词）。
 *
 * `expansion` 是"用户的大白话"对应的一整组说法（见 TOPIC_GROUPS）。
 * 这里**按词**比对而不是把扩展词拼进查询串：拼进去会被单字关键词捡便宜——
 * 扩展词"狸花"里含一个"花"，于是问宠物时把"妈妈喜欢养花"也捞了进来
 * （实测撞到过）。所以只允许长度 ≥ 2 的关键词走这条通道。
 */
function matchesKeyword(
  normalizedQuery: string,
  queryGrams: ReadonlySet<string>,
  keyword: string,
  expansion: ReadonlyArray<string> = [],
): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return false;
  // 单个"泛字"（吃/上/天…）不算命中：它几乎出现在每句话里
  if (
    normalizedKeyword.length === 1 &&
    WEAK_MATCH_STOPCHARS.has(normalizedKeyword)
  ) {
    return false;
  }
  if (normalizedQuery.includes(normalizedKeyword)) return true;

  const keywordGrams = toBigramSet(normalizedKeyword);
  if (keywordGrams.size === 0) return false;
  let covered = 0;
  for (const gram of keywordGrams) {
    if (queryGrams.has(gram)) covered += 1;
  }
  if (covered / keywordGrams.size >= 0.5) return true;

  // 话题扩展：查询里出现"狗"，就让记忆里的"柯基"也算命中。
  // 单字关键词（"猫""花"）只认"扩展词正好是它本身"——否则"狸花"里那个"花"
  // 会把"妈妈喜欢养花"也拉进来（实测撞到过）。
  if (normalizedKeyword.length < 2) {
    return expansion.includes(normalizedKeyword);
  }
  return expansion.some((term) => term.includes(normalizedKeyword));
}

/**
 * 命中率 = 命中的记忆关键词数 / 记忆关键词总数。
 *
 * 单个关键词的命中判定（兼顾单字与长词）：
 * 1. 查询原文包含该关键词（子串命中，覆盖"猫"这类单字）
 * 2. 否则计算该关键词的 bigram 在查询 bigram 中的覆盖度 ≥ 0.5
 */
function computeHitRatio(
  query: string,
  memoryKeywords: ReadonlyArray<string>,
  expansion: ReadonlyArray<string> = [],
): number {
  if (memoryKeywords.length === 0) return 0;

  const normalizedQuery = normalizeText(query);
  const queryGrams = toBigramSet(normalizedQuery);
  let hits = 0;

  for (const keyword of memoryKeywords) {
    if (matchesKeyword(normalizedQuery, queryGrams, keyword, expansion)) {
      hits += 1;
    }
  }

  return hits / memoryKeywords.length;
}

/** 文本归一化：去空白 + 小写。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 话题扩展表：把"用户的大白话"映射到"记忆里的说法"。
 *
 * 由来：记忆是整理**提炼后**的书面说法（"柯基""花生""互联网公司"），
 * 用户提问却常说大白话或上位词（"狗""坚果""上班的地方"）。只在查询侧
 * 按关键词匹配的结果是：8 条大白话问法里只有 3 条能检索到
 * （复现见 `work/_retrieval_paraphrase_check.mts`）——记忆明明存在，
 * 角色却答"记不太清"。
 *
 * 规则：查询里出现某一组的**任意**词，就把整组词并进查询。
 * 一个词可以同时属于多组（"宠物""小动物"同时在狗、猫两组里，
 * 于是"我那只宠物"能同时够到猫和狗的条目；而只问"猫"不会把狗的捞进来）。
 *
 * 刻意只覆盖聊天里最常被追问的几类，不做通用同义词库——那要靠词典或
 * 词向量，与本项目"零依赖"的定位冲突。
 */
const TOPIC_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "狗", "狗狗", "小狗", "狗子", "犬", "柯基", "柴犬", "金毛", "泰迪",
    "哈士奇", "萨摩耶", "边牧", "拉布拉多", "宠物", "小动物",
  ],
  [
    "猫", "猫猫", "猫咪", "喵", "橘猫", "狸花", "布偶", "英短",
    "宠物", "小动物",
  ],
  ["坚果", "花生", "腰果", "核桃", "杏仁", "开心果", "榛子"],
  [
    "上班", "工作", "公司", "单位", "老板", "领导", "同事",
    "跳槽", "换工作", "互联网",
  ],
];

/** 查询里出现的话题词 → 该组的全部说法（去重）。 */
export function expandQueryTopics(query: string): ReadonlyArray<string> {
  const normalized = normalizeText(query);
  if (normalized.length === 0) return [];

  const extras = new Set<string>();
  for (const group of TOPIC_GROUPS) {
    if (!group.some((word) => normalized.includes(word))) continue;
    for (const word of group) extras.add(word);
  }
  return [...extras];
}

/**
 * 检索与 query 最相关的记忆。
 *
 * 两段式挑选：
 * 1. **置顶记忆**先无条件占位（按重要度降序）——它们是用户明确要"永远记住"
 *    的条目，等同于社区里的"常驻条目/blue circle"：不参与相关度竞争，
 *    否则一句无关的寒暄就可能把"用户对花生过敏"挤出预算。
 * 2. 其余记忆按相关度得分排序填充剩余预算。
 *
 * 未置顶部分的排序：得分降序 → 重要度降序 → 更新时间降序；
 * 预算：条数 ≤ maxItems，累计 content 字数 ≤ maxChars（至少保留 1 条）。
 *
 * @param query 用户当前输入（可拼接最近对话）
 * @param memories 候选记忆（同一角色）
 * @param options 可选预算与时间参数
 */
export function retrieveMemories(
  query: string,
  memories: ReadonlyArray<IMemory>,
  options?: IRetrieveMemoriesOptions,
): ReadonlyArray<IMemory> {
  if (memories.length === 0) return [];

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const now = options?.now ?? Date.now();
  const halfLifeMs = options?.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const configuredGate = options?.minMatchedIdf ?? DEFAULT_MIN_MATCHED_IDF;
  /**
   * 门槛随语料规模自适应：记忆很少时（新会话、刚建角色）"稀有"无从谈起，
   * 每条都是独一份的事实，此时用满门槛会把仅有的几条也挡在外面。
   * 语料小 → 门槛低（几乎不拦），语料大 → 满门槛（只放有区分度的进来）。
   */
  const minMatchedIdf =
    configuredGate * Math.min(1, memories.length / 8);

  // 1) 置顶记忆：必定注入，按重要度与新鲜度排
  const pinned = memories
    .filter((memory) => memory.pinned)
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updatedAt - a.updatedAt;
    });

  // 2) 其余记忆：先过"相关性门槛"，再按相关度竞争剩余预算。
  //    话题扩展单独传下去（不拼进查询串），理由见 matchesKeyword 的注释。
  const expansion = expandQueryTopics(query);
  const idf = buildIdf(memories);
  const scored = memories
    .filter((memory) => !memory.pinned)
    .map((memory) => {
      const matchedIdf = computeMatchedIdf(
        query,
        memoryKeywordsOf(memory),
        idf,
        expansion,
      );
      return {
        memory,
        matchedIdf,
        score: scoreMemory(memory, query, now, halfLifeMs, idf, expansion),
      };
    })
    // 无关的寒暄不该把记忆段塞满：命中量不到门槛就不进 Prompt
    .filter((item) => item.matchedIdf >= minMatchedIdf)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.memory.importance !== a.memory.importance) {
        return b.memory.importance - a.memory.importance;
      }
      return b.memory.updatedAt - a.memory.updatedAt;
    });

  const picked: IMemory[] = [];
  let usedChars = 0;

  const tryPush = (memory: IMemory): void => {
    if (picked.length >= maxItems) return;
    const cost = memory.content.length;
    // 预算判断：第一条始终收下，避免 maxChars 过小时返回空数组
    if (picked.length > 0 && usedChars + cost > maxChars) return;
    picked.push(memory);
    usedChars += cost;
  };

  for (const memory of pinned) tryPush(memory);
  for (const item of scored) {
    if (picked.length >= maxItems) break;
    // 近似重复（同一件事的两种说法）只留排在前面的那条
    const duplicated = picked.some(
      (existing) =>
        !existing.pinned &&
        bigramSimilarity(existing.content, item.memory.content) >= 0.7,
    );
    if (duplicated) continue;
    tryPush(item.memory);
  }
  return picked;
}
