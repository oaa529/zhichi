/**
 * @file emotion_eval.mts
 * 情绪推断的**固定语料**评估（不联网，结果可复现）。
 *
 * 语料来自 Agnes 真机抽样：给模型一组情绪色彩明确的场景，收集它的回复，
 * 人工标注期望情绪。这样每次改关键词表都能得到可比的分数——
 * 之前直接对着"每次都不一样的模型输出"打分，两次跑出 65% 和 55%，没法比。
 *
 * 用法：node <vite-node> --config vitest.config.ts work/emotion_eval.mts
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";
import { inferEmotion } from "../packages/core/src/EmotionInference";

interface ISample {
  /** 真机回复原文。 */
  readonly text: string;
  /** 人工标注的期望情绪。 */
  readonly expected: CharacterEmotion;
  /** 来源场景，便于回看。 */
  readonly scene: string;
}

const CORPUS: ReadonlyArray<ISample> = [
  { text: "真的！替你开心~好好庆祝一下。", expected: "happy", scene: "好消息" },
  { text: "恭喜！真为你高兴。", expected: "happy", scene: "好消息" },
  { text: "恭喜你呀，真棒。今晚一起吃饭庆祝下？", expected: "happy", scene: "好消息" },
  { text: "抱抱你，它不痛了。", expected: "sad", scene: "坏消息" },
  { text: "嗯…别太难过了，它只是去了另一个地方。想哭就哭出来吧，我在。", expected: "sad", scene: "坏消息" },
  { text: "想哭就哭吧，姐姐在。", expected: "sad", scene: "坏消息" },
  { text: "嗯...它在很远的地方继续跑呢。你也会好好的。", expected: "sad", scene: "坏消息" },
  { text: "对不起...是什么事？我不太记得了", expected: "sad", scene: "抱怨" },
  { text: "啊……抱歉，你之前托我的是什么来着？", expected: "sad", scene: "抱怨" },
  { text: "嗯，抱歉，我这就去办。", expected: "sad", scene: "抱怨" },
  { text: "多少呀？恭喜啦。", expected: "happy", scene: "分享喜悦" },
  { text: "哇！恭喜恭喜！抽中什么了？", expected: "happy", scene: "分享喜悦" },
  { text: "真的吗！什么奖呀", expected: "surprised", scene: "分享喜悦" },
  { text: "怎么会呢……你别乱说。", expected: "shy", scene: "打趣" },
  { text: "想什么呢，别瞎说。", expected: "shy", scene: "打趣" },
  { text: "突然问这个干嘛？", expected: "shy", scene: "打趣" },
  { text: "没有啊…你突然这么问", expected: "shy", scene: "打趣" },
  { text: "没有啦～我只是比较关心你。", expected: "shy", scene: "打趣" },
  { text: "嗯，在想事情呢。你怎么也还没睡？", expected: "sleepy", scene: "深夜" },
  { text: "在呢。睡不着，随便逛逛。你呢？", expected: "sleepy", scene: "深夜" },
  { text: "我还在看书呢。你也早点睡，别熬太晚。", expected: "sleepy", scene: "深夜" },
  { text: "没呢，看会儿书。你也别熬太晚，对身体不好。", expected: "sleepy", scene: "深夜" },
  { text: "可以去爬山或者看个展吧。", expected: "thinking", scene: "商量" },
  { text: "最近有个小众画展挺适合慢慢看的，下午光线好，要不要一起去？", expected: "thinking", scene: "商量" },
  { text: "去湖边野餐吧，天气好，带点吃的很轻松。", expected: "thinking", scene: "商量" },
  { text: "找个安静的地方坐坐，喝喝茶怎么样？", expected: "thinking", scene: "商量" },
  { text: "去公园走走晒晒太阳吧，天气好适合放松～", expected: "thinking", scene: "商量" },
  { text: "没事，杯子而已。你人没划伤吧？", expected: "sad", scene: "道歉" },
  { text: "没关系的，人没伤到就好。碎碎平安，下次小心点啦。", expected: "sad", scene: "道歉" },
  { text: "没事的，杯子而已……你下次小心点就好。", expected: "sad", scene: "道歉" },
  { text: "碎了就碎了吧，你手没伤到吧？", expected: "sad", scene: "道歉" },
  { text: "是你妈吗？还是你朋友？", expected: "surprised", scene: "悬念" },
  { text: "在的。看见谁了？", expected: "surprised", scene: "悬念" },
  { text: "在的 谁呀", expected: "surprised", scene: "悬念" },
  { text: "谁呀？", expected: "surprised", scene: "悬念" },
  { text: "嗯，去休息吧，明天我请你喝奶茶。", expected: "sad", scene: "诉苦" },
  { text: "辛苦了。早点休息，别熬太晚。", expected: "sad", scene: "诉苦" },
  { text: "辛苦啦...早点休息吧，身体要紧", expected: "sad", scene: "诉苦" },
];

let hit = 0;
let nonNeutral = 0;
const misses: string[] = [];

/**
 * 最初那版稀疏词表（只为了在同一语料上给出前后对比，
 * 已从产品代码里替换掉）。
 */
const LEGACY_HINTS: ReadonlyArray<
  readonly [CharacterEmotion, ReadonlyArray<string>]
> = [
  ["surprised", ["啊？", "诶？", "欸？", "真的吗", "居然", "竟然", "没想到", "天哪", "震惊"]],
  ["angry", ["生气", "讨厌", "烦死", "气死", "哼", "别闹", "过分", "不像话"]],
  ["sad", ["难过", "伤心", "哭", "唉", "失落", "委屈", "对不起", "抱歉", "遗憾", "没办法"]],
  ["shy", ["害羞", "脸红", "不好意思", "别说了", "那个…", "讨厌啦", "羞"]],
  ["happy", ["哈哈", "嘿嘿", "嘻嘻", "开心", "高兴", "太好了", "好呀", "好啊", "喜欢", "笑", "棒", "谢谢", "么么"]],
  ["sleepy", ["困", "睡", "晚安", "哈欠", "好累", "撑不住"]],
  ["thinking", ["嗯…", "让我想想", "想想", "大概", "也许", "可能", "好像", "不确定", "怎么办"]],
];

function inferWithLegacyTable(text: string): CharacterEmotion {
  const sample = text.slice(-40);
  let bestPosition = -1;
  let bestEmotion: CharacterEmotion = "neutral";
  for (const [emotion, hints] of LEGACY_HINTS) {
    for (const hint of hints) {
      const position = sample.lastIndexOf(hint);
      if (position > bestPosition) {
        bestPosition = position;
        bestEmotion = emotion;
      }
    }
  }
  return bestEmotion;
}

let legacyHit = 0;
let legacyNonNeutral = 0;

for (const sample of CORPUS) {
  const inferred = inferEmotion(sample.text);
  const legacy = inferWithLegacyTable(sample.text);
  if (inferred === sample.expected) hit += 1;
  if (inferred !== "neutral") nonNeutral += 1;
  if (legacy === sample.expected) legacyHit += 1;
  if (legacy !== "neutral") legacyNonNeutral += 1;
  if (inferred !== sample.expected) {
    misses.push(
      `[${sample.scene}] 期望 ${sample.expected} → 推断 ${inferred}：${sample.text}`,
    );
  }
}

const total = CORPUS.length;
const pct = (n: number): number => Math.round((n / total) * 100);
console.log(`语料 ${total} 条`);
console.log(`当前词表：命中 ${hit}/${total}（${pct(hit)}%），非 neutral ${nonNeutral}/${total}（${pct(nonNeutral)}%）`);
console.log(`最初词表：命中 ${legacyHit}/${total}（${pct(legacyHit)}%），非 neutral ${legacyNonNeutral}/${total}（${pct(legacyNonNeutral)}%）`);
console.log(`\n未命中（${misses.length} 条）：`);
for (const miss of misses) console.log("  - " + miss);
