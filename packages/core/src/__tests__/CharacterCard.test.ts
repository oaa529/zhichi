/**
 * @file CharacterCard.test.ts
 * 角色卡：构造 / 解析容错 / 实例化（重名、模板复用）。
 */

import { describe, it, expect } from "vitest";
import type { ICharacterProfile, IPromptTemplate } from "@wechat-rp/shared-types";
import {
  buildCharacterCard,
  instantiateCharacterCard,
  parseCharacterCard,
  serializeCharacterCard,
} from "../backup/CharacterCard";

const NOW = 1_700_000_000_000;

function makeCharacter(overrides: Partial<ICharacterProfile> = {}): ICharacterProfile {
  return {
    id: "char-original",
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
    promptTemplateId: "tpl-1",
    ...overrides,
  };
}

const template: IPromptTemplate = {
  id: "tpl-1",
  name: "临海小城",
  worldSetting: "现代都市",
  worldPlot: "两人刚认识",
};

describe("buildCharacterCard / serializeCharacterCard", () => {
  it("带模板时卡片自包含角色与模板", () => {
    const card = buildCharacterCard(makeCharacter(), template, NOW);
    expect(card.format).toBe("zhichi-character");
    expect(card.version).toBe(1);
    expect(card.exportedAt).toBe(NOW);
    expect(card.character.id).toBe("char-original");
    expect(card.promptTemplate?.name).toBe("临海小城");
  });

  it("没绑模板时不写 promptTemplate 字段", () => {
    const card = buildCharacterCard(makeCharacter(), null, NOW);
    expect(card.promptTemplate).toBeUndefined();
    // 注意：character.promptTemplateId 里也含 "promptTemplate" 字样，
    // 所以要按字段判断而不是按字符串包含判断
    const parsed = JSON.parse(serializeCharacterCard(card)) as Record<string, unknown>;
    expect(parsed.promptTemplate).toBeUndefined();
  });

  it("序列化后能原样解析回来", () => {
    const card = buildCharacterCard(makeCharacter(), template, NOW);
    const result = parseCharacterCard(serializeCharacterCard(card));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.character.displayName).toBe("苏晚晴");
    expect(result.card.promptTemplate?.worldSetting).toBe("现代都市");
  });
});

describe("parseCharacterCard", () => {
  it("空内容 / 坏 JSON / 无关 JSON 分别给出可读原因", () => {
    expect(parseCharacterCard("")).toEqual({ ok: false, error: "empty" });
    expect(parseCharacterCard("{ 坏")).toEqual({ ok: false, error: "not-json" });
    expect(parseCharacterCard('{"hello":"world"}')).toEqual({
      ok: false,
      error: "not-card",
    });
  });

  it("版本高于当前支持时报版本过新", () => {
    const raw = JSON.stringify({
      format: "zhichi-character",
      version: 99,
      character: { id: "c1", displayName: "名字" },
    });
    expect(parseCharacterCard(raw)).toEqual({
      ok: false,
      error: "version-too-new",
    });
  });

  it("缺 id 或显示名的角色卡判为不可用", () => {
    const noId = JSON.stringify({
      format: "zhichi-character",
      version: 1,
      character: { displayName: "名字" },
    });
    const noName = JSON.stringify({
      format: "zhichi-character",
      version: 1,
      character: { id: "c1", displayName: "   " },
    });
    expect(parseCharacterCard(noId)).toEqual({
      ok: false,
      error: "bad-character",
    });
    expect(parseCharacterCard(noName)).toEqual({
      ok: false,
      error: "bad-character",
    });
  });

  it("老卡片缺 exportedAt 也能导入（补 0）", () => {
    const raw = JSON.stringify({
      format: "zhichi-character",
      version: 1,
      character: { id: "c1", displayName: "苏晚晴" },
    });
    const result = parseCharacterCard(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.exportedAt).toBe(0);
  });
});

describe("instantiateCharacterCard", () => {
  it("导入是新增：换新 ID，不覆盖原角色", () => {
    const card = buildCharacterCard(makeCharacter(), template, NOW);
    const result = instantiateCharacterCard(card, {
      now: NOW,
      idFactory: (() => {
        let n = 0;
        return () => `new-${n++}`;
      })(),
    });

    expect(result.character.id).toBe("new-0");
    expect(result.renamed).toBe(false);
    expect(result.character.displayName).toBe("苏晚晴");
    // 模板也换了新 ID，并把角色指过去
    expect(result.template?.id).toBe("new-1");
    expect(result.character.promptTemplateId).toBe("new-1");
  });

  it("重名时加后缀，避免通讯录里两个一模一样的名字", () => {
    const card = buildCharacterCard(makeCharacter(), null, NOW);

    const first = instantiateCharacterCard(card, {
      takenNames: ["苏晚晴"],
      idFactory: () => "id-1",
    });
    expect(first.character.displayName).toBe("苏晚晴（导入）");
    expect(first.renamed).toBe(true);

    const second = instantiateCharacterCard(card, {
      takenNames: ["苏晚晴", "苏晚晴（导入）"],
      idFactory: () => "id-2",
    });
    expect(second.character.displayName).toBe("苏晚晴（导入 2）");
  });

  it("模板与已有模板完全一致时复用，不再堆一份副本", () => {
    const card = buildCharacterCard(makeCharacter(), template, NOW);
    const result = instantiateCharacterCard(card, {
      existingTemplates: { "tpl-1": { ...template } },
      idFactory: () => "id-x",
    });

    expect(result.template).toBeNull();
    expect(result.character.promptTemplateId).toBe("tpl-1");
  });

  it("卡片没带模板时，导入角色的模板绑定为空", () => {
    const card = buildCharacterCard(
      makeCharacter({ promptTemplateId: "tpl-1" }),
      null,
      NOW,
    );
    const result = instantiateCharacterCard(card, { idFactory: () => "id-y" });
    expect(result.template).toBeNull();
    expect(result.character.promptTemplateId).toBe("");
  });
});
