/**
 * @file transcriptRunner.test.ts
 * 导出聊天记录：消息来源选择（活跃会话 / 后台会话）、空会话与异常处理。
 *
 * 这是组装层第一次进测试——它读两个 store、拼文件名、触发下载，
 * 以前只能靠浏览器点一遍。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { useChatStore, useSessionStore } from "@wechat-rp/ui-wechat";
import { exportSessionTranscript } from "../transcriptRunner";

// 下载要碰 DOM 与 Blob，这里只关心"生成了什么内容、叫什么文件名"
const downloads: Array<{ text: string; filename: string }> = [];
vi.mock("../download", () => ({
  downloadTextFile: (text: string, filename: string) => {
    downloads.push({ text, filename });
  },
  sanitizeFileName: (name: string) =>
    name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled",
}));

const NOW = new Date(2026, 8, 13, 15, 20, 0).getTime();
const CHAR = "char-1";
const ACTIVE = "s-active";
const BACKGROUND = "s-bg";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "林笑笑",
  bio: "",
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

function makeSession(id: string, name: string) {
  return {
    id,
    type: "single" as const,
    participantIds: [CHAR, "user"],
    displayName: name,
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function message(id: string, senderId: string, text: string): IMessage {
  return {
    id,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? CHAR : "user",
    sessionId: ACTIVE,
    text,
    timestamp: NOW,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
  };
}

beforeEach(() => {
  downloads.length = 0;
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    sessions: {
      [ACTIVE]: makeSession(ACTIVE, "林笑笑"),
      [BACKGROUND]: makeSession(BACKGROUND, "后台角色"),
    },
    activeSessionId: ACTIVE,
    sessionRuntimes: {},
  });
  useChatStore.setState({
    messages: [
      { message: message("m1", "user", "在吗"), revealed: true, pending: false },
      { message: message("m2", CHAR, "在的"), revealed: true, pending: false },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("exportSessionTranscript", () => {
  it("活跃会话从 chatStore 取消息，生成 Markdown 并下载", () => {
    const result = exportSessionTranscript(ACTIVE, NOW);

    expect(result.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe("zhichi-chat-林笑笑-20260913.md");
    expect(downloads[0]!.text).toContain("# 与 林笑笑 的聊天记录");
    expect(downloads[0]!.text).toContain("在吗");
    expect(downloads[0]!.text).toContain("在的");
  });

  it("导出的署名用「关于你」里填的称呼（没填就用「我」）", () => {
    useSessionStore.getState().setUserProfile({ displayName: "小满" });
    exportSessionTranscript(ACTIVE, NOW);

    expect(downloads[0]!.text).toContain("**小满**");
    expect(downloads[0]!.text).not.toContain("**我**");
  });

  it("非活跃会话从自己的运行时快照取消息", () => {
    useSessionStore.getState().saveSessionRuntime(BACKGROUND, {
      messages: [
        { message: message("b1", CHAR, "后台说的一句"), revealed: true, pending: false },
      ],
      presence: "online",
      presenceText: "在线",
      phase: "completed",
      typingIndicator: { active: false, estimatedRemainingMs: 0 },
      pendingCount: 0,
      simulationConfig: {
        realismEnabled: true,
        typingSpeedCpm: "normal",
        hesitationProbability: 0.15,
        typoRate: 0,
        fragmentationThresholdChars: 24,
        scheduleAwarenessEnabled: true,
        typingIndicatorEnabled: true,
        typoAutoCorrectEnabled: true,
        maxInterChunkDelayMs: 3500,
      },
    });

    const result = exportSessionTranscript(BACKGROUND, NOW);

    expect(result.ok).toBe(true);
    expect(downloads[0]!.text).toContain("后台说的一句");
    // 活跃会话的消息不该混进来
    expect(downloads[0]!.text).not.toContain("在吗");
  });

  it("会话不存在时给出可读提示，不下载", () => {
    const result = exportSessionTranscript("不存在的会话", NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("找不到");
    expect(downloads).toHaveLength(0);
  });

  it("会话还没有消息时不产出一个空文件", () => {
    useChatStore.setState({ messages: [] });
    const result = exportSessionTranscript(ACTIVE, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("还没有消息");
    expect(downloads).toHaveLength(0);
  });

  it("文件名里的非法字符被替换，不会拼出坏路径", () => {
    useSessionStore.setState({
      characters: {
        [CHAR]: { ...profile, displayName: "林/笑:笑?" },
      },
    });
    const result = exportSessionTranscript(ACTIVE, NOW);

    expect(result.ok).toBe(true);
    expect(downloads[0]!.filename).toBe("zhichi-chat-林_笑_笑_-20260913.md");
  });
});
