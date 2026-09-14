/**
 * @file characterGenRunner.ts
 * 角色卡 AI 生成的组装层：把一句话描述发给当前配置的 LLM，拿回结构化草稿。
 *
 * 纯逻辑（指令构造 / 结果解析）在 core 的 CharacterForge.ts；
 * 这里只负责调用适配器、超时与错误提示。
 */

import {
  buildCharacterGenPrompt,
  extractDraftName,
  MAX_DESCRIPTION_CHARS,
  MIN_DESCRIPTION_CHARS,
  parseCharacterGenResult,
  type ICharacterDraft,
} from "@wechat-rp/core";
import type { ILLMRequest } from "@wechat-rp/core";
import { getApiConfigFromStore, getLLMAdapter } from "./llmRuntime";

/** 生成超时（模型要写一整张人设，给得比对话宽裕）。 */
const GEN_TIMEOUT_MS = 120_000;

/** 生成结果（界面据此填表或提示）。 */
export interface ICharacterGenResult {
  readonly ok: boolean;
  readonly draft?: ICharacterDraft;
  readonly message: string;
}

/** 生成进度：让用户看到"在动"，而不是对着一句"生成中…"干等半分钟。 */
export interface ICharacterGenProgress {
  /** 已接收的字符数。 */
  readonly receivedChars: number;
  /** 从流式输出里读到的角色名（还没写出来就是 null）。 */
  readonly name: string | null;
}

export interface ICharacterGenOptions {
  readonly userName?: string;
  readonly onProgress?: (progress: ICharacterGenProgress) => void;
  /** 外部取消（用户点"取消"）。 */
  readonly signal?: AbortSignal;
}

/**
 * 用一句话描述生成一张角色卡草稿。
 *
 * 失败一律返回可读中文提示，不抛异常（界面直接显示）。
 */
export function generateCharacterDraft(
  description: string,
  options: ICharacterGenOptions = {},
): Promise<ICharacterGenResult> {
  const userName = options.userName ?? "我";
  const trimmed = description.trim();
  if (trimmed.length < MIN_DESCRIPTION_CHARS) {
    return Promise.resolve({
      ok: false,
      message: "先用一句话描述想要的角色，比如「高中同桌，傲娇但细心」。",
    });
  }
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    return Promise.resolve({
      ok: false,
      message: `描述太长了（最多 ${MAX_DESCRIPTION_CHARS} 字），挑重点说。`,
    });
  }

  const apiConfig = getApiConfigFromStore();
  if (apiConfig.adapter === "mock") {
    return Promise.resolve({
      ok: false,
      message: "当前是本地演示模式，先在设置里配好 API 才能用 AI 生成。",
    });
  }

  const prompt = buildCharacterGenPrompt(trimmed, userName);
  const request: ILLMRequest = {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    model: apiConfig.model,
    maxTokens: 1600,
    // 角色创作需要一点发散；太低每次生成都一样
    temperature: 0.9,
  };

  return new Promise<ICharacterGenResult>((resolve) => {
    let settled = false;
    let abortHandle: { abort(reason?: string): void } | null = null;
    const controller = new AbortController();
    /** 累积的流式输出（用于进度提示与名字提取）。 */
    let received = "";
    let lastReportAt = 0;

    /** 外部取消：用户点了"取消"，或组件卸载。 */
    const handleExternalAbort = (): void => {
      abortHandle?.abort("character-gen-cancelled");
      finish({ ok: false, message: "已取消生成。" });
    };
    if (options.signal) {
      if (options.signal.aborted) {
        return Promise.resolve({ ok: false, message: "已取消生成。" });
      }
      options.signal.addEventListener("abort", handleExternalAbort, { once: true });
    }

    const finish = (result: ICharacterGenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", handleExternalAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      abortHandle?.abort("character-gen-timeout");
      finish({ ok: false, message: "生成超时了，稍后再试一次。" });
    }, GEN_TIMEOUT_MS);

    try {
      abortHandle = getLLMAdapter().stream(request, {
        onDelta: (delta) => {
          received += delta;
          // 节流上报：每个 token 都 setState 会把界面刷爆
          const now = Date.now();
          if (now - lastReportAt < 200) return;
          lastReportAt = now;
          options.onProgress?.({
            receivedChars: received.length,
            name: extractDraftName(received),
          });
        },
        onComplete: (fullText) => {
          const draft = parseCharacterGenResult(fullText);
          if (!draft) {
            finish({
              ok: false,
              message: "模型返回的内容没解析出角色卡，再生成一次试试。",
            });
            return;
          }
          finish({
            ok: true,
            draft,
            message: `已生成「${draft.displayName}」，可以直接用，也可以改。`,
          });
        },
        onError: (error) => {
          finish({
            ok: false,
            message: `调用模型失败：${String(error).slice(0, 80)}`,
          });
        },
        onAbort: () => {
          // 超时路径已经给出提示，这里不重复报
          finish({ ok: false, message: "生成被中断了，再试一次。" });
        },
      }, controller.signal);
    } catch (error) {
      console.warn("[characterGen] 启动失败：", error);
      finish({ ok: false, message: "启动生成失败，请重试。" });
    }
  });
}
