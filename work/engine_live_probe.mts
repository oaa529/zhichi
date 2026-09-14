/**
 * @file engine_live_probe.mts
 * 最强验证：真实引擎 + 真实模型 + 真实流式。
 *
 * 前几层验证分别是"解析器单测""引擎分片单测""模型合规性抽样"，
 * 这个脚本把它们串起来：拿 Agnes 当适配器喂给 RealismEngine，
 * 收集真正交付出去的气泡，检查
 *   ① 每个气泡的情绪是不是模型标的那个；
 *   ② 情绪词有没有漏进消息正文。
 *
 * 用法：$env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/engine_live_probe.mts
 */

import type {
  ICharacterProfile,
  IChunkDeliveredEvent,
  ILifecycleEvent,
  ISimulationConfig,
} from "@wechat-rp/shared-types";
import { RealismEngine } from "../packages/core/src/RealismEngine";
import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: false,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.5,
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
  replyStyle: { length: "short", allowActions: false },
};

const config: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: false,
  typoAutoCorrectEnabled: false,
  maxInterChunkDelayMs: 300,
};

const MESSAGES = ["我今天升职了！", "我养的猫昨天走了…", "周末去哪玩好呢"];

async function runOnce(userMessage: string, index: number): Promise<void> {
  const engine = new RealismEngine({
    profile,
    config,
    sessionId: `probe-${index}`,
    userId: "user",
  });
  engine.setLLMConfig({
    adapter: "openai",
    baseURL: BASE_URL,
    model: MODEL,
    temperature: 0.8,
    maxTokens: 1024,
    maxRetries: 1,
    timeoutMs: 90000,
  });

  const delivered: IChunkDeliveredEvent[] = [];
  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    engine.subscribe((output) => {
      if (output.event.kind === "chunk-delivered") {
        delivered.push(output.event);
      }
      if (output.event.kind === "lifecycle") {
        const phase = (output.event as ILifecycleEvent).phase;
        if (phase === "completed" || phase === "aborted") finish();
      }
    });
    engine.startStreamWithAdapter(
      userMessage,
      createOpenAIAdapter({
        config: {
          baseURL: BASE_URL,
          apiKey: API_KEY,
          model: MODEL,
          timeoutMs: 90000,
          maxRetries: 1,
          temperature: 0.8,
          maxTokens: 1024,
        },
      }),
    );
    setTimeout(finish, 60000);
  });

  const emotions = [...new Set(delivered.map((e) => e.message.emotion))];
  const text = delivered
    .map((e) => (e.message.type === "text" ? e.message.text : ""))
    .join("");
  const leaked = /^(neutral|happy|sad|angry|shy|surprised|thinking|sleepy)\b/i.test(
    text.trim(),
  );

  console.log(
    `\n[${userMessage}]\n` +
      `  气泡 ${delivered.length} 条，情绪 ${JSON.stringify(emotions)}${leaked ? "  ⚠️ 标签漏进正文" : ""}\n` +
      `  正文：${text.replace(/\s+/g, " ").slice(0, 60)}`,
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少 AGNES_API_KEY");
    process.exit(1);
  }
  for (const [index, message] of MESSAGES.entries()) {
    await runOnce(message, index);
  }
}

void main();
