/**
 * @file templatePresets.test.ts
 * 内置模板预设：字段合法性、去重、生成逻辑。
 */

import { describe, it, expect } from "vitest";
import { PROMPT_FIELD_GROUPS } from "@wechat-rp/shared-types";
import {
  TEMPLATE_PRESETS,
  buildTemplateFromPreset,
} from "../utils/templatePresets";

/** 契约里定义过的全部字段名。 */
const KNOWN_FIELDS = new Set(
  PROMPT_FIELD_GROUPS.flatMap((group) =>
    group.fields.map((f) => String(f.key)),
  ),
);

describe("TEMPLATE_PRESETS", () => {
  it("每个预设都有 key / 名称 / 一句话说明，且 key 不重复", () => {
    const keys = TEMPLATE_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const preset of TEMPLATE_PRESETS) {
      expect(preset.key.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.summary.length).toBeGreaterThan(0);
    }
  });

  it("只使用契约里存在的字段（写错字段名等于白写）", () => {
    for (const preset of TEMPLATE_PRESETS) {
      for (const key of Object.keys(preset.fields)) {
        expect(KNOWN_FIELDS.has(key)).toBe(true);
      }
    }
  });

  it("每个预设都填了世界观与说话风格——这两类最影响回复质量", () => {
    for (const preset of TEMPLATE_PRESETS) {
      expect(preset.fields.worldSetting?.trim()).toBeTruthy();
      expect(preset.fields.worldPlot?.trim()).toBeTruthy();
      expect(preset.fields.speechTone?.trim()).toBeTruthy();
      expect(preset.fields.speechForbidden?.trim()).toBeTruthy();
    }
  });

  it("每个预设都带示例对话，且两种说话人成对出现", () => {
    for (const preset of TEMPLATE_PRESETS) {
      const examples = preset.fields.speechExamples ?? "";
      expect(examples.trim().length).toBeGreaterThan(0);
      // 至少要有一轮完整往返，否则示例起不到塑形作用
      expect(examples).toMatch(/用户[:：]/);
      expect(examples).toMatch(/角色[:：]/);
      expect((examples.match(/用户[:：]/g) ?? []).length).toBe(
        (examples.match(/角色[:：]/g) ?? []).length,
      );
    }
  });

  it("不给角色姓名/职业之外的个体信息，避免预设写死角色", () => {
    for (const preset of TEMPLATE_PRESETS) {
      // identityName 是留给用户填的，预设不该预设名字
      expect(preset.fields.identityName).toBeUndefined();
    }
  });
});

describe("buildTemplateFromPreset", () => {
  it("生成的新模板带独立 ID、沿用预设名与字段", () => {
    const preset = TEMPLATE_PRESETS[0]!;
    const template = buildTemplateFromPreset(preset, () => "tpl-fixed");

    expect(template.id).toBe("tpl-fixed");
    expect(template.name).toBe(preset.name);
    expect(template.worldSetting).toBe(preset.fields.worldSetting);
  });

  it("两次生成拿到不同 ID（可以基于同一预设建多个模板）", () => {
    const preset = TEMPLATE_PRESETS[0]!;
    let n = 0;
    const a = buildTemplateFromPreset(preset, () => `tpl-${n++}`);
    const b = buildTemplateFromPreset(preset, () => `tpl-${n++}`);
    expect(a.id).not.toBe(b.id);
  });

  it("不改动预设本身（预设是共享常量）", () => {
    const preset = TEMPLATE_PRESETS[0]!;
    const before = JSON.stringify(preset);
    const template = buildTemplateFromPreset(preset);
    // 生成的模板是普通对象，改它不该回写到预设常量上
    (template as { name: string }).name = "改过的名字";
    expect(template.name).toBe("改过的名字");
    expect(JSON.stringify(preset)).toBe(before);
  });
});
