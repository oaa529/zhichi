/**
 * @file globalCssContract.test.ts
 * 样式表契约：守住几类"编译期不报错、只有真机才看得见"的 CSS 缺陷。
 *
 * 为什么需要它
 * -----------
 * jsdom 没有排版引擎，`offsetHeight` 恒为 0，所以 flex 挤压、元素被裁切这类
 * 布局 bug 在组件测试里**完全测不出来**——只能真机量 DOM。
 * 同理，`background: background: x` 这种同属性写两遍的笔误，浏览器会静默丢弃前一条，
 * `vite build` 和 `eslint` 都看不见。
 *
 * 这两类 bug 都曾真实发生过（输入区底部被裁 14px、三个区块背景色失效），
 * 所以把关键声明当作契约，直接断言在样式表文本上。
 *
 * 样式表用 `?raw` 以字符串导入：不需要 node 内置模块，浏览器向的包里也不必
 * 为了这一个测试引入 `@types/node`。
 */

import { describe, it, expect } from "vitest";
import css from "../global.css?raw";

/** 去掉注释，免得注释里的字样被当成真声明。 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取某条规则的声明块（含花括号之间的内容）。
 *
 * 选择器精确匹配，避免 `.zhichi-input-bar` 误配到 `--apply` 之类的后缀；
 * 同时支持逗号分组——`.a,\n.b { }` 里单独查 `.a` 或 `.b` 都应拿到同一份声明。
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const grouped = new RegExp(
    `(?:^|[}\\s])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
  );
  const m = code.match(grouped);
  expect(m, `样式表里找不到规则 ${selector}`).not.toBeNull();
  return m?.[1] ?? "";
}

/** 读出规则里的某个 px 数值声明。 */
function px(ruleText: string, prop: string): number {
  return Number(new RegExp(`${prop}\\s*:\\s*(\\d+)px`).exec(ruleText)?.[1] ?? NaN);
}

describe("global.css · 布局契约", () => {
  it("输入栏不被上方消息区挤压（曾被裁掉底部 14px）", () => {
    // flex 容器里默认 flex-shrink:1，缺这条就会被兄弟节点压扁；
    // 父级 .zhichi-shell__main-content 是 overflow:hidden，压掉的像素找不回来。
    expect(rule(".zhichi-input-bar")).toMatch(/flex-shrink:\s*0\b/);
  });

  it("消息区占剩余空间并允许内部收缩，而不是 height:100% 抢满", () => {
    const session = rule(".wechat-chat-session");

    // height:100% 会让消息区先占满父高，输入栏只能被挤掉 14px。
    expect(session).not.toMatch(/height:\s*100%/);
    expect(session).toMatch(/flex:\s*1\b/);
    // min-height 默认 auto，内容过高时拒绝收缩，等于没放开。
    expect(session).toMatch(/min-height:\s*0\b/);
  });

  it("输入栏的 min-height 容得下各段内容最小高度之和", () => {
    // 内容地板 = 把手 12 + 工具栏（padding-top 8 + 图标 32）+ 输入行 60 = 112。
    // 原先写的是 60，比内容地板还矮，等于跟内容打架。
    const resizer = rule(".zhichi-input-bar__resizer");
    const row = rule(".zhichi-input-bar__row");
    const toolbar = rule(".zhichi-input-bar__toolbar");

    const icon = rule(".zhichi-input-bar__icon-btn");
    const toolbarMin = px(toolbar, "padding-top") + px(icon, "height");
    const contentMin = px(resizer, "height") + toolbarMin + px(row, "min-height");

    expect(Number.isNaN(contentMin)).toBe(false);
    expect(contentMin).toBe(112);
    expect(px(rule(".zhichi-input-bar"), "min-height")).toBeGreaterThanOrEqual(contentMin);
  });

  it("空状态溢出时改为上对齐并可滚动（居中溢出滚不回来）", () => {
    const empty = rule(".wechat-chat-session__empty");

    // 普通 center 会把头像顶出容器上沿，再被上层 overflow:hidden 裁掉且滚不回来。
    expect(empty).toMatch(/justify-content:\s*safe\s+center/);
    expect(empty).toMatch(/overflow-y:\s*auto/);
  });

  it("系统消息与撤回提示整行居中，不套用普通消息的左右对齐", () => {
    // 它们没有头像了，但行本身若还是 row / row-reverse，文字会被顶到一侧。
    for (const type of ["system", "recall"]) {
      const sel = `.wechat-msg[data-msg-type="${type}"]`;
      const body = rule(`${sel} .wechat-msg__body`);
      expect(body, `${sel} 缺少 body 居中规则`).toMatch(/justify-content:\s*center/);
    }
    // system/recall 的气泡底色必须仍是透明的（居中灰字，不画气泡）
    expect(rule(".wechat-msg-bubble--system")).toMatch(/background:\s*transparent/);
    expect(rule(".wechat-msg-bubble--recall")).toMatch(/background:\s*transparent/);
  });

  it("语音气泡有底色，且和文字气泡同一档", () => {
    // 背景色原先只挂在 --text/--typing 上，语音气泡直接印在聊天背景上。
    const other = code.match(
      /\.wechat-msg-bubble--text,\s*([^{]*?)\{\s*background:\s*([^;]+);/,
    );
    expect(other, "找不到文字气泡的背景色规则").not.toBeNull();
    expect(other?.[1]).toContain("--voice");
    // 自己发的语音要是绿色气泡
    const self = code.match(
      /\.wechat-msg\[data-self="true"\][^{]*--text,\s*([^{]*?)\{\s*background:\s*([^;]+);/,
    );
    expect(self?.[1]).toContain("--voice");
  });

  it("引用预览是单行内联，不是上下两行", () => {
    const quote = rule(".wechat-msg__quote");
    // column 会让"名字 / 正文"各占一行，短引用也要 58px 高，像凭空多了一条消息
    expect(quote).not.toMatch(/flex-direction:\s*column/);
    expect(quote).toMatch(/display:\s*flex/);

    // 正文必须允许收缩，否则 text-overflow: ellipsis 永远不触发
    const text = rule(".wechat-msg__quote-text");
    expect(text).toMatch(/min-width:\s*0\b/);
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    // 名字不许被挤没
    expect(rule(".wechat-msg__quote-name")).toMatch(/flex-shrink:\s*0/);
  });
});

describe("global.css · 书写正确性", () => {
  it("没有同属性写两遍（后一条会让前一条被浏览器丢弃）", () => {
    // 真实踩过：background: background: var(...) —— 整条 background 失效，
    // 三个区块凭空少了背景色，build 和 eslint 都不报错。
    const offenders: string[] = [];
    code.split("\n").forEach((line: string, i: number) => {
      if (/([a-z-]+)\s*:\s*\1\s*:/i.test(line)) offenders.push(`第 ${i + 1} 行: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it("圆角只用 token 或 50%，不写字面值", () => {
    const literals = [...code.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((m: RegExpExecArray) => m[1]?.trim() ?? "")
      .filter((v: string) => /^\d+px$/.test(v));
    expect(literals).toEqual([]);
  });

  it("硬编码旧品牌蓝已全部换成微信蓝灰", () => {
    expect(code).not.toMatch(/rgba\(\s*91,\s*141,\s*239/);
    expect(code).not.toMatch(/#5b8def\b/i);
  });
});
