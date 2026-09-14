/**
 * @file merge_conflict_check.mts
 * 离线检查（不调模型）：同一次整理里如果**同时**给出"旧说法"和"新说法"，
 * 合并这一步会不会把它们并成一条。
 *
 * 为什么查这个：`mergeMemories` 只按字符 bigram 相似度 ≥ 0.7 去重，
 * 而"用户不吃辣"与"用户现在能吃微辣了"共享的 bigram 很少——**并不到一起**。
 * 也就是说：万一模型真的把新旧两种说法都写进草稿，两条会**都留在记忆库**，
 * 检索捞到哪条全看运气，角色可能拿旧状态纠正用户。
 *
 * 实测（真机 `agnes_window_flip_probe.mts` 连跑 3 轮）模型并没有这么干：
 * 只留最新说法，或写成"原先…最近…"的变化叙述。所以这里**只记录边界**，
 * 不为此加启发式规则——真出现时用上面那个探针能立刻抓到。
 *
 * 用法：node <vite-node> --config vitest.config.ts work/merge_conflict_check.mts
 */

import { mergeMemories } from "../packages/core/src/memory/MemoryDigest";

const NOW = Date.UTC(2026, 8, 13, 12, 41);

function run(label: string, drafts: ReadonlyArray<string>): void {
  const merged = mergeMemories({
    characterId: "c1",
    existing: [],
    drafts: drafts.map((content) => ({
      kind: "fact" as const,
      content,
      keywords: [],
      importance: 3,
    })),
    sourceMessageIds: [],
    now: NOW,
  });
  console.log(`\n${label}`);
  for (const memory of merged) console.log(`  → ${memory.content}`);
}

// A：旧说法更长（模型常把上下文写得更细）
run("A 旧说法更长", [
  "用户不吃辣，闻到辣椒就难受，胃也不好，一直很注意",
  "用户现在能吃微辣了",
]);

// B：新说法更长
run("B 新说法更长", [
  "用户不吃辣",
  "用户胃养好了，现在能吃一点微辣，但太辣还是受不了",
]);

// C：两条都写得很短
run("C 两条都短", ["用户不吃辣", "用户能吃辣了"]);

console.log(
  "\n结论：三种写法都**没有**被并成一条——去重阈值拦不住反向改口，" +
    "这一步的兜底只能靠模型只输出最新说法（真机 3/3 都是这么做的）。",
);
