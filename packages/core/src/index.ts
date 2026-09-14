/**
 * @file index.ts
 * @wechat-rp/core 出口。
 *
 * 引擎层零 UI 依赖，所有导出均为纯 TS 类与类型，
 * 可被 React UI 层、Node 测试、未来 Electron 主进程复用。
 */

export { RealismEngine } from "./RealismEngine";
export { EngineManager } from "./EngineManager";
export type { IEngineManagerOptions } from "./EngineManager";
export type { IRealismEngineOptions } from "./RealismEngine";

export { SemanticBuffer } from "./SemanticBuffer";
export type { ISemanticBufferOptions, ChunkEmitCallback } from "./SemanticBuffer";

export { TypingSimulator } from "./TypingSimulator";
export type { TypoDictionary, IRandomSource } from "./TypingSimulator";

export { Chunker } from "./Chunker";
export type { IChunkerOptions, ChunkIdGenerator } from "./Chunker";

export { PresenceManager } from "./PresenceManager";
export type { IPresenceDecision } from "./PresenceManager";

// ---------- 时区感知的"现在"（Prompt 注入 + 作息判定） ----------

export {
  formatDuration,
  describeElapsed,
  minutesOfDayInZone,
  nextTimeOfDayInZone,
  renderTimeContext,
  wallClockInZone,
} from "./time/Clock";
export type { ITimeContextOptions, IWallClock } from "./time/Clock";

export type {
  MessageChunk,
  ITypingPlan,
  IEngineRunContext,
} from "./types";

// ---------- LLM 适配器层 ----------

export type { ILLMAdapter, ILLMAdapterFactoryOptions, LLMAdapterKind, IConnectionTestResult } from "./llm/LLMAdapter";
export { OpenAIAdapter, createOpenAIAdapter } from "./llm/OpenAIAdapter";
export { ClaudeAdapter, createClaudeAdapter } from "./llm/ClaudeAdapter";
export { MockAdapter, createMockAdapter } from "./llm/MockAdapter";
export type { IMockAdapterOptions } from "./llm/MockAdapter";
export { trimContext, estimateTokens, estimateMessagesTokens } from "./llm/ContextTrimmer";
export type { ITrimResult } from "./llm/ContextTrimmer";
export {
  buildCharacterQuotePrompt,
  buildEmotionTagPrompt,
  buildHumanTonePrompt,
  buildPrompt,
  buildReadingQuotePrompt,
  buildReplyStylePrompt,
  buildSystemPromptPreview,
  buildUserProfilePrompt,
} from "./llm/PromptBuilder";
export {
  buildQuoteCandidates,
  CharacterQuoteFilter,
  CHARACTER_QUOTE_MAX_CHARS,
  CHARACTER_QUOTE_PREFIX,
  CHARACTER_QUOTE_SENDER_NAME,
  CHARACTER_QUOTE_SUFFIX,
  findQuoteTarget,
  QUOTE_MATCH_MIN_SCORE,
} from "./llm/characterQuote";
export type { IQuoteCandidate } from "./llm/characterQuote";
export {
  EMOTION_WINDOW_CHARS,
  inferEmotion,
  parseEmotionTagHead,
} from "./EmotionInference";
export type {
  IPromptResult,
  IPromptBuilderOptions,
  IPromptExtras,
} from "./llm/PromptBuilder";
export { toLLMHistory, getMessagePlainText } from "./llm/toLLMHistory";
export {
  ANTI_REPEAT_ITEM_CHARS,
  ANTI_REPEAT_MAX_ITEMS,
  ANTI_REPEAT_MAX_TURNS,
  ANTI_REPEAT_MIN_CHARS,
  ANTI_REPEAT_SIMILARITY,
  collectRecentSaid,
  findRepeatedSentences,
  renderAntiRepeatPrompt,
  splitSentences,
} from "./llm/AntiRepeat";
export type { ICollectRecentSaidOptions } from "./llm/AntiRepeat";
export {
  FORGET_MIN_FRAGMENT_CHARS,
  FORGET_MIN_TEXT_CHARS,
  FORGET_SHORT_SIMILARITY,
  FORGET_SIMILARITY,
  forgetEventsFromTexts,
  forgetMemoriesFromTexts,
  looksDerivedFrom,
} from "./memory/ForgetMessage";
export type {
  IForgetEventsResult,
  IForgetMemoriesResult,
} from "./memory/ForgetMessage";
export {
  buildQuotePreview,
  formatQuotedText,
  QUOTE_PREVIEW_MAX_CHARS,
} from "./llm/formatQuote";
export {
  convertMessageExamples,
  extractPngTextChunk,
  parseTavernCard,
  substituteCardPlaceholders,
  tavernCardToCharacterCard,
  TAVERN_PNG_KEYWORD,
} from "./characterCard/TavernCard";
export type {
  ITavernCard,
  ITavernCardMappingOptions,
  TavernCardParseError,
  TavernCardParseResult,
} from "./characterCard/TavernCard";
export {
  DEFAULT_LORE_MAX_CHARS,
  DEFAULT_LORE_MAX_ENTRIES,
  loreEntriesFromBook,
  renderLoreSection,
  selectLoreEntries,
} from "./lore/LoreKeeper";
export type { ILoreSelectionResult } from "./lore/LoreKeeper";
export {
  buildCharacterGenPrompt,
  DRAFT_ARCHETYPES,
  extractDraftName,
  formatDraftAsPromptText,
  MAX_DESCRIPTION_CHARS,
  MIN_DESCRIPTION_CHARS,
  parseCharacterGenResult,
} from "./character/CharacterForge";
export type { ICharacterDraft } from "./character/CharacterForge";
export {
  BASIC_STICKERS,
  findStickerById,
  pickSticker,
  STICKER_PACK_ID,
} from "./sticker/Stickers";
export type { IStickerAsset } from "./sticker/Stickers";
export { buildTranscript } from "./export/TranscriptExport";
export type { ITranscriptOptions } from "./export/TranscriptExport";

// ---------- 撤回 ----------

export {
  buildRecallNotice,
  canRecall,
  RECALL_WINDOW_MS,
  SELF_RECALL_NOTICE,
  toRecallMessage,
} from "./recall/Recall";

export { generateFallback } from "./llm/FallbackGenerator";
export type {
  ILLMRequest,
  ILLMMessage,
  ILLMAbortHandle,
  ILLMConfigInternal,
  LLMMessageRole,
  LLMErrorKind,
} from "./llm/types";
export { LLMError } from "./llm/types";

// ---------- 长期记忆 ----------

export {
  extractKeywords,
  retrieveMemories,
  scoreMemory,
  bigramSimilarity,
} from "./memory/MemoryRetriever";
export type { IRetrieveMemoriesOptions } from "./memory/MemoryRetriever";

export {
  buildDigestPrompt,
  parseDigest,
  runDigest,
  mergeMemories,
} from "./memory/MemoryDigest";
export type {
  IRunDigestOptions,
  IMergeMemoriesOptions,
  DigestFailureReason,
} from "./memory/MemoryDigest";

// ---------- 剧情 ----------

export {
  applyDigest,
  buildPlotAdvancePrompt,
  createEmptyPlotState,
  diffPlotCards,
  renderPlotSummary,
  rollbackPlotState,
} from "./plot/PlotKeeper";
export type {
  IApplyDigestOptions,
  IPlotCardChange,
  IPlotCardLike,
} from "./plot/PlotKeeper";

// ---------- 心情（跨轮次的情绪惯性） ----------

export {
  deriveMood,
  moodEmotionForSprite,
  MOOD_HALF_LIFE_MS,
  MOOD_MIN_INTENSITY,
  MOOD_WINDOW_MESSAGES,
  renderMoodStatePrompt,
  shouldInjectMood,
} from "./emotion/MoodTracker";
export type { IMoodState } from "./emotion/MoodTracker";

// ---------- 主动消息 ----------

export {
  buildProactivePrompt,
  buildProactiveQuery,
  describeChatGap,
  describeTimeOfDay,
} from "./proactive/ProactivePrompt";
export type { IProactivePromptInput } from "./proactive/ProactivePrompt";

// ---------- 存储层 ----------

export { getItem, setItem, removeItem, clearAll } from "./storage/ChatStorage";
export { SCHEMA_VERSION, migrateSnapshot } from "./storage/schema";
export { sanitizeRecord, sanitizeSessionSnapshot } from "./storage/sanitize";
export type { ISanitizeReport } from "./storage/sanitize";

// ---------- 数据备份 ----------

export {
  buildBackup,
  countBackup,
  countBackupMessages,
  mergeBackup,
  mergeRuntimeMessages,
  parseBackup,
  serializeBackup,
} from "./backup/BackupFile";

export {
  buildCharacterCard,
  instantiateCharacterCard,
  parseCharacterCard,
  serializeCharacterCard,
} from "./backup/CharacterCard";
export type {
  IInstantiateCardOptions,
  IInstantiatedCard,
} from "./backup/CharacterCard";
