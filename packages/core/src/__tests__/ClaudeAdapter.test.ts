/**
 * @file ClaudeAdapter.test.ts
 * Claude 请求体构造：多条 system 消息必须全部送达（旧实现只取第一条）。
 */

import { describe, it, expect } from "vitest";
import { buildClaudeRequestBody } from "../llm/ClaudeAdapter";
import type { ILLMRequest } from "../llm/types";

function makeRequest(messages: ILLMRequest["messages"]): ILLMRequest {
  return {
    messages,
    model: "claude-3-5-haiku-20241022",
    maxTokens: 1024,
    temperature: 0.8,
  };
}

describe("buildClaudeRequestBody", () => {
  it("多条 system 按顺序合并进顶层 system 字段", () => {
    const body = buildClaudeRequestBody(
      makeRequest([
        { role: "system", content: "你是苏晚晴。" },
        { role: "user", content: "历史消息" },
        { role: "system", content: "【你记得的事】用户对花生过敏" },
        { role: "user", content: "今天吃什么" },
      ]),
      true,
    );

    expect(body.system).toBe(
      "你是苏晚晴。\n\n【你记得的事】用户对花生过敏",
    );
    // 对话消息保持原顺序，且不再包含 system
    expect(body.messages).toEqual([
      { role: "user", content: "历史消息" },
      { role: "user", content: "今天吃什么" },
    ]);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
  });

  it("裁剪后追加的「前情提要」摘要不会丢（回归：旧实现被静默丢弃）", () => {
    const body = buildClaudeRequestBody(
      makeRequest([
        { role: "system", content: "人设" },
        { role: "system", content: "【前情提要】用户：早上好；角色：早" },
        { role: "user", content: "在吗" },
      ]),
      true,
    );
    expect(body.system).toContain("人设");
    expect(body.system).toContain("【前情提要】");
  });

  it("空白 system 段被跳过，不留多余空行", () => {
    const body = buildClaudeRequestBody(
      makeRequest([
        { role: "system", content: "  " },
        { role: "system", content: "人设" },
        { role: "user", content: "你好" },
      ]),
      true,
    );
    expect(body.system).toBe("人设");
  });

  it("完全没有 system 消息时降级为空字符串", () => {
    const body = buildClaudeRequestBody(
      makeRequest([{ role: "user", content: "你好" }]),
      false,
    );
    expect(body.system).toBe("");
    expect(body.stream).toBe(false);
  });
});
