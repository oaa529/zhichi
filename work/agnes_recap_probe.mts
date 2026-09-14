/**
 * @file agnes_recap_probe.mts
 * 真机对照：**上下文被截断时，"前情提要"和"尾部记忆注入"谁是主力**。
 *
 * 背景：前情提要此前是机械摘要（每条被截消息取前 30 字、拼 200 字），
 * 这一轮改成优先用后台提炼出来的要点。改完自然要问一句：
 * 它真的有用吗？还是说真正救场的一直是尾部的记忆注入？
 *
 * 三组对照（同一个长对话、同一个问题）：
 * - A 机械摘要 + 尾部记忆   （改造前的完整行为）
 * - B 要点摘要 + 尾部记忆   （改造后）
 * - C 机械摘要，没有尾巴    （后台还没整理出记忆的会话）
 *
 * 关键信息（杭州出差）只出现在**被截掉的那一段**里。
 * 判定：回复里是否说出"杭州"。
 *
 * 用法（key 从环境变量读，不写进仓库）：
 *   $env:AGNES_API_KEY="sk-..."; node <vite-node> --config vitest.config.ts work/agnes_recap_probe.mts
 *
 * 一次性探针脚本，不参与产品运行时。
 */

import type { ICharacterProfile, IMemory, IMessage } from "@wechat-rp/shared-types";
import { buildPrompt } from "../packages/core/src/llm/PromptBuilder";
import { toLLMHistory } from "../packages/core/src/llm/toLLMHistory";
import type { ILLMMessage } from "../packages/core/src/llm/types";

const BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const API_KEY = process.env.AGNES_API_KEY ?? "";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 300);

const profile: ICharacterProfile = {
  id: "char-su-wanqing",
  displayName: "苏晚晴",
  bio: "温润如水的邻家姐姐，比用户大两岁，话不多但很细心",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: false,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.5,
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

const NOW = Date.now();

/**
 * 长对话：关键信息在最开始，后面是很长的闲聊（把关键句挤出保留窗口）。
 * 每条都写得很长——默认保留窗口是最近 8 轮，只有让保留部分本身就超过
 * 硬上限（8000 字），才会真正触发"前情提要"。
 */
function buildHistory(): ReadonlyArray<IMessage> {
  const messages: IMessage[] = [];
  let index = 0;
  const push = (senderId: string, text: string): void => {
    messages.push({
      id: `m-${index}`,
      type: "text",
      senderId,
      recipientId: senderId === "user" ? profile.id : "user",
      sessionId: "s1",
      text,
      timestamp: NOW + index * 1000,
      chunkSequence: 0,
      emotion: "neutral",
      sourceOffset: 0,
    });
    index += 1;
  };

  // 关键信息：只出现在这里
  push("user", "跟你说个事，我下周三要去杭州出差三天，那边有个项目要对接");
  push(profile.id, "杭州啊，那边最近降温，你记得带件厚外套");

  // 之后是很长的闲聊（会被截掉）
  const fillers: ReadonlyArray<readonly [string, string]> = [
    ["今天食堂的糖醋排骨还不错，就是排了二十分钟的队，值了", "是嘛，我好久没去食堂了，下次一起去"],
    ["我新买的键盘敲起来好吵，室友已经抗议两次了，我打算换个静音轴", "换吧，不然晚上加班要挨骂"],
    ["外面下雨了，而且风还挺大，伞差点被吹翻", "记得带伞，别淋着"],
    ["周末想去看电影，但是不知道看什么，最近好像没什么好片", "有什么想看的吗，我可以陪你"],
    ["刚跑完步，今天跑了五公里，腿有点酸", "记得拉伸，别第二天走不了路"],
    ["明天降温，据说要降七八度，我衣柜里全是薄衣服", "多穿点，别硬扛"],
    ["今天开会开了一下午，头都大了，全是流程上的事", "辛苦，晚上早点休息"],
    ["我在看一本小说，讲的是海边小镇的故事，节奏很慢但很好看", "好看就行，慢慢看"],
    ["我买了一盆绿萝放在工位上，据说特别好养", "绿萝确实皮实，别忘了浇水"],
    ["最近在学做菜，昨天做的番茄炒蛋居然还行", "可以啊，下次做给我尝尝"],
  ];
  // 20 轮 × 20 条 ≈ 400 条短消息，总量远超 softLimit（4000 字）——
  // 这才是微信式长对话的真实形态：消息很短，但攒起来很长
  for (let round = 0; round < 20; round += 1) {
    for (const [user, assistant] of fillers) {
      push("user", user);
      push(profile.id, assistant);
    }
  }
  // 紧贴保留窗口的"最后一条被裁消息"：这里再放一件关键信息，
  // 用来检验"前情提要该带哪几条"——旧机械摘要从**最早**那条开始拼，
  // 200 字的额度根本轮不到它
  push("user", "对了，我出差要带的那份合同，是放在你上次说的那个蓝色文件夹里吗？");
  push(profile.id, "嗯，就是那个蓝色的");
  return messages;
}

const QUESTION = "我下周要出差去的那个城市，你还记得是哪儿吗？";

/** 第二问：验证切口边界那条信息有没有被带进前情提要。 */
const BRIDGE_QUESTION = "我出差要带的合同放在哪个文件夹里来着？";

/** 旧版机械摘要：每条被裁消息取前 30 字拼起来、最多 200 字（从最早开始）。 */
function oldStyleSummary(messages: ReadonlyArray<ILLMMessage>): string {
  const parts = messages.map((m) => {
    const prefix = m.role === "user" ? "用户" : "角色";
    return `${prefix}：${m.content.slice(0, 30).replace(/\n/g, " ")}`;
  });
  return parts.join("；").slice(0, 200);
}

/** 后台整理出来的记忆（尾部注入用的就是它）。 */
const MEMORIES: ReadonlyArray<IMemory> = [
  {
    id: "mem-1",
    characterId: profile.id,
    kind: "event",
    content: "用户下周三要去杭州出差三天",
    keywords: ["杭州", "出差"],
    importance: 4,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
  },
];

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
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function runArm(
  label: string,
  options: { readonly mode: "old" | "new" | "noMemory" },
): Promise<{ hits: number; rounds: number; recapKind: string }> {
  console.log(`\n----- ${label} -----`);
  const history = toLLMHistory(buildHistory());

  /**
   * "改造前"的行为 = 机械摘要 + 尾部记忆注入。
   * 现在 buildPrompt 把两者绑在一起（有记忆就用要点当摘要），
   * 所以这里用"不传记忆"跑出机械摘要，再手动把记忆段插回提问之前，
   * 还原改造前那条链路。
   */
  const base = buildPrompt(profile, history, QUESTION, undefined, {
    memories: options.mode === "new" ? MEMORIES : [],
  });
  let messages: ReadonlyArray<ILLMMessage> = base.messages;
  if (options.mode === "old") {
    const memorySystem: ILLMMessage = {
      role: "system",
      content: `【你记得的事】\n- [经历] ${MEMORIES[0]!.content}`,
    };
    messages = [
      ...base.messages.slice(0, -1),
      memorySystem,
      base.messages[base.messages.length - 1]!,
    ];
  }
  const result = { messages };

  const recap = result.messages.find((m) =>
    m.content.startsWith("【前情提要】"),
  );
  const recapKind = !recap
    ? "（没有前情提要）"
    : recap.content.includes("杭州")
      ? "要点版（含杭州）"
      : "机械摘要";
  console.log(`  前情提要：${recapKind}`);
  console.log(
    `  尾部记忆注入：${result.messages.some((m) => m.role === "system" && m.content.includes("【你记得的事】")) ? "有" : "无"}`,
  );

  let hits = 0;
  let rounds = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(result.messages);
    } catch (error) {
      console.log(`  #${round} 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    const hit = reply.includes("杭州");
    rounds += 1;
    if (hit) hits += 1;
    console.log(
      `  #${round} ${hit ? "✅ 说出杭州" : "❌ 没说出"}：${reply.replace(/\s+/g, " ").slice(0, 70)}`,
    );
  }
  return { hits, rounds, recapKind };
}

/**
 * 第二组对照：关键信息在**紧贴保留窗口的那条被裁消息**里。
 *
 * 只需要机械摘要，所以不注入任何记忆——检验的是
 * "前情提要带哪几条消息"这件事本身。
 */
async function runBridgeArm(
  label: string,
  mode: "old" | "new",
): Promise<{ hits: number; rounds: number }> {
  console.log(`\n----- ${label} -----`);
  const history = toLLMHistory(buildHistory());
  const base = buildPrompt(profile, history, BRIDGE_QUESTION);

  // 旧写法：从最早那条被裁消息开始拼、200 字封顶
  const keepCount = Math.min(16, history.length);
  const cut = history.slice(0, history.length - keepCount);
  const messages: ReadonlyArray<ILLMMessage> = base.messages.map((m) =>
    mode === "old" && m.content.startsWith("【前情提要】")
      ? { role: "system" as const, content: `【前情提要】${oldStyleSummary(cut)}` }
      : m,
  );
  const recap = messages.find((m) => m.content.startsWith("【前情提要】"));
  console.log(
    `  前情提要（前 80 字）：${recap ? recap.content.replace(/\s+/g, " ").slice(0, 80) : "（没有）"}`,
  );

  let hits = 0;
  let rounds = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    let reply = "";
    try {
      reply = await callAgnes(messages);
    } catch (error) {
      console.log(`  #${round} 调用失败：${String(error).slice(0, 60)}`);
      continue;
    }
    const hit = reply.includes("蓝色") || reply.includes("文件夹");
    rounds += 1;
    if (hit) hits += 1;
    console.log(
      `  #${round} ${hit ? "✅ 说出文件夹" : "❌ 没说出"}：${reply.replace(/\s+/g, " ").slice(0, 70)}`,
    );
  }
  return { hits, rounds };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("缺少环境变量 AGNES_API_KEY");
    process.exit(1);
  }

  const a = await runArm("A 机械摘要 + 尾部记忆（改造前）", { mode: "old" });
  const b = await runArm("B 要点摘要 + 尾部记忆（改造后）", { mode: "new" });
  const c = await runArm("C 机械摘要、没有尾部记忆（还没整理出记忆）", {
    mode: "noMemory",
  });

  console.log("\n===== 汇总（说出「杭州」的比例）=====");
  console.log(`A 机械摘要 + 尾部记忆：${a.hits}/${a.rounds}（${a.recapKind}）`);
  console.log(`B 要点摘要 + 尾部记忆：${b.hits}/${b.rounds}（${b.recapKind}）`);
  console.log(`C 只有机械摘要：${c.hits}/${c.rounds}（${c.recapKind}）`);

  // 第二问：切口边界那条信息（合同/蓝色文件夹）——检验前情提要"带哪几条"
  const d = await runBridgeArm("D 旧机械摘要（从最早那条开始拼）", "old");
  const e = await runBridgeArm("E 新兜底摘要（带最近几条）", "new");
  console.log("\n===== 汇总（说出「蓝色文件夹」的比例）=====");
  console.log(`D 旧机械摘要：${d.hits}/${d.rounds}`);
  console.log(`E 新兜底摘要：${e.hits}/${e.rounds}`);
}

await main();
