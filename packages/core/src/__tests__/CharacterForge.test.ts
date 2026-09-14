/**
 * @file CharacterForge.test.ts
 * 角色卡 AI 生成：指令构造与结果解析的容错。
 */

import { describe, it, expect } from "vitest";
import {
  buildCharacterGenPrompt,
  extractDraftName,
  formatDraftAsPromptText,
  parseCharacterGenResult,
} from "../character/CharacterForge";

const VALID = {
  name: "叶知秋",
  bio: "寡言的古籍修复师",
  archetype: "reserved",
  background:
    "二十九岁，在老城区经营一间古籍修复工作室。手上总有胶水的味道，袖口常年卷到手肘。三年前搬来时只带了两箱工具和一箱旧书。",
  personality: "话少，但答应用户的事一定做到；对旧物有近乎偏执的耐心。",
  speechStyle: "短句为主，常用「嗯」「好」应答，很少用感叹号。",
  worldSetting: "现代都市的老城区，梅雨季潮湿。",
  greeting: "……你要修的是这本书？先坐吧，我看看。",
  examples:
    "用户：这本还能修好吗\n叶知秋：能。慢一点而已。\n用户：要多久\n叶知秋：三个月，或者更久。",
};

describe("buildCharacterGenPrompt", () => {
  it("把用户想法与称呼写进 user 指令", () => {
    const prompt = buildCharacterGenPrompt("  高中同桌，傲娇但细心  ", "阿风");
    expect(prompt.user).toContain("角色想法：高中同桌，傲娇但细心");
    expect(prompt.user).toContain("用户希望被称呼为：阿风");
  });

  it("system 明确要求只输出 JSON，并列出可选的性格原型", () => {
    const { system } = buildCharacterGenPrompt("随便");
    expect(system).toContain("只输出一个 JSON 对象");
    expect(system).toContain("night-owl");
    expect(system).toContain("examples");
  });
});

describe("parseCharacterGenResult", () => {
  it("解析标准 JSON 输出", () => {
    const draft = parseCharacterGenResult(JSON.stringify(VALID));
    expect(draft).not.toBeNull();
    expect(draft!.displayName).toBe("叶知秋");
    expect(draft!.archetype).toBe("reserved");
    expect(draft!.greeting).toContain("你要修的是这本书");
    expect(draft!.examples).toContain("三个月，或者更久");
  });

  it("容忍 markdown 围栏与前后废话", () => {
    const wrapped = `好的，这是角色卡：\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n希望满意。`;
    const draft = parseCharacterGenResult(wrapped);
    expect(draft?.displayName).toBe("叶知秋");
  });

  it("坏 JSON 或空输入返回 null", () => {
    expect(parseCharacterGenResult("{不是 JSON}")).toBeNull();
    expect(parseCharacterGenResult("")).toBeNull();
    expect(parseCharacterGenResult(null)).toBeNull();
    expect(parseCharacterGenResult(undefined)).toBeNull();
  });

  it("连续两层花括号也能截取出正确的 JSON", () => {
    const raw = `说明文字 {"name":"小满","personality":"爱笑","extra":{}} 结尾`;
    const draft = parseCharacterGenResult(raw);
    expect(draft?.displayName).toBe("小满");
  });

  it("archetype 不在白名单时退回 gentle", () => {
    const draft = parseCharacterGenResult(
      JSON.stringify({ ...VALID, archetype: "傲娇" }),
    );
    expect(draft!.archetype).toBe("gentle");
  });

  it("缺 bio 时从 background 抽一句话补上", () => {
    const draft = parseCharacterGenResult(
      JSON.stringify({ ...VALID, bio: "" }),
    );
    expect(draft!.bio).toBe("二十九岁");
  });

  it("超长字段被截断（不让模型把上下文写爆）", () => {
    const draft = parseCharacterGenResult(
      JSON.stringify({ ...VALID, background: "字".repeat(2000) }),
    );
    expect(draft!.background.length).toBe(600);
    expect(draft!.background.endsWith("…")).toBe(true);
  });

  it("名字与内容都缺失时返回 null（这次生成等于白跑）", () => {
    expect(parseCharacterGenResult(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("只有名字没有内容时也判失败", () => {
    expect(parseCharacterGenResult(JSON.stringify({ name: "无名" }))).toBeNull();
  });
});

describe("extractDraftName（生成过程中的进度提示用）", () => {
  it("从写了一半的 JSON 里抠出角色名", () => {
    expect(extractDraftName('{"name":"林夏知","bio":"高')).toBe("林夏知");
  });

  it("名字还没写完（引号未闭合）时不显示，避免名字闪烁", () => {
    expect(extractDraftName('{"name":"林夏')).toBeNull();
    expect(extractDraftName('{"na')).toBeNull();
    expect(extractDraftName("")).toBeNull();
  });

  it("还没有 name 字段时返回 null", () => {
    expect(extractDraftName('{"spec":"chara_card_v2"')).toBeNull();
  });

  it("带反斜杠转义的名字不会被误读", () => {
    // 模型偶尔会写 \" 之类的转义，遇到就跳过这一处，不硬猜
    expect(extractDraftName('{"name":"林\\"夏')).toBeNull();
  });
});

describe("formatDraftAsPromptText", () => {
  it("把草稿拼成分段文本，示例对话带防照抄提示", () => {
    const draft = parseCharacterGenResult(JSON.stringify(VALID))!;
    const text = formatDraftAsPromptText(draft);

    expect(text).toContain("【身份背景】");
    expect(text).toContain("【性格】");
    expect(text).toContain("【说话风格】");
    expect(text).toContain("【世界观】");
    expect(text).toContain("【示例对话】");
    expect(text).toContain("不要照抄");
  });

  it("空字段不产生空标题", () => {
    const text = formatDraftAsPromptText({
      displayName: "小满",
      bio: "",
      archetype: "gentle",
      background: "背景",
      personality: "",
      speechStyle: "",
      worldSetting: "",
      greeting: "",
      examples: "",
    });
    expect(text).toBe("【身份背景】背景");
  });
});
