/**
 * @file memory_retrieval_quality.mts
 * 记忆检索质量的可量化检查（**纯函数，不调用任何 API**）。
 *
 * 关注两件事：
 * 1. 该进来的有没有进来（召回）；
 * 2. 不该进来的有没有挤进来（噪声）——尤其是"一句无关寒暄"
 *    也会按重要度/新鲜度塞满预算的情况。
 *
 * 用法：node <vite-node> --config vitest.config.ts work/memory_retrieval_quality.mts
 */

import type { IMemory } from "@wechat-rp/shared-types";
import { retrieveMemories } from "../packages/core/src/memory/MemoryRetriever";

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

/** 40 条记忆：一半是真正有用的，一半是日常琐事（用来检验区分度）。 */
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
  // 下面这些是"日常琐事"：关键词都很泛，用来检验泛词会不会抢走预算
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
  // 近似重复：与 m-cat 是同一件事的另一种说法
  memory("m-cat-dup", "用户养了一只猫，名字叫团团", ["猫", "名字"], 2, 10),
  memory("m-gu", "用户的工作内容主要是产品设计", ["工作", "产品"], 3, 3),
  memory("m-hz2", "杭州那边的项目需要用户去对接", ["杭州", "项目"], 3, 2),
  memory("m-old-coffee", "用户以前很喜欢喝拿铁", ["咖啡", "拿铁"], 1, 20),
  memory("m-gift", "用户给母亲买过一盆兰花", ["母亲", "兰花"], 2, 15),
  memory("m-pin", "用户对花生过敏（置顶要永远记住）", ["花生", "过敏"], 5, 30, true),
];

interface ICase {
  readonly query: string;
  /** 期望被检索到的记忆 id（命中任意一个即算召回成功）。 */
  readonly expect: ReadonlyArray<string>;
  /** 是否允许注入"意料之外"的其他记忆（用于观察噪声）。 */
  readonly noiseAllowed?: number;
}

const CASES: ReadonlyArray<ICase> = [
  { query: "团团今天怎么样？还在吃药吗", expect: ["m-cat", "m-cat-dup"], noiseAllowed: 2 },
  { query: "我下周去杭州出差，那边天气如何", expect: ["m-hz", "m-hz2"], noiseAllowed: 3 },
  { query: "我妈生日送什么好", expect: ["m-mom"], noiseAllowed: 3 },
  { query: "我到底能不能喝咖啡", expect: ["m-coffee", "m-old-coffee"], noiseAllowed: 3 },
  { query: "晚上点外卖要不要放香菜", expect: ["m-coriander"], noiseAllowed: 3 },
  { query: "周六那个展你还去吗", expect: ["m-exhibit"], noiseAllowed: 3 },
  { query: "我搬家你能来帮忙吗", expect: ["m-move"], noiseAllowed: 3 },
  { query: "我出差要带的那份文件放哪了", expect: ["m-contract"], noiseAllowed: 3 },
  { query: "工作最近怎么样", expect: ["m-job", "m-gu", "m-busy"], noiseAllowed: 4 },
  // 下面三句跟任何记忆都无关：理想情况是只注入置顶那条（甚至一条都不注入）
  { query: "今天天气不错啊", expect: [], noiseAllowed: 1 },
  { query: "在吗", expect: [], noiseAllowed: 1 },
  { query: "我刚睡醒，脑子还有点糊", expect: [], noiseAllowed: 1 },
];

function run(): void {
  let recallHit = 0;
  let recallTotal = 0;
  let noiseTotal = 0;
  let noiseBudget = 0;
  let unrelatedTotal = 0;

  for (const testCase of CASES) {
    const picked = retrieveMemories(testCase.query, MEMORIES, { now: NOW });
    const ids = picked.map((memory) => memory.id);
    const irrelevant = picked.filter((memory) => !memory.pinned).length;

    if (testCase.expect.length > 0) {
      recallTotal += 1;
      const hit = testCase.expect.some((id) => ids.includes(id));
      if (hit) recallHit += 1;
      unrelatedTotal += irrelevant;
      console.log(
        `${hit ? "✅" : "❌"} 「${testCase.query}」 → ${ids.join(", ") || "（空）"}`,
      );
    } else {
      noiseTotal += irrelevant;
      noiseBudget += testCase.noiseAllowed ?? 1;
      console.log(
        `🌫 「${testCase.query}」 → 注入 ${irrelevant} 条非置顶：${ids.join(", ") || "（空）"}`,
      );
    }
  }

  console.log("\n===== 汇总 =====");
  console.log(`召回：${recallHit}/${recallTotal}`);
  console.log(`无关提问时注入的非置顶记忆：${noiseTotal} 条（期望 ≤ ${noiseBudget}）`);
  console.log(`有关提问时总共注入 ${unrelatedTotal} 条（含相关的那些）`);
}

run();
