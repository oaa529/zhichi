/**
 * @file vitest.config.ts
 * Vitest 配置（根级，覆盖所有 workspace 包）。
 *
 * - environment: jsdom（React 组件测试需要 DOM）
 * - coverage: v8 provider，core 包目标 ≥ 80%
 * - alias: @wechat-rp/* 指向 workspace 源码
 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@wechat-rp/shared-types": resolve(__dirname, "shared/types/src/index.ts"),
      "@wechat-rp/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@wechat-rp/ui-wechat": resolve(__dirname, "packages/ui-wechat/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "packages/**/src/__tests__/**/*.test.ts",
      "packages/**/src/__tests__/**/*.test.tsx",
      // 组装层（apps/web）此前是测试盲区：只靠浏览器手测，
      // 而这些文件正是改动最频繁的地方
      "apps/web/src/__tests__/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "packages/core/src/Chunker.ts",
        "packages/core/src/SemanticBuffer.ts",
        "packages/core/src/TypingSimulator.ts",
        "packages/core/src/PresenceManager.ts",
        "packages/core/src/RealismEngine.ts",
        "packages/core/src/llm/ContextTrimmer.ts",
        "packages/core/src/llm/MockAdapter.ts",
        "packages/core/src/llm/PromptBuilder.ts",
        "packages/core/src/llm/toLLMHistory.ts",
        "packages/core/src/llm/formatQuote.ts",
        "packages/core/src/llm/characterQuote.ts",
        "packages/core/src/llm/AntiRepeat.ts",
        "packages/core/src/llm/abort.ts",
        "packages/core/src/llm/OpenAIAdapter.ts",
        "packages/core/src/llm/FallbackGenerator.ts",
        "packages/core/src/memory/MemoryRetriever.ts",
        "packages/core/src/memory/MemoryDigest.ts",
        "packages/core/src/memory/ForgetMessage.ts",
        "packages/core/src/emotion/MoodTracker.ts",
        "packages/core/src/plot/PlotKeeper.ts",
        "packages/core/src/time/Clock.ts",
        "packages/core/src/backup/BackupFile.ts",
        "packages/core/src/characterCard/TavernCard.ts",
        "packages/core/src/lore/LoreKeeper.ts",
        "packages/core/src/character/CharacterForge.ts",
        "packages/core/src/sticker/Stickers.ts",
        "packages/core/src/export/TranscriptExport.ts",
        "packages/core/src/recall/Recall.ts",
        "packages/ui-wechat/src/store/chatStore.ts",
        // 组装层里唯一有"真逻辑"的文件：窗口锚点与游标推进都在这儿
        "apps/web/src/digestRunner.ts",
      ],
      exclude: [
        "packages/**/src/__tests__/**",
        "packages/**/src/**/*.d.ts",
        "packages/**/src/index.ts",
        "packages/**/src/types.ts",
        "packages/**/src/llm/LLMAdapter.ts",
        "packages/**/src/llm/ClaudeAdapter.ts",
        "packages/**/src/llm/types.ts",
        "packages/**/src/storage/**",
        "packages/**/src/components/**",
        "packages/**/src/hooks/**",
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
});
