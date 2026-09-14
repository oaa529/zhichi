/**
 * @file LoreKeeper.test.ts
 * 世界书：检索触发、预算控制、社区卡 character_book 归一化。
 */

import { describe, it, expect } from "vitest";
import type { ILoreEntry } from "@wechat-rp/shared-types";
import {
  DEFAULT_LORE_MAX_ENTRIES,
  loreEntriesFromBook,
  renderLoreSection,
  selectLoreEntries,
} from "../lore/LoreKeeper";

function makeEntry(overrides: Partial<ILoreEntry> = {}): ILoreEntry {
  return {
    id: "lore-1",
    keys: ["唱片"],
    secondaryKeys: [],
    content: "店里收藏了三千张黑胶。",
    enabled: true,
    order: 0,
    caseSensitive: false,
    constant: false,
    selective: false,
    ...overrides,
  };
}

describe("selectLoreEntries", () => {
  it("关键词命中就注入（中文字符串包含）", () => {
    const result = selectLoreEntries("你店里的唱片都是哪来的", [
      makeEntry(),
      makeEntry({ id: "lore-2", keys: ["台风"], content: "小镇每年夏天都有台风。" }),
    ]);

    expect(result.entries.map((e) => e.id)).toEqual(["lore-1"]);
    expect(result.stats.injected).toBe(1);
    expect(result.stats.total).toBe(2);
  });

  it("英文关键词默认不区分大小写", () => {
    const entry = makeEntry({ keys: ["Coffee"], content: "She loves coffee." });
    expect(selectLoreEntries("i want coffee", [entry]).entries).toHaveLength(1);
    expect(selectLoreEntries("I WANT COFFEE", [entry]).entries).toHaveLength(1);
  });

  it("caseSensitive 为 true 时严格匹配大小写", () => {
    const entry = makeEntry({
      keys: ["Coffee"],
      content: "She loves coffee.",
      caseSensitive: true,
    });
    expect(selectLoreEntries("i want coffee", [entry]).entries).toHaveLength(0);
    expect(selectLoreEntries("I want Coffee", [entry]).entries).toHaveLength(1);
  });

  it("常驻条目无需命中，每轮都注入", () => {
    const entry = makeEntry({
      keys: [],
      constant: true,
      content: "故事发生在海边小镇。",
    });
    expect(selectLoreEntries("随便说点什么", [entry]).entries).toHaveLength(1);
  });

  it("selective 条目需要次级关键词同时出现", () => {
    const entry = makeEntry({
      keys: ["雨"],
      secondaryKeys: ["伞"],
      selective: true,
      content: "她那把伞是蓝色的。",
    });

    expect(selectLoreEntries("今天下雨了", [entry]).entries).toHaveLength(0);
    expect(selectLoreEntries("下雨了，我忘了带伞", [entry]).entries).toHaveLength(1);
  });

  it("停用与空内容的条目不参与检索", () => {
    const entries = [
      makeEntry({ id: "off", enabled: false }),
      makeEntry({ id: "empty", content: "   " }),
      makeEntry({ id: "blank-key", keys: ["  "] }),
    ];
    const result = selectLoreEntries("唱片", entries);
    expect(result.entries).toHaveLength(0);
    // 停用与空内容不进候选池；关键词是空白的条目进池但命中不了
    expect(result.stats.total).toBe(1);
    expect(result.stats.injected).toBe(0);
  });

  it("按插入顺序排序（order 小的先注入）", () => {
    const entries = [
      makeEntry({ id: "late", order: 100, content: "后来的设定" }),
      makeEntry({ id: "early", order: 1, content: "先说的设定" }),
    ];
    expect(selectLoreEntries("唱片", entries).entries.map((e) => e.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("条数上限：超出的条目被丢弃并计入统计", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      makeEntry({ id: `lore-${i}`, order: i, content: `第 ${i} 条设定` }),
    );
    const result = selectLoreEntries("唱片", entries, { maxEntries: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.id)).toEqual(["lore-0", "lore-1", "lore-2"]);
    expect(result.stats.droppedByBudget).toBe(5);
  });

  it("字数上限：超预算的条目跳过，但后面的短条目仍有机会", () => {
    const entries = [
      makeEntry({ id: "big", order: 0, content: "字".repeat(30) }),
      makeEntry({ id: "small", order: 1, content: "短设定" }),
    ];
    const result = selectLoreEntries("唱片", entries, { maxChars: 20 });

    expect(result.entries.map((e) => e.id)).toEqual(["small"]);
    expect(result.stats.droppedByBudget).toBe(1);
  });

  it("第一条就超预算时截断保留，而不是什么都不注入", () => {
    const entry = makeEntry({ content: "字".repeat(50) });
    const result = selectLoreEntries("唱片", [entry], { maxChars: 10 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.content).toBe(`${"字".repeat(9)}…`);
  });

  it("默认预算：最多 5 条", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: `lore-${i}`, order: i, content: `设定 ${i}` }),
    );
    expect(selectLoreEntries("唱片", entries).entries).toHaveLength(
      DEFAULT_LORE_MAX_ENTRIES,
    );
  });
});

describe("renderLoreSection", () => {
  it("没有条目时返回空串（不产生空段落）", () => {
    expect(renderLoreSection([])).toBe("");
  });

  it("有条目时渲染成带标题的列表", () => {
    const text = renderLoreSection([
      makeEntry({ content: "店里收藏了三千张黑胶。" }),
      makeEntry({ id: "lore-2", content: "小镇每年夏天都有台风。" }),
    ]);
    expect(text).toBe(
      "【世界设定】\n- 店里收藏了三千张黑胶。\n- 小镇每年夏天都有台风。",
    );
  });
});

describe("loreEntriesFromBook", () => {
  const idFactory = (index: number): string => `id-${index}`;

  it("归一化社区卡的 character_book（含缺省值与可选字段）", () => {
    const entries = loreEntriesFromBook(
      {
        entries: [
          {
            keys: ["唱片", "黑胶"],
            content: "店里收藏了三千张黑胶。",
            insertion_order: 10,
            constant: true,
            comment: "背景",
          },
          {
            keys: ["台风"],
            secondary_keys: ["雨"],
            content: "小镇每年夏天都有台风。",
            enabled: false,
            case_sensitive: true,
            selective: true,
          },
        ],
      },
      idFactory,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "id-0",
      keys: ["唱片", "黑胶"],
      order: 10,
      constant: true,
      enabled: true,
      selective: false,
      comment: "背景",
    });
    expect(entries[1]).toMatchObject({
      id: "id-1",
      enabled: false,
      caseSensitive: true,
      selective: true,
      secondaryKeys: ["雨"],
    });
  });

  it("结构不对的条目逐条丢弃，不拖垮整本世界书", () => {
    const entries = loreEntriesFromBook(
      {
        entries: [
          null,
          42,
          { keys: ["ok"], content: "有效条目" },
          { keys: ["no-content"] },
        ],
      },
      idFactory,
    );
    expect(entries.map((e) => e.content)).toEqual(["有效条目"]);
  });

  it("没有世界书或结构不对时返回空数组", () => {
    expect(loreEntriesFromBook(undefined, idFactory)).toEqual([]);
    expect(loreEntriesFromBook({}, idFactory)).toEqual([]);
    expect(loreEntriesFromBook("nope", idFactory)).toEqual([]);
    expect(loreEntriesFromBook({ entries: "nope" }, idFactory)).toEqual([]);
  });
});
