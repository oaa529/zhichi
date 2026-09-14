/**
 * @file llmRuntime.ts
 * LLM 运行时配置入口。
 *
 * 优先从 useSessionStore 读取 API 配置。
 * VITE_LLM_* 环境变量仅作为首次启动 fallback（无 store 数据时）。
 *
 * apiKey 仅存于内存，不持久化。
 */

import type { ILLMConfig, IApiConfig } from "@wechat-rp/shared-types";
import {
  createOpenAIAdapter,
  createClaudeAdapter,
  createMockAdapter,
  type ILLMAdapter,
  type ILLMConfigInternal,
  type IConnectionTestResult,
} from "@wechat-rp/core";

/** 从 VITE 环境变量读取 fallback 配置。 */
function getEnvFallback(): IApiConfig {
  const env = import.meta.env as Record<string, string | undefined>;
  const getEnv = (key: string, fb: string): string => env[key] ?? fb;
  const getEnvNum = (key: string, fb: number): number => {
    const v = getEnv(key, String(fb));
    const n = Number(v);
    return Number.isNaN(n) ? fb : n;
  };
  return {
    adapter: getEnv("VITE_LLM_ADAPTER", "mock") as IApiConfig["adapter"],
    provider: getEnv("VITE_LLM_PROVIDER", "mock") as IApiConfig["provider"],
    baseURL: getEnv("VITE_LLM_BASE_URL", "https://api.openai.com/v1"),
    model: getEnv("VITE_LLM_MODEL", "gpt-4o-mini"),
    temperature: getEnvNum("VITE_LLM_TEMPERATURE", 800) / 1000,
    maxTokens: getEnvNum("VITE_LLM_MAX_TOKENS", 1024),
    maxRetries: getEnvNum("VITE_LLM_MAX_RETRIES", 3),
    timeoutMs: getEnvNum("VITE_LLM_TIMEOUT_MS", 30000),
  };
}

/** 从 VITE 环境变量读取 fallback API key。 */
function getEnvApiKey(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_LLM_API_KEY ?? "";
}

/**
 * 从 store 获取当前 API 配置（含 fallback 到环境变量）。
 */
export function getApiConfigFromStore(): IApiConfig {
  try {
    // 动态导入避免循环依赖
    const store = (window as unknown as { __sessionStore?: { getState: () => { apiConfig: IApiConfig } } }).__sessionStore;
    if (store) {
      const config = store.getState().apiConfig;
      if (config.baseURL || config.adapter !== "mock") {
        return config;
      }
    }
  } catch {
    // store 未初始化，用 fallback
  }
  return getEnvFallback();
}

/**
 * 从 store 获取当前 API key。
 */
export function getApiKeyFromStore(): string {
  try {
    const store = (window as unknown as { __sessionStore?: { getState: () => { apiKey: string } } }).__sessionStore;
    if (store) {
      const key = store.getState().apiKey;
      if (key) return key;
    }
  } catch {
    // store 未初始化
  }
  return getEnvApiKey();
}

/**
 * 获取 LLM 配置（shared 类型，不含 apiKey）。
 */
export function getLLMConfig(): ILLMConfig {
  const apiConfig = getApiConfigFromStore();
  return {
    adapter: apiConfig.adapter,
    baseURL: apiConfig.baseURL,
    model: apiConfig.model,
    temperature: apiConfig.temperature,
    maxTokens: apiConfig.maxTokens,
    maxRetries: apiConfig.maxRetries,
    timeoutMs: apiConfig.timeoutMs,
  };
}

/**
 * 构造适配器内部配置（含 apiKey）。
 */
function getInternalConfig(): ILLMConfigInternal {
  const apiConfig = getApiConfigFromStore();
  return {
    baseURL: apiConfig.baseURL,
    apiKey: getApiKeyFromStore(),
    model: apiConfig.model,
    timeoutMs: apiConfig.timeoutMs,
    maxRetries: apiConfig.maxRetries,
    temperature: apiConfig.temperature,
    maxTokens: apiConfig.maxTokens,
  };
}

// 单例适配器
let adapterInstance: ILLMAdapter | null = null;

/**
 * 开发期调试：把最近一次 LLM 请求挂到 window 上，
 * 便于在浏览器控制台/自动化里核对 prompt 组装结果（人设模板、记忆、剧情是否注入）。
 * 生产构建不启用。
 */
function withDebugCapture(adapter: ILLMAdapter): ILLMAdapter {
  if (!import.meta.env.DEV) return adapter;
  return {
    stream(req, handlers, signal) {
      const w = window as unknown as {
        __lastLLMRequest?: unknown;
        __llmRequests?: unknown[];
      };
      w.__lastLLMRequest = req;
      // 保留最近 5 次请求：聊天、后台整理会共用同一适配器，数组便于区分
      w.__llmRequests ??= [];
      w.__llmRequests.unshift(req);
      w.__llmRequests.length = Math.min(w.__llmRequests.length, 5);
      return adapter.stream(req, handlers, signal);
    },
    testConnection: () => adapter.testConnection(),
  };
}

/**
 * 获取 LLM 适配器实例（单例）。
 */
export function getLLMAdapter(): ILLMAdapter {
  if (adapterInstance) return adapterInstance;

  const kind = getApiConfigFromStore().adapter;
  const internalConfig = getInternalConfig();

  switch (kind) {
    case "openai":
      adapterInstance = withDebugCapture(
        createOpenAIAdapter({ config: internalConfig }),
      );
      break;
    case "claude":
      adapterInstance = withDebugCapture(
        createClaudeAdapter({ config: internalConfig }),
      );
      break;
    case "mock":
    default:
      adapterInstance = withDebugCapture(
        createMockAdapter({ config: internalConfig }),
      );
      break;
  }

  return adapterInstance;
}

/**
 * 是否使用真实 LLM（非 mock）。
 */
export function isUsingRealLLM(): boolean {
  return getApiConfigFromStore().adapter !== "mock";
}

/**
 * 重置适配器单例（API 配置变更后调用 recreateAdapter）。
 */
export function resetLLMAdapter(): void {
  adapterInstance = null;
}

/**
 * 重建适配器并通知所有引擎（API config 变更后调用）。
 * @param engineManager 引擎管理器实例
 */
export function recreateAdapter(
  engineManager?: { setLLMConfig: (config: ILLMConfig) => void },
): void {
  resetLLMAdapter();
  const config = getLLMConfig();
  if (engineManager) {
    engineManager.setLLMConfig(config);
  }
}

/**
 * 创建临时适配器（用于测试连接，不影响单例）。
 */
function createTempAdapter(): ILLMAdapter {
  const kind = getApiConfigFromStore().adapter;
  const internalConfig = getInternalConfig();

  switch (kind) {
    case "openai":
      return createOpenAIAdapter({ config: internalConfig });
    case "claude":
      return createClaudeAdapter({ config: internalConfig });
    case "mock":
    default:
      return createMockAdapter({ config: internalConfig });
  }
}

/**
 * 测试当前 API 配置是否可用。
 * 创建临时适配器（不替换单例），发起一次最小化请求。
 */
export async function testLLMConnection(): Promise<IConnectionTestResult> {
  try {
    const temp = createTempAdapter();
    return await temp.testConnection();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs: 0,
      error: msg,
      errorKind: "unknown",
    };
  }
}
