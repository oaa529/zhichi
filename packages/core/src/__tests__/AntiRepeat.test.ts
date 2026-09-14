/**
 * @file AntiRepeat.test.ts
 * 防复读段：切句、从历史里挑"最近说过的话"、去重与渲染。
 */

import { describe, it, expect } from "vitest";
import {
  ANTI_REPEAT_ITEM_CHARS,
  collectRecentSaid,
  findRepeatedSentences,
  renderAntiRepeatPrompt,
  splitSentences,
} from "../llm/AntiRepeat";
import type { ILLMMessage } from "../llm/types";

/** 造一段历史：user / assistant 交替，assistant 可以是多条（同一轮的气泡）。 */
function history(
  ...rounds: ReadonlyArray<{ user: string; said: ReadonlyArray<string> }>
): ILLMMessage[] {
  const list: ILLMMessage[] = [];
  for (const round of rounds) {
    list.push({ role: "user", content: round.user });
    for (const text of round.said) list.push({ role: "assistant", content: text });
  }
  return list;
}

describe("splitSentences", () => {
  it("按句末标点与换行切，句末标点不带进结果", () => {
    expect(splitSentences("是嘛，我好久没去食堂了。那你周末有空吗？")).toEqual([
      "是嘛，我好久没去食堂了",
      "那你周末有空吗",
    ]);
    expect(splitSentences("第一句！\n第二句~第三句…")).toEqual([
      "第一句",
      "第二句",
      "第三句",
    ]);
  });

  it("逗号不切句（切太碎反而读不懂）", () => {
    expect(splitSentences("先这样，回头再说")).toEqual(["先这样，回头再说"]);
  });

  it("空串与纯标点得到空数组", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("。。。")).toEqual([]);
  });
});

describe("collectRecentSaid", () => {
  it("连续的多条 assistant 消息算同一轮（引擎把回复切成了气泡）", () => {
    // 只看最近一轮：两条气泡都属于这一轮，所以两句都在
    const said = collectRecentSaid(
      history({ user: "今天好累", said: ["我周末可能要加班", "你别太累了"] }),
      { maxTurns: 1 },
    );

    expect(said).toEqual(["我周末可能要加班", "你别太累了"]);
  });

  it("气泡不会拼成连体句（切在逗号后时也不拼）", () => {
    // 引擎可能把回复切成"是嘛，辛苦啦" + "晚上早点休息"，中间没有句末标点
    const said = collectRecentSaid(
      history({ user: "累死了", said: ["是嘛，辛苦啦", "晚上早点休息"] }),
      { maxTurns: 1 },
    );

    expect(said).toEqual(["是嘛，辛苦啦", "晚上早点休息"]);
  });

  it("每轮取开头一句与结尾一句，中间的丢掉", () => {
    const said = collectRecentSaid(
      history({
        user: "今天好累",
        said: ["是嘛，辛苦啦。晚上早点休息，别熬夜。明天还要上班呢"],
      }),
    );

    expect(said).toEqual(["是嘛，辛苦啦", "明天还要上班呢"]);
  });

  it("太短的短语与语音/贴图占位不算说过的话", () => {
    const said = collectRecentSaid(
      history(
        { user: "在吗", said: ["嗯", "在的"] },
        { user: "给你看个东西", said: ["[贴图]", "[语音 3 秒]"] },
        { user: "怎么不说话", said: ["刚在忙别的事呢"] },
      ),
    );

    expect(said).toEqual(["刚在忙别的事呢"]);
  });

  it("只说一遍：跨轮的近似句会去重", () => {
    const said = collectRecentSaid(
      history(
        { user: "先这样吧", said: ["那你早点休息呀"] },
        { user: "好", said: ["那你早点休息呀"] },
      ),
    );

    expect(said).toEqual(["那你早点休息呀"]);
  });

  it("只看最近三轮、最多几句，由旧到新排列", () => {
    const said = collectRecentSaid(
      history(
        { user: "1", said: ["第一轮说过的话在这里"] },
        { user: "2", said: ["第二轮说过的话在这里"] },
        { user: "3", said: ["第三轮说过的话在这里"] },
        { user: "4", said: ["第四轮说过的话在这里"] },
      ),
    );

    // 第一轮已经滑出窗口
    expect(said).toEqual([
      "第二轮说过的话在这里",
      "第三轮说过的话在这里",
      "第四轮说过的话在这里",
    ]);
  });

  it("超长句子会截断（避免把整段回复抄进提示词）", () => {
    const long = "啊".repeat(100);
    const said = collectRecentSaid(history({ user: "嗯", said: [long] }));

    expect(said[0]!.length).toBe(ANTI_REPEAT_ITEM_CHARS + 1);
    expect(said[0]!.endsWith("…")).toBe(true);
  });

  it("还没有角色发言时返回空数组（首轮不该出现这一段）", () => {
    expect(collectRecentSaid([{ role: "user", content: "你好" }])).toEqual([]);
    expect(collectRecentSaid([])).toEqual([]);
  });

  it("选项可调：maxTurns / maxItems / minChars", () => {
    const list = history(
      { user: "1", said: ["第一句完整的话"] },
      { user: "2", said: ["第二句完整的话"] },
    );

    expect(collectRecentSaid(list, { maxTurns: 1 })).toEqual(["第二句完整的话"]);
    expect(collectRecentSaid(list, { maxItems: 1 })).toEqual(["第二句完整的话"]);
    expect(collectRecentSaid(list, { minChars: 99 })).toEqual([]);
    expect(collectRecentSaid(list, { maxTurns: 0 })).toEqual([]);
  });
});

describe("renderAntiRepeatPrompt", () => {
  it("没有内容时返回空串（整段省略，不占 Prompt）", () => {
    expect(renderAntiRepeatPrompt([])).toBe("");
  });

  it("列出句子，并给出替代动作而不是单纯禁令", () => {
    const text = renderAntiRepeatPrompt(["那你早点休息呀", "明天还要上班呢"]);

    expect(text).toContain("【别重复】");
    expect(text).toContain("- 那你早点休息呀");
    expect(text).toContain("- 明天还要上班呢");
    // 只说"别重复"模型会僵住，所以必须给"该做什么"
    expect(text).toContain("接着说新的话");
  });
});

describe("findRepeatedSentences", () => {
  it("指出新回复里哪句是复读（原样、或夹在别的话里）", () => {
    const said = ["那你早点休息呀", "我周末可能要加班"];

    expect(findRepeatedSentences("那你早点休息呀！", said)).toEqual([
      "那你早点休息呀",
    ]);
    // 返回的是**新回复**里的那句（探针据此统计"这轮又说了一遍"）
    expect(findRepeatedSentences("好，那你早点休息呀", said)).toEqual([
      "好，那你早点休息呀",
    ]);
  });

  it("意思不同的话不会被误判", () => {
    const said = ["那你早点休息呀"];

    expect(findRepeatedSentences("我这边刚下过雨", said)).toEqual([]);
  });
});
