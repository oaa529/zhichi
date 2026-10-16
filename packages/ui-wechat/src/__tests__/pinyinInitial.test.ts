/**
 * @file pinyinInitial.test.ts
 * 通讯录拼音分组：首字母取值的准确度与分组规则。
 *
 * 这套逻辑的坑（详见 pinyinInitial.ts 顶部注释）：
 * 浏览器 zh-CN 排序里汉字整体排在拉丁字母之前，所以**不能**用 A–Z 夹逼，
 * 必须用读音已知的汉字当锚点。
 */

import { describe, it, expect } from "vitest";
import {
  ALL_INITIALS,
  FALLBACK_INITIAL,
  groupByInitial,
  pinyinInitial,
} from "../utils/pinyinInitial";

describe("pinyinInitial · 首字母", () => {
  it("汉字取拼音首字母（覆盖每个字母段）", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["安", "A"],
      ["白", "B"],
      ["曹", "C"],
      ["戴", "D"],
      ["蛾", "E"],
      ["方", "F"],
      ["高", "G"],
      ["韩", "H"],
      ["姬", "J"],
      ["康", "K"],
      ["赖", "L"],
      ["马", "M"],
      ["倪", "N"],
      ["欧", "O"],
      ["潘", "P"],
      ["祁", "Q"],
      ["冉", "R"],
      ["尚", "S"],
      ["谈", "T"],
      ["万", "W"],
      ["奚", "X"],
      ["燕", "Y"],
      ["张", "Z"],
    ];
    for (const [char, expected] of cases) {
      expect(`${char}=${pinyinInitial(char)}`).toBe(`${char}=${expected}`);
    }
  });

  it("常见姓氏批量抽查（锚点选错的典型错位都覆盖到）", () => {
    // 白(bai)/高(gao)/康(kang) 曾经因为锚字选晚而掉到前一个字母
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["林", "L"],
      ["苏", "S"],
      ["李", "L"],
      ["王", "W"],
      ["赵", "Z"],
      ["陈", "C"],
      ["白", "B"],
      ["高", "G"],
      ["康", "K"],
      ["欧阳", "O"],
      ["司马", "S"],
    ];
    for (const [name, expected] of cases) {
      expect(`${name}=${pinyinInitial(name)}`).toBe(`${name}=${expected}`);
    }
  });

  it("英文名原样大写", () => {
    expect(pinyinInitial("alice")).toBe("A");
    expect(pinyinInitial("Bob")).toBe("B");
  });

  it("数字、emoji、符号归到 #", () => {
    expect(pinyinInitial("123")).toBe(FALLBACK_INITIAL);
    expect(pinyinInitial("😀开心")).toBe(FALLBACK_INITIAL);
    expect(pinyinInitial("   ")).toBe(FALLBACK_INITIAL);
  });

  it("索引条顺序：字母在前、# 在最后", () => {
    expect(ALL_INITIALS[0]).toBe("A");
    expect(ALL_INITIALS[ALL_INITIALS.length - 1]).toBe(FALLBACK_INITIAL);
  });
});

describe("groupByInitial · 分组", () => {
  const people = [
    { name: "苏晚晴" },
    { name: "Alice" },
    { name: "林笑笑" },
    { name: "Bob" },
    { name: "安小雅" },
  ];

  it("按首字母分组，组按索引顺序排、组内保持原顺序", () => {
    const groups = groupByInitial(people, (p) => p.name);

    expect(groups.map((g) => g.initial)).toEqual(["A", "B", "L", "S"]);
    // 同一个首字母即使不相邻也要并进同一组（Alice 与 安小雅 之间隔着别的字母）
    expect(groups[0]?.items.map((p) => p.name)).toEqual(["Alice", "安小雅"]);
    expect(groups[3]?.items.map((p) => p.name)).toEqual(["苏晚晴"]);
  });

  it("只产出非空分组（不为不存在的字母留空标题）", () => {
    const groups = groupByInitial([{ name: "苏晚晴" }], (p) => p.name);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.initial).toBe("S");
  });

  it("空数组返回空分组", () => {
    expect(groupByInitial([], () => "")).toEqual([]);
  });
});