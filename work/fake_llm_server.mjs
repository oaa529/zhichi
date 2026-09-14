/**
 * @file fake_llm_server.mjs
 * 浏览器端到端验证用的**假 LLM 服务**（本地起一个 OpenAI 兼容端点）。
 *
 * 为什么需要它：`apihub.agnes-ai.com` 在验证用的 headless Chromium 里连不通，
 * 而"角色引用你的话"要验证的正是**整条链路**——
 * 流式适配器 → 情绪头解析 → 引用标记过滤 → 引用块挂载 → 气泡渲染 → 点击跳转。
 * 与其只跑单测，不如让浏览器真的走一次 SSE。
 *
 * 行为：收到请求后按 SSE 逐段吐出一段带引用标记的回复，分片故意切在
 * 标记中间（`【引` / `用：…】`），顺便验证跨分片的解析。
 *
 * 用法：node work/fake_llm_server.mjs [port]   （默认 5399）
 * 一次性探针脚本，不参与产品运行时。
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 5399);

/**
 * 首块延迟（ms）。默认很小；要验证"切走之后角色才回复"这类场景时，
 * 把它调大（例如 3000），就有时间在回复到达前切到别的会话。
 */
const FIRST_CHUNK_DELAY_MS = Number(process.env.FIRST_CHUNK_DELAY_MS ?? 120);

/**
 * 分片间隔（ms）与分片长度。
 *
 * 调大这两个值就能模拟"慢但在出字"的供应商：用来验证适配器的**空闲超时**
 * ——总耗时远超超时时间，只要每一片之间的间隔没超，回复就该完整收下来。
 */
const CHUNK_INTERVAL_MS = Number(process.env.CHUNK_INTERVAL_MS ?? 120);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 6);

/** 自定义回复文本（不设时按下面的脚本轮换）。 */
const REPLY_OVERRIDE = process.env.FAKE_REPLY ?? "";

/**
 * 按请求次数给出脚本化回复（用来驱动"心情 → 立绘"的端到端验证）：
 * - 前两轮：角色明确标 angry（于是推导出的心情是"生气"）
 * - 之后：回复既没有情绪标签、正文也没有情绪词（"嗯，好。"）——
 *   这时立绘只能靠心情兜底，正好检验它有没有生效
 */
const REPLIES = [
  "angry\n……抱歉，我是有点在意。",
  "angry\n我没生气，就是心里不太舒服。",
  "嗯，好。",
];

let requestCount = 0;

/** 把一段回复切成小片，模拟流式输出。 */
function splitReply(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function sseChunk(delta) {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: delta }, index: 0 }],
  })}\n\n`;
}

const server = createServer((req, res) => {
  // 浏览器跨域预检
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const index = Math.min(requestCount, REPLIES.length - 1);
    const reply = REPLY_OVERRIDE || REPLIES[index];
    const chunks = splitReply(reply);
    requestCount += 1;
    console.log(`收到第 ${requestCount} 个请求（${raw.length} 字节）→ 回复：${reply.replace(/\n/g, "⏎")}`);
    console.log(
      `（分片 ${chunks.length} 个，每片间隔 ${CHUNK_INTERVAL_MS}ms → 预计总时长约 ${chunks.length * CHUNK_INTERVAL_MS}ms）`,
    );
    // 把 system 提示词打出来：用来核对"设置里的东西有没有真的进请求"
    try {
      const body = JSON.parse(raw);
      const system = body?.messages?.find((m) => m.role === "system");
      if (system) {
        console.log("---- system 提示词（前 600 字）----");
        console.log(system.content.slice(0, 600));
        console.log("---- 结束 ----");
        // "关于对方"整段单独打一遍（它排在提示词靠后的位置，前 600 字看不到）
        const at = system.content.indexOf("【关于对方】");
        if (at >= 0) {
          console.log("---- 【关于对方】段落 ----");
          console.log(system.content.slice(at, at + 300));
          console.log("---- 结束 ----");
        } else {
          console.log("（提示词里没有【关于对方】段落）");
        }
        // "现在几点 / 上一句隔了多久"这两段排在提示词最后（睡眠/忙碌/心情之后），
        // 前 600 字看不到，所以单独找出来打一遍
        for (const marker of ["【现在】", "【上一句】"]) {
          const index = system.content.indexOf(marker);
          if (index >= 0) {
            console.log(`---- ${marker} 段落 ----`);
            console.log(system.content.slice(index, index + 260));
            console.log("---- 结束 ----");
          } else {
            console.log(`（提示词里没有 ${marker} 段落）`);
          }
        }
        // 「记忆 / 剧情」在末尾那条 system 里，一并打出来
        const dynamic = body?.messages?.filter(
          (m) => m.role === "system" && m.content !== system.content,
        );
        if (dynamic?.length) {
          console.log("---- 末尾动态 system（记忆/剧情）----");
          console.log(dynamic[dynamic.length - 1].content.slice(0, 300));
          console.log("---- 结束 ----");
        }
      }
    } catch {
      console.log("（请求体不是 JSON，跳过提示词打印）");
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let cursor = 0;
    let timer = null;
    const tick = () => {
      if (cursor >= chunks.length) {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(sseChunk(chunks[cursor]));
      cursor += 1;
    };
    setTimeout(() => {
      tick();
      timer = setInterval(tick, CHUNK_INTERVAL_MS);
    }, FIRST_CHUNK_DELAY_MS);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`假 LLM 服务已启动：http://127.0.0.1:${PORT}/v1`);
});
