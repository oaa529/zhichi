/**
 * @file agnes_character_gen_probe.mts
 * 真机验证：AI 角色卡生成的质量与稳定性。
 *
 * 走的是产品同一条链路：buildCharacterGenPrompt → 真机调用 → parseCharacterGenResult。
 * 对每个描述统计：能否解析、字段齐全度、内容是否"具体"（有数字/专有名词）、
 * 是否出现空泛套话。最后把生成的角色卡完整打印出来人工过一眼。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_character_gen_probe.mts
 */

import {
  buildCharacterGenPrompt,
  parseCharacterGenResult,
  type ICharacterDraft,
} from "../packages/core/src/character/CharacterForge";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";

const DESCRIPTIONS = [
  "高中同桌，傲娇但细心，喜欢猫",
  "深夜电台主播，声音温柔，自己有失眠症",
  "走江湖的郎中，嘴贫但医术好，爱收集偏方",
];

/** 空泛套话（出现越多说明人设越"水"）。 */
const VAGUE_PATTERNS = /温柔善良|美丽动人|气质优雅|才华横溢|善解人意|神秘莫测/g;

async function callAgnes(messages: ReadonlyArray<ILLMMessage>): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.9,
      max_tokens: 1600,
      stream: false,
    }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** 统计草稿的字段齐全度与内容特征。 */
function inspectDraft(draft: ICharacterDraft): string {
  const fields: ReadonlyArray<[string, string]> = [
    ["背景", draft.background],
    ["性格", draft.personality],
    ["说话风格", draft.speechStyle],
    ["世界观", draft.worldSetting],
    ["开场白", draft.greeting],
    ["示例对话", draft.examples],
  ];
  const filled = fields.filter(([, value]) => value.length > 0).length;
  const allText = fields.map(([, value]) => value).join("\n");
  const vague = allText.match(VAGUE_PATTERNS)?.length ?? 0;
  const concrete = /\d|岁|点|年|月|街|店|校|班|台|猫|茶|药/.test(allText);

  return [
    `字段齐全 ${filled}/6`,
    `具体细节 ${concrete ? "有" : "无"}`,
    `空泛套话 ${vague} 处`,
    `开场白「${draft.greeting.slice(0, 24)}」`,
  ].join("　|　");
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  let parsedCount = 0;
  const drafts: ICharacterDraft[] = [];

  for (const [index, description] of DESCRIPTIONS.entries()) {
    console.log(`\n===== #${index + 1} 描述：${description} =====`);
    const prompt = buildCharacterGenPrompt(description);
    let raw = "";
    try {
      raw = await callAgnes([
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ]);
    } catch (error) {
      console.log(`  调用失败：${String(error).slice(0, 80)}`);
      continue;
    }

    const draft = parseCharacterGenResult(raw);
    if (!draft) {
      console.log("  ❌ 解析失败，原始输出前 160 字：");
      console.log("  " + raw.replace(/\s+/g, " ").slice(0, 160));
      continue;
    }

    parsedCount += 1;
    drafts.push(draft);
    console.log(`  ✅ 解析成功　${inspectDraft(draft)}`);
    console.log(`  名字：${draft.displayName}（${draft.archetype}）　简介：${draft.bio}`);
    console.log(`  背景：${draft.background.slice(0, 90)}`);
    console.log(`  示例：${draft.examples.replace(/\n/g, " / ").slice(0, 90)}`);
  }

  console.log(
    `\n===== 汇总：解析成功 ${parsedCount}/${DESCRIPTIONS.length} =====`,
  );
}

await main();
