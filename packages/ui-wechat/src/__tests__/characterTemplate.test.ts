/**
 * @file characterTemplate.test.ts
 * 角色专属提示词模板的构建测试（对应"编辑器提示词被丢弃"的回归）。
 */

import { describe, it, expect } from "vitest";
import {
  buildCharacterTemplate,
  resolveCharacterTemplateId,
} from "../utils/characterTemplate";

describe("resolveCharacterTemplateId", () => {
  it("同一角色生成稳定且唯一的模板 ID", () => {
    const a = resolveCharacterTemplateId("char-1");
    expect(a).toBe(resolveCharacterTemplateId("char-1"));
    expect(a).not.toBe(resolveCharacterTemplateId("char-2"));
  });
});

describe("buildCharacterTemplate", () => {
  it("填写提示词时生成模板（绑定角色专属 ID）", () => {
    const tpl = buildCharacterTemplate("char-1", "苏晚晴", "温柔体贴，喜欢猫。");
    expect(tpl).not.toBeNull();
    expect(tpl!.id).toBe(resolveCharacterTemplateId("char-1"));
    expect(tpl!.name).toBe("苏晚晴 的人设");
    expect(tpl!.content).toBe("温柔体贴，喜欢猫。");
  });

  it("内容为空或纯空白时不生成模板", () => {
    expect(buildCharacterTemplate("char-1", "苏晚晴", "")).toBeNull();
    expect(buildCharacterTemplate("char-1", "苏晚晴", "   \n  ")).toBeNull();
  });

  it("去除首尾空白后保存", () => {
    const tpl = buildCharacterTemplate("char-1", "苏晚晴", "  你好  ");
    expect(tpl!.content).toBe("你好");
  });
});
