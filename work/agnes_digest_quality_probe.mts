/**
 * @file agnes_digest_quality_probe.mts
 * 真机验证：**记忆提炼的质量**——漏抽 / 串味 / 重复 / 噪声各占多少。
 *
 * 上一轮在合成语料上看到一个可疑现象：相邻但无关的两句被并成了一条记忆
 * （"用户下个月要带母亲去杭州出差三天"）。这一轮把它做成可量化的检查：
 *
 * 每一段语料都**预先写好了标准答案**（该抽出什么、什么不该抽），
 * 跑完真机整理后逐项打分：
 * - 召回：清单里的信息被抽出来的比例
 * - 噪声：抽到寒暄/临时内容（食堂、键盘、天气）的条数
 * - 重复：两条记忆互相高度相似
 * - 串味：一条记忆同时命中**两组互不相关的**关键词（疑似把两件事并成一件）
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_digest_quality_probe.mts
 *   $env:PROMPT_VARIANT=new  # 用改造后的提示词跑（默认 old）
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import { createOpenAIAdapter } from "../packages/core/src/llm/OpenAIAdapter";
import { runDigest } from "../packages/core/src/memory/MemoryDigest";
import { bigramSimilarity } from "../packages/core/src/memory/MemoryRetriever";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

/** 最近一次请求的原始输出（解析失败时要看它到底回了什么）。 */
let lastRawOutput = "";

/**
 * 包一层适配器：把原始输出抄一份下来。
 *
 * 解析失败时只看 "解析失败" 三个字没法定位——是模型回了散文、
 * 还是 JSON 被截断、还是字段结构不对，必须看原文。
 */
function withCapture(inner: ReturnType<typeof createOpenAIAdapter>) {
  return {
    ...inner,
    stream: (req: Parameters<typeof inner.stream>[0], handlers: Parameters<typeof inner.stream>[1], signal: AbortSignal) =>
      inner.stream(
        req,
        {
          ...handlers,
          onComplete: (fullText: string) => {
            lastRawOutput = fullText;
            handlers.onComplete(fullText);
          },
        },
        signal,
      ),
    testConnection: () => inner.testConnection(),
  };
}

/** 一条"标准答案"：这一组关键词命中即算抽到。 */
interface IExpected {
  readonly label: string;
  readonly any: ReadonlyArray<string>;
}

interface ICorpus {
  readonly name: string;
  readonly history: ReadonlyArray<ILLMMessage>;
  readonly expected: ReadonlyArray<IExpected>;
  /** 不该被抽成长期记忆的噪声词。 */
  readonly noise: ReadonlyArray<string>;
}

/** 语料 A：日常闲聊里夹着该记住的事，还有一堆噪声。 */
const CORPUS_A: ICorpus = {
  name: "A 日常（事实/偏好/状态变化）",
  expected: [
    { label: "下周去杭州出差", any: ["杭州"] },
    { label: "妈妈生日在下个月、喜欢养花", any: ["生日", "花"] },
    { label: "猫叫团团、最近肠胃不好在吃药", any: ["团团"] },
    { label: "戒咖啡改喝白茶", any: ["白茶", "戒"] },
    { label: "换了工作（去了互联网公司）", any: ["跳槽", "换工作", "互联网", "新公司"] },
    { label: "不吃香菜", any: ["香菜"] },
  ],
  noise: ["食堂", "键盘", "天气", "地铁"],
  history: [
    { role: "user", content: "今天食堂的糖醋排骨居然卖完了" },
    { role: "assistant", content: "那明天早点去" },
    { role: "user", content: "我新买的键盘敲起来好吵，室友都抗议了" },
    { role: "assistant", content: "换静音轴吧" },
    { role: "user", content: "下周三我要去杭州出差，三天" },
    { role: "assistant", content: "杭州最近降温，记得带外套" },
    { role: "user", content: "嗯。对了，我下个月要给我妈过生日" },
    { role: "assistant", content: "阿姨喜欢什么呀" },
    { role: "user", content: "她喜欢养花，阳台上摆了一排蝴蝶兰" },
    { role: "assistant", content: "那送花挺合适的" },
    { role: "user", content: "今天地铁上遇到个特别好笑的事" },
    { role: "assistant", content: "说来听听" },
    { role: "user", content: "算了不重要。团团这两天不太对劲" },
    { role: "assistant", content: "团团怎么了" },
    { role: "user", content: "吐了两回，带去看了，说是肠胃炎，在吃药" },
    { role: "assistant", content: "那猫粮先换成好消化的" },
    { role: "user", content: "嗯。跟你说个事，我把咖啡戒了" },
    { role: "assistant", content: "诶？怎么突然戒了" },
    { role: "user", content: "胃不好，医生让少喝，现在改喝白茶了，越喝越喜欢" },
    { role: "assistant", content: "白茶养胃，挺好" },
    { role: "user", content: "外面好像下雨了" },
    { role: "assistant", content: "记得带伞" },
    { role: "user", content: "还有一个大事，我跳槽了，下周一去新公司报到" },
    { role: "assistant", content: "恭喜！什么方向" },
    { role: "user", content: "互联网公司做产品，比设计院累但更有意思" },
    { role: "assistant", content: "那要好好吃饭" },
    { role: "user", content: "晚上吃面，老板又给我放了一把香菜，我只能挑出来" },
    { role: "assistant", content: "你是一点香菜都吃不了吗" },
    { role: "user", content: "对，从小就不吃，闻着都难受" },
    { role: "assistant", content: "记住了，以后点餐都给你说不要香菜" },
  ],
};

/** 语料 B：剧情推进（约定 / 冲突 / 道歉 / 关系变化 / 搬家）。 */
const CORPUS_B: ICorpus = {
  name: "B 剧情（约定/冲突/关系）",
  expected: [
    { label: "约好周六去看展", any: ["展"] },
    { label: "角色加班失约", any: ["加班", "失约", "没去", "迟到"] },
    { label: "用户生气", any: ["生气", "不满", "失望"] },
    { label: "角色道歉并送礼物", any: ["道歉", "对不起", "礼物", "送"] },
    { label: "约定下不为例", any: ["下不为例", "承诺", "保证"] },
    { label: "用户下周搬家", any: ["搬家", "搬到", "搬"] },
  ],
  /**
   * 注意：这里一度把"咖啡"也列成噪声，属于清单写错——
   * 语料里那句是**纠正**（用户不喝咖啡），是该记的信息。
   * 评估清单本身也要审，否则会冤枉模型。
   */
  noise: ["地铁", "外卖"],
  history: [
    { role: "user", content: "周六那个摄影展你还去吗" },
    { role: "assistant", content: "去呀，我早就想看那个了" },
    { role: "user", content: "那我们十点在门口见？" },
    { role: "assistant", content: "好，十点见" },
    { role: "user", content: "你到了吗？我在门口站了二十分钟了" },
    { role: "assistant", content: "……对不起，我临时被叫去加班了" },
    { role: "user", content: "所以你就不来了？票是我提前买的" },
    { role: "assistant", content: "我知道是我不好，我这边真的走不开" },
    { role: "user", content: "算了，我一个人看完了" },
    { role: "assistant", content: "对不起" },
    { role: "user", content: "我不是气你没来，我是气你连消息都不说一声" },
    { role: "assistant", content: "是我错了，下次一定提前告诉你" },
    { role: "user", content: "你上次也这么说" },
    { role: "assistant", content: "这次真的记住了，我周末把礼物给你送过去赔罪" },
    { role: "user", content: "什么礼物" },
    { role: "assistant", content: "你上次说想买的那本摄影集，我找到了" },
    { role: "user", content: "……好吧，这次原谅你，下不为例" },
    { role: "assistant", content: "好，下不为例" },
    { role: "user", content: "对了，我下周要搬家，搬到我姐家附近" },
    { role: "assistant", content: "那挺近的，需要帮忙吗" },
    { role: "user", content: "需要，主要是书太多了" },
    { role: "assistant", content: "搬完我请你喝咖啡，庆祝一下" },
    { role: "user", content: "我不喝咖啡，你忘了" },
    { role: "assistant", content: "哦对，那喝别的" },
  ],
};

/** 一条记忆是否命中某组关键词。 */
function matches(content: string, group: IExpected): boolean {
  return group.any.some((keyword) => content.includes(keyword));
}

function evaluate(
  corpus: ICorpus,
  memories: ReadonlyArray<{ content: string; kind: string }>,
  events: ReadonlyArray<{ summary: string }> = [],
): void {
  const contents = memories.map((memory) => memory.content);
  // 约定/冲突/关系变化按设计会进 events（时间线），评估要把两者合起来看
  const allTexts = [...contents, ...events.map((event) => event.summary)];
  const hit = corpus.expected.filter((group) =>
    allTexts.some((text) => matches(text, group)),
  );
  const missed = corpus.expected.filter((group) => !hit.includes(group));

  const noiseHits = contents.filter((content) =>
    corpus.noise.some((word) => content.includes(word)),
  );

  const duplicates: string[] = [];
  for (let i = 0; i < contents.length; i += 1) {
    for (let j = i + 1; j < contents.length; j += 1) {
      if (bigramSimilarity(contents[i]!, contents[j]!) >= 0.7) {
        duplicates.push(`${contents[i]} ≈ ${contents[j]}`);
      }
    }
  }

  // 串味：一条记忆同时命中两组互不相关的清单项
  const conflated = contents.filter((content) => {
    const matchedGroups = corpus.expected.filter((group) => matches(content, group));
    return matchedGroups.length >= 2;
  });

  console.log(`  召回 ${hit.length}/${corpus.expected.length}`);
  if (missed.length > 0) {
    console.log(`  ❌ 漏抽：${missed.map((group) => group.label).join("、")}`);
  }
  // 命中的那几项落在哪条通道（记忆 vs 事件），便于判断分工是否合理
  const inEvents = corpus.expected
    .filter((group) =>
      events.some((event) => matches(event.summary, group)),
    )
    .map((group) => group.label);
  if (inEvents.length > 0) {
    console.log(`  ℹ️ 由事件时间线承担：${inEvents.join("、")}`);
  }
  if (noiseHits.length > 0) {
    console.log(`  ⚠️ 噪声：${noiseHits.join("；")}`);
  }
  if (duplicates.length > 0) {
    console.log(`  ⚠️ 重复：${duplicates.join("；")}`);
  }
  if (conflated.length > 0) {
    console.log(`  ⚠️ 串味（一条里混了两件事）：${conflated.join("；")}`);
  }

  for (const memory of memories) {
    console.log(`    [${memory.kind}] ${memory.content}`);
  }
  for (const event of events) {
    console.log(`    〔事件〕${event.summary}`);
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  // 已知记忆：用来检验"状态变化要取代旧记忆"
  const known = [
    "用户喜欢喝咖啡",
    "用户在设计院工作",
    "用户养了一只猫",
  ];

  const adapter = createOpenAIAdapter({
    config: {
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 120_000,
      maxRetries: 1,
      temperature: 0.8,
      maxTokens: 1500,
    },
  });
  const capturing = withCapture(adapter);

  const only = (process.env.PROBE_ONLY ?? "").trim();
  const corpora = [CORPUS_A, CORPUS_B].filter(
    (corpus) => !only || corpus.name.startsWith(only),
  );

  for (const corpus of corpora) {
    console.log(`\n===== ${corpus.name} =====`);
    const started = Date.now();
    lastRawOutput = "";
    const digest = await runDigest({
      adapter: capturing,
      history: corpus.history,
      characterName: "苏晚晴",
      characterId: "char-su-wanqing",
      existingMemories: known,
      model: MODEL,
      timeoutMs: 120_000,
      signal: new AbortController().signal,
    });
    console.log(`  （${Math.round((Date.now() - started) / 1000)}s）`);
    // 原始输出长度与结尾：判断有没有被 maxTokens 截断（结尾不是 } 就要怀疑）
    console.log(
      `  原始输出 ${lastRawOutput.length} 字，结尾：${JSON.stringify(lastRawOutput.trim().slice(-24))}`,
    );

    if (!digest) {
      console.error("  ❌ 解析失败");
      console.error(`  原始输出（前 600 字）：${lastRawOutput.slice(0, 600)}`);
      continue;
    }
    evaluate(corpus, digest.memories, digest.events);
    const superseded = digest.memories.filter((m) => m.supersedes);
    console.log(
      `  取代旧记忆：${superseded.length > 0 ? superseded.map((m) => `${m.supersedes} → ${m.content}`).join("；") : "无"}`,
    );
  }
}

await main();
