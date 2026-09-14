/**
 * @file PlotTab.test.tsx
 * 剧情面板的渲染与交互回归。
 *
 * 与 MemoryTab 一样直接读写真实 sessionStore：面板是受控组件，
 * 状态全在 store 里，这样断言到的就是用户实际点出来的因果链。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ICharacterProfile, IPlotEvent } from "@wechat-rp/shared-types";
import { createEmptyPlotState } from "@wechat-rp/core";
import { useSessionStore } from "../store/sessionStore";
import { PlotTab } from "../components/PlotTab";

const NOW = 1_700_000_000_000;
const CHAR = "char-1";
const SESSION = "s1";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "苏晚晴",
  bio: "邻家姐姐",
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

function makeEvent(overrides: Partial<IPlotEvent> = {}): IPlotEvent {
  return {
    id: "evt-1",
    summary: "两人在咖啡馆重逢",
    at: NOW,
    importance: 4,
    sourceMessageIds: [],
    manual: false,
    ...overrides,
  };
}

/** 准备"已选中一个会话"的最小状态。 */
function seedSession(): void {
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    sessions: {
      [SESSION]: {
        id: SESSION,
        type: "single",
        participantIds: [CHAR, "user"],
        displayName: "苏晚晴",
        avatarUrl: "",
        lastMessagePreview: "",
        lastMessageTime: NOW,
        unreadCount: 0,
        isPinned: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    activeSessionId: SESSION,
    plotStates: {},
  });
}

beforeEach(() => {
  seedSession();
});

afterEach(() => {
  cleanup();
});

describe("PlotTab", () => {
  it("没有选中会话时给出提示", () => {
    useSessionStore.setState({ activeSessionId: null });
    render(<PlotTab />);
    expect(screen.getByText("请先选择一个会话")).toBeTruthy();
  });

  it("没有状态卡时表单为空、回滚与清空不可点、时间线提示可自动积累", () => {
    render(<PlotTab />);

    expect(screen.getByText(/还没有事件/)).toBeTruthy();
    expect(screen.getByText(/AI 会把关键剧情记录到这里/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /回滚/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /清空/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("已有状态卡时表单回填，事件按时间倒序展示", () => {
    useSessionStore.setState({
      plotStates: {
        [SESSION]: {
          ...createEmptyPlotState(SESSION, NOW),
          chapter: "第一章 · 重逢",
          scene: "放学后的教室",
          timeLabel: "周五傍晚",
          location: "南方小城",
          synopsis: "两人重新联系上",
          openThreads: ["未送出的生日礼物", "下周的约见"],
          relations: [{ characterId: CHAR, label: "青梅竹马" }],
          events: [
            makeEvent({ id: "evt-1", summary: "早上在路口打招呼" }),
            makeEvent({ id: "evt-2", summary: "傍晚一起喝咖啡", manual: true }),
          ],
          history: [],
        },
      },
    });
    render(<PlotTab />);

    expect(
      (screen.getByPlaceholderText("如：第一章 · 重逢") as HTMLInputElement)
        .value,
    ).toBe("第一章 · 重逢");
    expect(
      (screen.getByPlaceholderText("一段话概括当前剧情进展") as HTMLTextAreaElement)
        .value,
    ).toBe("两人重新联系上");
    expect(
      (screen.getByPlaceholderText(/未送出的生日礼物/) as HTMLTextAreaElement)
        .value,
    ).toBe("未送出的生日礼物\n下周的约见");
    expect(
      (screen.getByPlaceholderText(/青梅竹马/) as HTMLTextAreaElement).value,
    ).toBe("青梅竹马");

    // 倒序：越新的事件越靠上
    const summaries = screen
      .getAllByText(/早上在路口打招呼|傍晚一起喝咖啡/)
      .map((node) => node.textContent);
    expect(summaries).toEqual(["傍晚一起喝咖啡", "早上在路口打招呼"]);
    expect(screen.getByText("手动")).toBeTruthy();
    // 两条事件的重要度都是 4
    expect(screen.getAllByText("★★★★")).toHaveLength(2);
  });

  it("编辑表单后保存，写回 store（线索与关系按行拆分）", () => {
    useSessionStore.setState({
      plotStates: { [SESSION]: createEmptyPlotState(SESSION, NOW) },
    });
    render(<PlotTab />);

    fireEvent.change(screen.getByPlaceholderText("如：第一章 · 重逢"), {
      target: { value: "第二章 · 告白" },
    });
    fireEvent.change(screen.getByPlaceholderText("一段话概括当前剧情进展"), {
      target: { value: "他决定说出心意" },
    });
    fireEvent.change(screen.getByPlaceholderText(/未送出的生日礼物/), {
      target: { value: "礼物还没送出去\n\n约好周末见面" },
    });
    fireEvent.change(screen.getByPlaceholderText(/青梅竹马/), {
      target: { value: "青梅竹马" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存状态卡" }));

    const saved = useSessionStore.getState().plotStates[SESSION]!;
    expect(saved.chapter).toBe("第二章 · 告白");
    expect(saved.synopsis).toBe("他决定说出心意");
    // 空行被丢掉
    expect(saved.openThreads).toEqual(["礼物还没送出去", "约好周末见面"]);
    expect(saved.relations).toEqual([
      { characterId: CHAR, label: "青梅竹马" },
    ]);
  });

  it("时间线可以手动加事件（回车提交，输入框清空）", () => {
    useSessionStore.setState({
      plotStates: { [SESSION]: createEmptyPlotState(SESSION, NOW) },
    });
    render(<PlotTab />);

    const input = screen.getByPlaceholderText("手动记录一个事件…");
    fireEvent.change(input, { target: { value: "她把伞留给了他" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const events = useSessionStore.getState().plotStates[SESSION]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("她把伞留给了他");
    expect(events[0]!.manual).toBe(true);
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("她把伞留给了他")).toBeTruthy();
  });

  it("还没有状态卡时手动加事件也能落地（首次整理之前也不能丢）", () => {
    render(<PlotTab />);

    const input = screen.getByPlaceholderText("手动记录一个事件…");
    fireEvent.change(input, { target: { value: "第一次线下见面" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const state = useSessionStore.getState().plotStates[SESSION];
    expect(state).toBeDefined();
    expect(state!.events.map((event) => event.summary)).toEqual([
      "第一次线下见面",
    ]);
  });

  it("点删除事件会把那一条从时间线移除", () => {
    useSessionStore.setState({
      plotStates: {
        [SESSION]: {
          ...createEmptyPlotState(SESSION, NOW),
          events: [makeEvent({ id: "evt-1", summary: "两人在咖啡馆重逢" })],
        },
      },
    });
    render(<PlotTab />);

    fireEvent.click(screen.getByLabelText("删除事件"));

    expect(useSessionStore.getState().plotStates[SESSION]!.events).toEqual([]);
    expect(screen.queryByText("两人在咖啡馆重逢")).toBeNull();
  });

  it("回滚把状态卡退回上一版（事件不受影响）", () => {
    useSessionStore.setState({
      plotStates: { [SESSION]: createEmptyPlotState(SESSION, NOW) },
    });
    render(<PlotTab />);

    const chapterInput = screen.getByPlaceholderText("如：第一章 · 重逢");
    fireEvent.change(chapterInput, { target: { value: "第一章" } });
    fireEvent.click(screen.getByRole("button", { name: "保存状态卡" }));
    fireEvent.change(chapterInput, { target: { value: "第二章" } });
    fireEvent.click(screen.getByRole("button", { name: "保存状态卡" }));

    expect(useSessionStore.getState().plotStates[SESSION]!.chapter).toBe(
      "第二章",
    );
    expect(
      (screen.getByRole("button", { name: /回滚/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /回滚/ }));

    expect(useSessionStore.getState().plotStates[SESSION]!.chapter).toBe(
      "第一章",
    );
    // 表单跟着回滚后的值刷新
    expect((chapterInput as HTMLInputElement).value).toBe("第一章");
  });

  it("显示「本次更新」：后台整理改了哪几项，一行一处", () => {
    const base = createEmptyPlotState(SESSION, NOW);
    useSessionStore.setState({
      plotStates: {
        [SESSION]: {
          ...base,
          chapter: "第二章",
          scene: "回家路上",
          openThreads: ["下周三一起吃饭"],
          relations: [{ characterId: CHAR, label: "开始有点心动" }],
          // applyDigest 在改动前压的那一版
          history: [
            {
              chapter: "第二章",
              scene: "美术馆",
              timeLabel: "",
              location: "",
              synopsis: "",
              openThreads: ["周六的展还没定下来"],
              relations: [{ characterId: CHAR, label: "关系缓和" }],
              savedAt: NOW - 60000,
            },
          ],
          updatedAt: NOW,
        },
      },
    });
    render(<PlotTab />);

    const diff = document.querySelector(".zhichi-plot-tab__diff");
    expect(diff).not.toBeNull();
    const text = diff!.textContent ?? "";
    expect(text).toContain("本次更新");
    expect(text).toContain("场景");
    expect(text).toContain("美术馆");
    expect(text).toContain("回家路上");
    expect(text).toContain("新增线索");
    expect(text).toContain("下周三一起吃饭");
    expect(text).toContain("了结线索");
    expect(text).toContain("周六的展还没定下来");
    expect(text).toContain("开始有点心动");
  });

  it("没有上一版快照时不显示「本次更新」（没什么可对比的）", () => {
    useSessionStore.setState({
      plotStates: {
        [SESSION]: {
          ...createEmptyPlotState(SESSION, NOW),
          chapter: "第一章",
        },
      },
    });
    render(<PlotTab />);

    expect(document.querySelector(".zhichi-plot-tab__diff")).toBeNull();
  });

  it("清空会移除本会话的剧情状态", () => {
    useSessionStore.setState({
      plotStates: {
        [SESSION]: {
          ...createEmptyPlotState(SESSION, NOW),
          chapter: "第一章",
        },
      },
    });
    render(<PlotTab />);

    fireEvent.click(screen.getByRole("button", { name: /清空/ }));

    expect(useSessionStore.getState().plotStates[SESSION]).toBeUndefined();
    expect((screen.getByPlaceholderText("如：第一章 · 重逢") as HTMLInputElement).value).toBe("");
  });
});
