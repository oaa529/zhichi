/**
 * @file contextUsage.test.ts
 * 上下文占用展示工具测试。
 */

import { describe, it, expect } from "vitest";
import type { IContextUsage } from "@wechat-rp/shared-types";
import {
  buildUsageRows,
  formatTokenCount,
  isContextTight,
} from "../utils/contextUsage";

function makeUsage(overrides: Partial<IContextUsage> = {}): IContextUsage {
  return {
    estimatedTokens: 1200,
    messageCount: 9,
    chars: { system: 120, template: 0, lore: 0, memory: 80, plot: 0, history: 900 },
    trimmed: false,
    summarized: false,
    removedChars: 0,
    ...overrides,
  };
}

describe("formatTokenCount", () => {
  it("小于 1000 时原样显示整数", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(820)).toBe("820");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("1000 以上折算成 k，保留一位小数", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1436)).toBe("1.4k");
    expect(formatTokenCount(9949)).toBe("9.9k");
  });

  it("10k 以上不再显示小数", () => {
    expect(formatTokenCount(12345)).toBe("12k");
  });

  it("异常输入不炸", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});

describe("buildUsageRows", () => {
  it("过滤掉没有内容的部分", () => {
    const rows = buildUsageRows(makeUsage());
    expect(rows.map((r) => r.label)).toEqual(["角色卡", "长期记忆", "对话历史"]);
  });

  it("【别重复】有内容时单独占一行（老存档没有这个字段也不炸）", () => {
    const withAntiRepeat = buildUsageRows(
      makeUsage({
        chars: {
          system: 120,
          template: 0,
          lore: 0,
          memory: 0,
          plot: 0,
          antiRepeat: 90,
          history: 900,
        },
      }),
    );
    expect(withAntiRepeat.map((r) => r.label)).toEqual([
      "角色卡",
      "防复读",
      "对话历史",
    ]);

    // 老存档里没有 antiRepeat 字段：按 0 处理，不显示这一行
    const legacy = buildUsageRows(makeUsage());
    expect(legacy.map((r) => r.label)).not.toContain("防复读");
  });

  it("全空时返回空数组", () => {
    const rows = buildUsageRows(
      makeUsage({
        chars: { system: 0, template: 0, lore: 0, memory: 0, plot: 0, history: 0 },
      }),
    );
    expect(rows).toEqual([]);
  });

  it("模板块有内容时出现在第二行", () => {
    const rows = buildUsageRows(
      makeUsage({
        chars: { system: 100, template: 300, lore: 0, memory: 0, plot: 50, history: 500 },
      }),
    );
    expect(rows.map((r) => r.label)).toEqual([
      "角色卡",
      "人设模板",
      "剧情摘要",
      "对话历史",
    ]);
  });
});

describe("isContextTight", () => {
  it("只有发生裁剪才算紧张", () => {
    expect(isContextTight(makeUsage())).toBe(false);
    expect(isContextTight(makeUsage({ trimmed: true }))).toBe(true);
    expect(isContextTight(null)).toBe(false);
    expect(isContextTight(undefined)).toBe(false);
  });
});
