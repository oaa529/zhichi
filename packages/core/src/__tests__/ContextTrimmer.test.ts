/**
 * @file ContextTrimmer.test.ts
 * ContextTrimmer 单元测试：截断/摘要/边界。
 */

import { describe, it, expect } from "vitest";
import { trimContext, estimateTokens, estimateMessagesTokens } from "../llm/ContextTrimmer";
import type { ILLMMessage } from "../llm/types";

function makeMessages(count: number, charCount: number = 50): ILLMMessage[] {
  const msgs: ILLMMessage[] = [{ role: "system", content: "你是角色" }];
  for (let i = 0; i < count; i += 1) {
    const text = `这是第${i}条消息` + "测".repeat(Math.max(0, charCount - 10));
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: text,
    });
  }
  return msgs;
}

describe("ContextTrimmer", () => {
  it("estimateTokens: 中文 1 char ≈ 1.3 token（向上取整）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(2); // ceil(1 * 1.3) = 2
    expect(estimateTokens("ab")).toBe(3); // ceil(2 * 1.3) = 3
    expect(estimateTokens("你好")).toBe(3); // ceil(2 * 1.3) = 3
    expect(estimateTokens("你好世界")).toBe(6); // ceil(4 * 1.3) = 6
  });

  it("estimateMessagesTokens: 每条消息额外 +4 token", () => {
    const msgs: ILLMMessage[] = [
      { role: "system", content: "ab" },
      { role: "user", content: "cd" },
    ];
    // (2*1.3 + 4) + (2*1.3 + 4) = ceil(2.6)+4 + ceil(2.6)+4 = 3+4+3+4 = 14
    expect(estimateMessagesTokens(msgs)).toBe(14);
  });

  it("trimContext: 总 chars ≤ softLimit 时不截断", () => {
    const msgs = makeMessages(3, 50);
    const result = trimContext(msgs);

    expect(result.trimmed).toBe(false);
    expect(result.removedChars).toBe(0);
    expect(result.summarized).toBe(false);
    expect(result.messages).toBe(msgs);
  });

  it("trimContext: 超过 softLimit 时截断旧消息", () => {
    const msgs = makeMessages(40, 200); // ~8000 chars, 超过 4000
    const result = trimContext(msgs);

    expect(result.trimmed).toBe(true);
    expect(result.removedChars).toBeGreaterThan(0);
    // 保留最近 8 轮 = 16 条对话 + 1 system = 17
    expect(result.messages.length).toBeLessThanOrEqual(msgs.length);
    // system 消息保留
    expect(result.messages[0]!.role).toBe("system");
  });

  it("trimContext: 末尾的动态注入保持贴近当前提问，不被提到最前面", () => {
    // 结构：[人设 system][历史…][动态 system][当前 user]
    const msgs: ILLMMessage[] = [{ role: "system", content: "你是角色" }];
    for (let i = 0; i < 40; i += 1) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `历史第${i}条` + "测".repeat(190),
      });
    }
    msgs.push({ role: "system", content: "【你记得的事】用户对花生过敏" });
    msgs.push({ role: "user", content: "今天吃什么" });

    const result = trimContext(msgs);
    expect(result.trimmed).toBe(true);

    const roles = result.messages.map((m) => m.role);
    // 开头仍是人设
    expect(result.messages[0]!.content).toBe("你是角色");
    // 动态注入仍在倒数第二（当前提问之前）
    expect(roles[roles.length - 1]).toBe("user");
    expect(roles[roles.length - 2]).toBe("system");
    expect(result.messages[result.messages.length - 2]!.content).toContain(
      "用户对花生过敏",
    );
    // 且它确实排在最近对话之后，而不是被提到最前
    const dynamicIdx = result.messages.findIndex((m) =>
      m.content.includes("用户对花生过敏"),
    );
    expect(dynamicIdx).toBeGreaterThan(1);
  });

  it("trimContext: 保留最近 keepRounds*2 条对话", () => {
    const msgs = makeMessages(40, 200);
    const result = trimContext(msgs, { keepRounds: 4 });

    expect(result.trimmed).toBe(true);
    // system + 4*2 = 9 条
    const dialogCount = result.messages.filter((m) => m.role !== "system").length;
    expect(dialogCount).toBeLessThanOrEqual(8);
  });

  it("trimContext: 截断后超 hardLimit 触发摘要", () => {
    const msgs = makeMessages(100, 300); // 大量消息
    const result = trimContext(msgs, {
      softLimitChars: 1000,
      hardLimitChars: 2000,
    });

    expect(result.trimmed).toBe(true);
    expect(result.summarized).toBe(true);

    // 应包含摘要 system 消息
    const summaryMsgs = result.messages.filter(
      (m) => m.role === "system" && m.content.startsWith("【前情提要】"),
    );
    expect(summaryMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("trimContext: 摘要消息包含前情提要前缀", () => {
    const msgs = makeMessages(100, 300);
    const result = trimContext(msgs, {
      softLimitChars: 500,
      hardLimitChars: 1000,
    });

    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("【前情提要】");
    // 兜底摘要：较早的关键信息 + 最近几条，每条留长一点，整体仍然要短
    expect(summary!.content.length).toBeLessThanOrEqual(360);
    // 兜底摘要会写清"更早的 N 条已省略"，而不是把二十条各切一段拼成碎片
    expect(summary!.content).toContain("已省略");
  });

  it("trimContext: 被砍中段里**带具体信息**的一句会被留下（长对话最容易忘的就是它）", () => {
    // 120 条闲聊里夹一句"下周三下午三点去医院复查"，位置远在保留窗口之外
    const msgs = makeMessages(120, 45);
    msgs[40] = {
      role: "user",
      content: "我下周三下午三点要去医院复查，医生说最好别迟到，你那天有空吗",
    };

    const result = trimContext(msgs, { keepRounds: 8 });
    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );

    expect(summary).toBeDefined();
    // 改前这里只有"最近几条"，那句具体信息彻底消失
    expect(summary!.content).toContain("下周三下午三点");
    // 关键信息排在"最近"分组之前，万一整体被截也先保住它
    expect(summary!.content.indexOf("下周三下午三点")).toBeLessThan(
      summary!.content.indexOf("最近："),
    );
  });

  it("trimContext: 中段全是闲聊时不多出「较早」分组", () => {
    // 纯闲聊：不带数字、日期、地点与约定，攒够长度触发裁剪
    const msgs = Array.from({ length: 160 }, (_, i): ILLMMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        i % 2 === 0
          ? "今天过得还行吧，就是有点困，可能是最近睡得比较晚，人也懒懒的"
          : "嗯，你也是啊，我这两天也差不多，回头我们都早点休息吧，别硬撑着",
    }));

    const result = trimContext(msgs, { keepRounds: 8 });
    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );

    expect(summary).toBeDefined();
    expect(summary!.content).not.toContain("较早：");
    expect(summary!.content).toContain("最近：");
  });

  it("trimContext: 摘要超长时按整条取舍，不会把某一句切成半句", () => {
    // 每条 300 字：光"较早"两句就顶满预算，后面的整组都得让路
    const msgs = makeMessages(60, 300);
    msgs[10] = { role: "user", content: `下周三下午三点去医院复查，${"啊".repeat(280)}` };
    msgs[11] = { role: "assistant", content: `那记得带上报告单，${"哦".repeat(280)}` };

    const result = trimContext(msgs, { keepRounds: 4 });
    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );

    expect(summary).toBeDefined();
    const text = summary!.content;
    expect(text.length).toBeLessThanOrEqual(360);
    // 每条渲染后最长 60 字；被切断的话会出现"没有分隔符收尾的半句"
    for (const line of text.split(/[；｜]/)) {
      // 把可能叠在一起的标签（省略提示 / 分组 / 角色）逐个剥掉
      let body = line;
      const labelPattern = /^(【前情提要】|（[^）]*）|(较早|最近|用户|角色)：)/;
      while (labelPattern.test(body)) {
        body = body.replace(labelPattern, "");
      }
      body = body.replace(/…$/, "");
      expect(body.length).toBeLessThanOrEqual(60);
    }
    // 放不下的部分要有省略号，而不是悄悄消失
    expect(text.endsWith("…")).toBe(true);
  });

  it("trimContext: 兜底摘要带的是**切口附近**那几条，并写清省略了多少条", () => {
    // 120 条 × 40 字 ≈ 4800 字，刚刚越过 softLimit（4000）触发裁剪
    const msgs = makeMessages(120, 40);
    const result = trimContext(msgs, { keepRounds: 8 });

    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );
    expect(summary).toBeDefined();
    // 被裁掉的就是保留窗口（最近 16 条）之外的全部
    expect(summary!.content).toMatch(/已省略/);
    // 带的是紧邻保留窗口的那几条，而不是最早的那几条
    const cutTail = msgs[msgs.length - 16 - 1]!.content.slice(0, 10);
    expect(summary!.content).toContain(cutTail);
  });

  it("trimContext: 微信式的短消息长对话也要补前情提要（旧行为这里什么都没有）", () => {
    // 每条 40 字上下、攒到 120 条：总量早就超过 softLimit，但保留窗口很小，
    // 于是旧代码"截断后仍超 hardLimit"的条件永远不成立——旧消息被静默丢掉
    const msgs = makeMessages(120, 40);
    const result = trimContext(msgs);

    expect(result.trimmed).toBe(true);
    expect(result.summarized).toBe(true);
    const summary = result.messages.find((m) =>
      m.content.startsWith("【前情提要】"),
    );
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("已省略");
  });

  it("trimContext: 硬上限真的会继续砍保留窗口（不会撑爆模型窗口）", () => {
    // 保留窗口自己有 16 条 × 600 字 ≈ 9600 字，远超 2000 的硬上限
    const msgs = makeMessages(40, 600);
    const result = trimContext(msgs, {
      softLimitChars: 1000,
      hardLimitChars: 2000,
    });

    const dialogMsgs = result.messages.filter((m) => m.role !== "system");
    const dialogChars = dialogMsgs.reduce((sum, m) => sum + m.content.length, 0);
    // 砍到硬上限以内（允许前缀 system 与人设本身占一部分）
    expect(dialogChars).toBeLessThanOrEqual(2000);
    // 至少留一轮，不能把对话砍空
    expect(dialogMsgs.length).toBeGreaterThanOrEqual(2);
    // 砍掉的部分有替代品
    expect(result.summarized).toBe(true);
  });

  it("trimContext: 无 system 消息时也能正常截断", () => {
    const msgs: ILLMMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "测".repeat(200),
      });
    }

    const result = trimContext(msgs);

    expect(result.trimmed).toBe(true);
    expect(result.messages.length).toBeLessThan(msgs.length);
  });

  it("trimContext: keepRounds 大于实际对话轮数时保留全部", () => {
    const msgs = makeMessages(5, 1000); // ~5000 chars, 超过 softLimit 4000
    const result = trimContext(msgs, { keepRounds: 100 });

    expect(result.trimmed).toBe(true);
    // 全部保留（因为 keepRounds*2 > dialogMsgs.length）
    const dialogCount = result.messages.filter((m) => m.role !== "system").length;
    expect(dialogCount).toBe(5);
  });

  it("trimContext: 空消息列表不报错", () => {
    const result = trimContext([]);

    expect(result.trimmed).toBe(false);
    expect(result.messages).toEqual([]);
  });

  it("trimContext: 自定义参数生效", () => {
    const msgs = makeMessages(20, 100); // ~2000 chars
    const result1 = trimContext(msgs, { softLimitChars: 100 });
    const result2 = trimContext(msgs, { softLimitChars: 5000 });

    expect(result1.trimmed).toBe(true);
    expect(result2.trimmed).toBe(false);
  });
});
