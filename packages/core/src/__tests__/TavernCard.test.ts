/**
 * @file TavernCard.test.ts
 * 社区角色卡（SillyTavern V1/V2，JSON 与 PNG 内嵌）的解析与映射。
 */

import { describe, it, expect } from "vitest";
import {
  convertMessageExamples,
  extractPngTextChunk,
  parseTavernCard,
  substituteCardPlaceholders,
  tavernCardToCharacterCard,
} from "../characterCard/TavernCard";

/** 把 UTF-8 文本编码成 base64（PNG 文本块里就是这么存的）。 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/** 构造一张只含签名 + IHDR + tEXt + IEND 的最小 PNG。 */
function buildPngWithText(keyword: string, text: string): Uint8Array {
  const out: number[] = [];
  const pushUint32 = (value: number): void => {
    out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  };
  const pushBytes = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i] ?? 0);
  };
  const encoder = new TextEncoder();

  // PNG 签名
  out.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

  // IHDR（内容对提取逻辑无意义，长度与结构要对）
  pushUint32(13);
  pushBytes(encoder.encode("IHDR"));
  pushBytes(new Uint8Array(13));
  pushUint32(0);

  // tEXt：keyword \0 text
  const keyBytes = encoder.encode(keyword);
  const textBytes = encoder.encode(text);
  const data = new Uint8Array(keyBytes.length + 1 + textBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0;
  data.set(textBytes, keyBytes.length + 1);
  pushUint32(data.length);
  pushBytes(encoder.encode("tEXt"));
  pushBytes(data);
  pushUint32(0);

  // IEND
  pushUint32(0);
  pushBytes(encoder.encode("IEND"));
  pushUint32(0);

  return new Uint8Array(out);
}

const V1_CARD = {
  name: "叶知秋",
  description: "{{char}}是一名古籍修复师，常穿深色衬衫。",
  personality: "寡言、耐心，对旧物有执念。",
  scenario: "{{user}}带着一本破损的家谱走进{{char}}的工作室。",
  first_mes: "……这本家谱，你从哪儿找到的？",
  mes_example:
    "<START>\n{{user}}: 这本书能修好吗\n{{char}}: 能。但要等。\n<START>\n{{user}}: 要多久\n{{char}}: 三个月，或者更久。",
};

const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "林见夏",
    description: "海边小镇的唱片店老板。",
    personality: "懒散但敏锐。",
    scenario: "台风天的傍晚，店里只有你们两个客人。",
    first_mes: "外面雨太大了，先坐会儿吧。",
    mes_example: "<START>\n{{user}}: 这张唱片是谁的\n{{char}}: 一个再也没回来的人。",
    creator_notes: "作者备注：慢热向。",
    system_prompt: "始终使用第一人称。",
    post_history_instructions: "不要替用户做决定。",
    alternate_greetings: ["要不要听点别的？"],
    tags: ["slow-burn", "city"],
    creator: "someone",
    character_version: "1.2",
    character_book: {
      entries: [
        { keys: ["唱片"], content: "店里收藏了三千张黑胶。" },
        { keys: ["台风"], content: "小镇每年夏天都有台风。" },
      ],
    },
  },
};

describe("parseTavernCard · JSON", () => {
  it("解析 V1 卡（字段在顶层）", () => {
    const result = parseTavernCard({ text: JSON.stringify(V1_CARD) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("json");
    expect(result.card.specVersion).toBe(1);
    expect(result.card.name).toBe("叶知秋");
    expect(result.card.firstMessage).toBe(V1_CARD.first_mes);
    expect(result.card.alternateGreetings).toEqual([]);
  });

  it("解析 V2 卡（字段在 data 里，附带元数据与世界书条目数）", () => {
    const result = parseTavernCard({ text: JSON.stringify(V2_CARD) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.specVersion).toBe(2);
    expect(result.card.name).toBe("林见夏");
    expect(result.card.systemPrompt).toBe("始终使用第一人称。");
    expect(result.card.postHistoryInstructions).toBe("不要替用户做决定。");
    expect(result.card.alternateGreetings).toEqual(["要不要听点别的？"]);
    expect(result.card.tags).toEqual(["slow-burn", "city"]);
    expect(result.card.lorebookEntries).toBe(2);
    // 世界书条目一并解析出来（后续按关键词注入）
    expect(result.card.loreEntries).toHaveLength(2);
    expect(result.card.loreEntries[0]!.content).toBe("店里收藏了三千张黑胶。");
    expect(result.card.loreEntries[0]!.keys).toEqual(["唱片"]);
  });

  it("V1 卡没有世界书时条目为空数组", () => {
    const result = parseTavernCard({ text: JSON.stringify(V1_CARD) });
    if (!result.ok) throw new Error("测试数据应当能解析");
    expect(result.card.loreEntries).toEqual([]);
    expect(result.card.lorebookEntries).toBe(0);
  });

  it("缺字段时按规范补空串，不抛错", () => {
    const result = parseTavernCard({
      text: JSON.stringify({ name: "只有名字", description: "描述" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.personality).toBe("");
    expect(result.card.messageExamples).toBe("");
    expect(result.card.lorebookEntries).toBe(0);
  });

  it("不是角色卡的 JSON 会被拒绝（而不是当成空卡导入）", () => {
    expect(parseTavernCard({ text: '{"foo":1}' })).toEqual({
      ok: false,
      error: "not-tavern-card",
    });
    expect(parseTavernCard({ text: "不是 JSON" })).toEqual({
      ok: false,
      error: "not-tavern-card",
    });
  });

  it("空输入返回 empty", () => {
    expect(parseTavernCard({ text: "   " })).toEqual({ ok: false, error: "empty" });
    expect(parseTavernCard({ bytes: new Uint8Array() })).toEqual({
      ok: false,
      error: "empty",
    });
  });
});

describe("extractPngTextChunk / PNG 卡", () => {
  it("从 PNG 的 tEXt 块里取出角色卡（base64 解码）", () => {
    const json = JSON.stringify(V1_CARD);
    const png = buildPngWithText("chara", toBase64Utf8(json));

    expect(extractPngTextChunk(png, "chara")).toBe(toBase64Utf8(json));

    const result = parseTavernCard({ bytes: png });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("png");
    expect(result.card.name).toBe("叶知秋");
  });

  it("关键字大小写不敏感（V1 规范拼作 Chara）", () => {
    const png = buildPngWithText("Chara", "abc");
    expect(extractPngTextChunk(png, "chara")).toBe("abc");
  });

  it("没有卡片数据块时给出 no-card-chunk，而不是崩掉", () => {
    const png = buildPngWithText("Comment", "hello");
    expect(parseTavernCard({ bytes: png })).toEqual({
      ok: false,
      error: "no-card-chunk",
    });
  });

  it("截断的 PNG 不会越界读取", () => {
    const png = buildPngWithText("chara", "abc");
    const truncated = png.slice(0, 20);
    expect(extractPngTextChunk(truncated, "chara")).toBeNull();
  });

  it("不是 PNG 的字节直接返回 null", () => {
    expect(extractPngTextChunk(new TextEncoder().encode("hello world"), "chara")).toBeNull();
  });
});

describe("占位符与示例对话", () => {
  it("替换 {{char}} / {{user}} / <BOT> / <USER>，大小写不敏感", () => {
    expect(
      substituteCardPlaceholders(
        "{{char}} 对 {{USER}} 说：<bot> 在等 <user>",
        "叶知秋",
        "我",
      ),
    ).toBe("叶知秋 对 我 说：叶知秋 在等 我");
  });

  it("示例对话按 <START> 分段，去掉分隔符但保留轮次结构", () => {
    const converted = convertMessageExamples(
      "<START>\n{{user}}: 在吗\n{{char}}: 在\n<START>\n{{user}}: 忙吗\n{{char}}: 还好",
      "叶知秋",
      "我",
    );
    expect(converted).toBe("我: 在吗\n叶知秋: 在\n\n我: 忙吗\n叶知秋: 还好");
    expect(converted).not.toContain("<START>");
  });
});

describe("tavernCardToCharacterCard", () => {
  const parsed = parseTavernCard({ text: JSON.stringify(V2_CARD) });
  if (!parsed.ok) throw new Error("测试数据应当能解析");

  it("把卡片字段映射到角色档案与人设模板", () => {
    const card = tavernCardToCharacterCard(parsed.card, {
      now: 1_700_000_000_000,
      avatarUrl: "data:image/png;base64,AAAA",
      userName: "我",
    });

    expect(card.format).toBe("zhichi-character");
    expect(card.character.displayName).toBe("林见夏");
    expect(card.character.bio).toBe("海边小镇的唱片店老板");
    expect(card.character.visualMetadata.avatarUrl).toBe(
      "data:image/png;base64,AAAA",
    );
    // 开场白带过来了（新会话的第一句话）
    expect(card.character.greeting).toBe("外面雨太大了，先坐会儿吧。");

    const template = card.promptTemplate!;
    expect(template.identityName).toBe("林见夏");
    expect(template.identityBackground).toBe("海边小镇的唱片店老板。");
    expect(template.personalityTraits).toBe("懒散但敏锐。");
    expect(template.worldPlot).toBe("台风天的傍晚，店里只有你们两个客人。");
    expect(template.speechExamples).toContain("我: 这张唱片是谁的");
    expect(template.speechExamples).toContain("林见夏: 一个再也没回来的人。");
    // 作者给的系统提示词不丢弃，进"额外补充"
    expect(template.content).toContain("始终使用第一人称。");
    expect(template.content).toContain("不要替用户做决定。");
  });

  it("没有名字时用兜底名，不会产出空名角色", () => {
    const card = tavernCardToCharacterCard(
      { ...parsed.card, name: "  ", firstMessage: "" },
      { now: 1 },
    );
    expect(card.character.displayName).toBe("未命名角色");
    expect(card.character.greeting).toBeUndefined();
  });

  it("V1 卡的占位符在映射时被替换成具体称呼", () => {
    const v1 = parseTavernCard({ text: JSON.stringify(V1_CARD) });
    if (!v1.ok) throw new Error("测试数据应当能解析");
    const card = tavernCardToCharacterCard(v1.card, { now: 2, userName: "阿风" });

    expect(card.character.greeting).toBe("……这本家谱，你从哪儿找到的？");
    // 简介也不能漏掉占位符（真机导入时踩到过：bio 里留着 "{{char}}"）
    expect(card.character.bio).toBe("叶知秋是一名古籍修复师");
    expect(card.promptTemplate!.identityBackground).toContain("叶知秋是一名古籍修复师");
    expect(card.promptTemplate!.worldPlot).toContain("阿风带着一本破损的家谱");
  });
});
