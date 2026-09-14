/**
 * @file MemoryRetrieverParaphrase.test.ts
 * 大白话提问也要检索得到：记忆是"提炼后的书面说法"，用户却常说上位词。
 *
 * 由来（真机复核 `work/agnes_consistency_probe.mts` 的延伸）：
 * 事实一旦被上下文裁掉，角色能不能答对**全看检索**。而检索原来是纯关键词
 * 匹配——记忆里写"柯基"，用户问"我家那只狗叫什么来着？"就一条都命中不了，
 * 于是角色答"记不太清"。8 条大白话问法里只有 3 条能检索到。
 *
 * 这里的用例就是那 8 条 + 4 条**无关闲聊**（话题扩展不能变成撒网）。
 */

import { describe, it, expect } from "vitest";
import type { IMemory } from "@wechat-rp/shared-types";
import {
  expandQueryTopics,
  retrieveMemories,
} from "../memory/MemoryRetriever";

const NOW = Date.UTC(2026, 8, 13, 12, 41);

function mem(id: string, content: string, keywords: string[]): IMemory {
  return {
    id,
    characterId: "c1",
    kind: "fact",
    content,
    keywords,
    importance: 3,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
  };
}

/** 记忆库：全是"提炼后"的书面说法。 */
const MEMORIES: ReadonlyArray<IMemory> = [
  mem("m1", "用户住在杭州，养了一只叫豆豆的柯基", ["杭州", "豆豆", "柯基"]),
  mem("m2", "用户下周三要去医院复查", ["复查", "医院", "周三"]),
  mem("m3", "用户对花生过敏", ["花生", "过敏"]),
  mem("m4", "用户最近换了工作，去了一家互联网公司", ["换工作", "互联网"]),
  mem("m5", "用户不吃香菜", ["香菜"]),
  mem("m6", "用户养了一只叫团团的猫", ["团团", "猫"]),
  mem("m7", "用户妈妈下个月过生日，喜欢养花", ["妈妈", "生日", "花"]),
];

describe("retrieveMemories · 大白话提问", () => {
  it("上位词/别名也能检索到（狗→柯基、坚果→花生、上班的地方→互联网公司）", () => {
    const cases: ReadonlyArray<{ text: string; want: string }> = [
      { text: "我家那只狗叫什么来着？", want: "m1" },
      { text: "我养的小狗最近还好吗", want: "m1" },
      { text: "我那只宠物是不是该打疫苗了", want: "m1" },
      { text: "我明天是不是要去趟医院", want: "m2" },
      { text: "我是不是不能吃坚果", want: "m3" },
      { text: "我现在上班的地方怎么样来着", want: "m4" },
      { text: "我家里那只猫呢", want: "m6" },
      { text: "我妈生日快到了吧", want: "m7" },
    ];

    for (const item of cases) {
      const picked = retrieveMemories(item.text, MEMORIES, {
        now: NOW,
        maxItems: 3,
      });
      expect(
        picked.map((memory) => memory.id),
        `「${item.text}」应该能检索到 ${item.want}`,
      ).toContain(item.want);
    }
  });

  it("「宠物」这种泛指同时够到猫和狗，但不会把「妈妈养花」拉进来", () => {
    const picked = retrieveMemories("我那只宠物是不是该打疫苗了", MEMORIES, {
      now: NOW,
      maxItems: 3,
    });
    const ids = picked.map((memory) => memory.id);

    expect(ids).toContain("m1"); // 狗
    expect(ids).toContain("m6"); // 猫
    // 扩展词"狸花"里含一个"花"，旧写法会把"妈妈喜欢养花"也捞进来
    expect(ids).not.toContain("m7");
  });

  it("无关闲聊不该注入任何记忆（话题扩展不是撒网）", () => {
    const chitchat: ReadonlyArray<string> = [
      "今天天气还不错，晒晒太阳挺舒服的",
      "我中午在楼下吃了碗牛肉面",
      "这个周末想去爬山，你觉得怎么样",
      "刚看完一部电影，节奏挺好的",
    ];

    for (const text of chitchat) {
      expect(
        retrieveMemories(text, MEMORIES, { now: NOW, maxItems: 3 }),
        `「${text}」不该命中记忆`,
      ).toHaveLength(0);
    }
  });
});

describe("expandQueryTopics", () => {
  it("命中一组就把整组说法并进来", () => {
    const terms = expandQueryTopics("我家那只狗呢");
    expect(terms).toContain("柯基");
    expect(terms).toContain("柴犬");
    // 狗这一组不该带出猫的说法
    expect(terms).not.toContain("英短");
  });

  it("泛指词（宠物）同时够到两组", () => {
    const terms = expandQueryTopics("我那只宠物呢");
    expect(terms).toContain("柯基");
    expect(terms).toContain("英短");
  });

  it("没有命中任何话题时返回空数组（调用方据此走原逻辑）", () => {
    expect(expandQueryTopics("今天天气不错")).toEqual([]);
    expect(expandQueryTopics("")).toEqual([]);
  });
});
