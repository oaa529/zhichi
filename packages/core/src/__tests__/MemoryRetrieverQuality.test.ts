/**
 * @file MemoryRetrieverQuality.test.ts
 * 检索质量的**带标准答案**回归测试。
 *
 * 由来：真机量化发现旧口径有两个硬伤——
 * 1. 没有任何相关性门槛，一句"在吗"也会按重要度塞满 10 条记忆
 *    （实测无关提问平均注入 9 条，每轮白烧 ~700 字，还可能把角色带偏）；
 * 2. 命中率按"记忆自己的关键词数"归一，关键词写得多的记忆反而吃亏。
 *
 * 现在这组用例把"该进来的 / 不该进来的"钉住：
 * 改动若放松了门槛、破坏了去重或丢了召回，这里会立刻红。
 */

import { describe, it, expect } from "vitest";
import type { IMemory } from "@wechat-rp/shared-types";
import { retrieveMemories } from "../memory/MemoryRetriever";

const NOW = new Date(2026, 8, 13, 15, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function memory(
  id: string,
  content: string,
  keywords: ReadonlyArray<string>,
  importance: number,
  ageDays = 1,
  pinned = false,
): IMemory {
  return {
    id,
    characterId: "char-1",
    kind: "fact",
    content,
    keywords,
    importance: importance as 1 | 2 | 3 | 4 | 5,
    pinned,
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW - ageDays * DAY,
    sourceMessageIds: [],
  };
}

/** 一半是真正有用的信息，一半是日常琐事（用来检验区分度）。 */
const MEMORIES: ReadonlyArray<IMemory> = [
  memory("m-cat", "用户养了一只叫团团的猫，最近得了肠胃炎在吃药", ["团团", "猫", "肠胃炎"], 4),
  memory("m-coffee", "用户戒了咖啡改喝白茶，因为胃不好", ["咖啡", "白茶", "胃"], 3),
  memory("m-hz", "用户下周三要去杭州出差三天", ["杭州", "出差"], 4),
  memory("m-mom", "用户母亲下个月生日，喜欢养花，最爱蝴蝶兰", ["母亲", "生日", "花"], 3),
  memory("m-coriander", "用户从小不吃香菜，闻着都难受", ["香菜"], 2),
  memory("m-job", "用户跳槽到互联网公司做产品经理", ["跳槽", "工作", "产品"], 4),
  memory("m-guitar", "用户报了吉他班，每周三晚上在公司附近上课", ["吉他", "上课"], 3),
  memory("m-run", "用户最近开始晨跑，六点半出门", ["晨跑", "跑步"], 2),
  memory("m-exhibit", "两人约好周六去摄影展，苏晚晴加班爽约了", ["摄影展", "爽约"], 5),
  memory("m-move", "用户下周要搬家，书太多需要帮忙", ["搬家", "书"], 3),
  memory("m-album", "苏晚晴送了一本摄影集给用户赔罪", ["摄影集", "赔罪"], 3),
  memory("m-contract", "用户出差要带的合同放在蓝色文件夹里", ["合同", "文件夹"], 3),
  memory("m-interview", "用户面试被问懵了，心情不太好", ["面试"], 2, 0.1),
  memory("m-weather", "用户所在的城市最近降温了", ["降温", "天气"], 1, 0.1),
  memory("m-movie", "用户喜欢周末看电影", ["电影", "周末"], 2, 5),
  memory("m-milk", "用户每天早上喝一杯牛奶", ["牛奶", "早上"], 2, 5),
  memory("m-busy", "用户最近工作很忙，经常加班", ["工作", "加班"], 2, 3),
  memory("m-subway", "用户住在地铁站附近，通勤很方便", ["地铁", "通勤"], 1, 8),
  memory("m-plant", "用户在工位上养了一盆绿萝", ["绿萝", "工位"], 1, 6),
  memory("m-noodle", "用户喜欢吃辣，无辣不欢", ["辣", "吃"], 2, 7),
  memory("m-sleep", "用户经常熬夜，睡得比较晚", ["熬夜", "睡"], 2, 2),
  memory("m-book", "用户在看一本讲海边小镇的小说", ["小说", "书"], 1, 4),
  memory("m-keyboard", "用户换了个静音键盘，室友不再抗议", ["键盘", "室友"], 1, 9),
  memory("m-rain", "用户那边最近常下雨", ["下雨", "伞"], 1, 0.5),
  memory("m-gift", "用户给母亲买过一盆兰花", ["母亲", "兰花"], 2, 15),
  // 同一件事的两种说法：注入时只该留一条
  memory("m-cat-dup", "用户养了一只猫，名字叫团团", ["猫", "名字"], 2, 10),
  memory("m-gu", "用户的工作内容主要是产品设计", ["工作", "产品"], 3, 3),
  memory("m-hz2", "杭州那边的项目需要用户去对接", ["杭州", "项目"], 3, 2),
  memory("m-old-coffee", "用户以前很喜欢喝拿铁", ["咖啡", "拿铁"], 1, 20),
  memory("m-pin", "用户对花生过敏（置顶要永远记住）", ["花生", "过敏"], 5, 30, true),
];

interface ICase {
  readonly query: string;
  readonly expect: ReadonlyArray<string>;
}

/** 该召回的：期望至少命中其中一个 id。 */
const RECALL_CASES: ReadonlyArray<ICase> = [
  { query: "团团今天怎么样？还在吃药吗", expect: ["m-cat"] },
  { query: "我下周去杭州出差，那边天气如何", expect: ["m-hz", "m-hz2"] },
  { query: "我妈生日送什么好", expect: ["m-mom"] },
  { query: "我到底能不能喝咖啡", expect: ["m-coffee", "m-old-coffee"] },
  { query: "晚上点外卖要不要放香菜", expect: ["m-coriander"] },
  { query: "周六那个展你还去吗", expect: ["m-exhibit"] },
  { query: "我搬家你能来帮忙吗", expect: ["m-move"] },
  { query: "我出差要带的那份文件放哪了", expect: ["m-contract"] },
  { query: "工作最近怎么样", expect: ["m-job", "m-gu", "m-busy"] },
];

/** 没有任何记忆对得上的话：理想情况只注入置顶那条。 */
const NO_MATCH_QUERIES: ReadonlyArray<string> = [
  "今天天气不错啊",
  "在吗",
  "我刚睡醒，脑子还有点糊",
];

describe("记忆检索质量（带标准答案）", () => {
  it("该召回的都能召回", () => {
    const missed: string[] = [];
    for (const testCase of RECALL_CASES) {
      const picked = retrieveMemories(testCase.query, MEMORIES, { now: NOW });
      const ids = picked.map((memory) => memory.id);
      if (!testCase.expect.some((id) => ids.includes(id))) {
        missed.push(`「${testCase.query}」→ ${ids.join(",") || "（空）"}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("无关的话不会把记忆段塞满（改造前每句平均注入 9 条）", () => {
    const noise: string[] = [];
    for (const query of NO_MATCH_QUERIES) {
      const picked = retrieveMemories(query, MEMORIES, { now: NOW });
      const nonPinned = picked.filter((memory) => !memory.pinned);
      // 允许极少数"沾边"的（例如"天气不错"↔"最近降温"），但绝不该塞满
      if (nonPinned.length > 1) {
        noise.push(`「${query}」→ ${nonPinned.length} 条`);
      }
    }
    expect(noise).toEqual([]);
  });

  it("相关提问时也不会把 10 个名额全用光（精度）", () => {
    // 只统计非置顶条目：置顶是"常驻"，每次必进，不属于精度问题
    const total = RECALL_CASES.reduce(
      (sum, testCase) =>
        sum +
        retrieveMemories(testCase.query, MEMORIES, { now: NOW }).filter(
          (memory) => !memory.pinned,
        ).length,
      0,
    );
    // 改造前是 9 句 × 9 条 = 81 条（每句都塞满）；现在 15 条左右
    expect(total).toBeLessThanOrEqual(20);
    // 但也不能矫枉过正到什么都不给
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it("同一件事的两种说法只注入一条（不浪费名额）", () => {
    const picked = retrieveMemories("团团今天怎么样", MEMORIES, { now: NOW });
    const ids = picked.map((memory) => memory.id);

    expect(ids).toContain("m-cat");
    expect(ids).not.toContain("m-cat-dup");
  });

  it("置顶条目永远在（哪怕这句跟它毫无关系）", () => {
    for (const query of [...NO_MATCH_QUERIES, "我下周去杭州"]) {
      const ids = retrieveMemories(query, MEMORIES, { now: NOW }).map((m) => m.id);
      expect(ids).toContain("m-pin");
    }
  });
});
