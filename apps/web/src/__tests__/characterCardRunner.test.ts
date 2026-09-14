/**
 * @file characterCardRunner.test.ts
 * 角色卡导入导出：自家卡往返、社区卡（V2）映射、错误提示。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import {
  exportCharacterCardToFile,
  importCharacterCardFile,
} from "../characterCardRunner";

const downloads: Array<{ text: string; filename: string }> = [];
vi.mock("../download", () => ({
  downloadTextFile: (text: string, filename: string) => {
    downloads.push({ text, filename });
  },
  sanitizeFileName: (name: string) => name,
}));

const CHAR = "char-1";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "苏晚晴",
  bio: "邻家姐姐",
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
};

/**
 * 造一个"像 File 的东西"。
 *
 * jsdom 的 File 没有 `text()`（浏览器里有），而 runner 正是用它在读文件——
 * 所以这里给测试替身补上，测到的是 runner 的真实逻辑。
 */
function textFile(name: string, content: string, type = "application/json"): File {
  return {
    name,
    type,
    size: content.length,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as unknown as File;
}

function jsonFile(name: string, content: unknown): File {
  return textFile(name, JSON.stringify(content));
}

beforeEach(() => {
  downloads.length = 0;
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    contacts: {},
    sessions: {},
    promptTemplates: {},
    loreEntries: {},
    memories: {},
    activeSessionId: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("exportCharacterCardToFile", () => {
  it("导出自家角色卡：内容是 JSON、文件名带角色名且不含记忆", () => {
    const result = exportCharacterCardToFile(CHAR, 1_700_000_000_000);

    expect(result.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toContain("苏晚晴");
    const parsed = JSON.parse(downloads[0]!.text) as {
      format: string;
      character: { displayName: string };
    };
    expect(parsed.format).toBe("zhichi-character");
    expect(parsed.character.displayName).toBe("苏晚晴");
    // 记忆不该跟着卡片传播
    expect(downloads[0]!.text).not.toContain("memories");
  });

  it("角色不存在时给提示、不下载", () => {
    const result = exportCharacterCardToFile("不存在", 1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("找不到");
    expect(downloads).toHaveLength(0);
  });
});

describe("importCharacterCardFile", () => {
  it("导入自家角色卡：新增一个角色", async () => {
    // 先导出，再把导出的内容当文件导回来（往返验证）
    exportCharacterCardToFile(CHAR, 1_700_000_000_000);
    const file = textFile("card.json", downloads[0]!.text);
    useSessionStore.setState({ characters: {} });

    const result = await importCharacterCardFile(file);

    expect(result.ok).toBe(true);
    expect(Object.values(useSessionStore.getState().characters)).toHaveLength(1);
  });

  it("导入社区卡（SillyTavern V2）：角色与世界观条目一起落库", async () => {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "林见夏",
        description: "海边小镇的旧唱片店老板。",
        personality: "懒散但敏锐。",
        scenario: "台风天的傍晚。",
        first_mes: "外面雨太大了，先坐会儿吧。",
        mes_example: "<START>\n{{user}}: 这张唱片是谁的\n{{char}}: 一个再也没回来的人。",
        character_book: {
          entries: [
            {
              keys: ["唱片"],
              content: "店里收藏了三千张黑胶。",
              insertion_order: 0,
              enabled: true,
            },
          ],
        },
      },
    };

    const result = await importCharacterCardFile(jsonFile("tavern.json", card));

    expect(result.ok).toBe(true);
    expect(result.message).toContain("社区卡");
    const state = useSessionStore.getState();
    const imported = Object.values(state.characters).find(
      (c) => c.displayName === "林见夏",
    );
    expect(imported).toBeTruthy();
    // 开场白与世界观条目都跟着进来
    expect(imported!.greeting).toContain("外面雨太大了");
    const lore = state.loreEntries[imported!.id] ?? [];
    expect(lore.map((entry) => entry.content)).toContain(
      "店里收藏了三千张黑胶。",
    );
  });

  it("既不是自家卡也不是社区卡时给出可读提示", async () => {
    const result = await importCharacterCardFile(
      jsonFile("random.json", { foo: "bar" }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是可识别的角色卡");
  });

  it("坏 JSON 不会抛异常，只给提示", async () => {
    const file = textFile("broken.json", "这不是 JSON");
    const result = await importCharacterCardFile(file);
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe("string");
  });

  it("重名时自动加后缀，不覆盖已有角色", async () => {
    exportCharacterCardToFile(CHAR, 1_700_000_000_000);
    const file = textFile("card.json", downloads[0]!.text);

    const result = await importCharacterCardFile(file);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("加了后缀");
    const names = Object.values(useSessionStore.getState().characters).map(
      (c) => c.displayName,
    );
    expect(names).toHaveLength(2);
    expect(names).toContain("苏晚晴（导入）");
  });
});
