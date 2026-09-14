/**
 * @file BackupFile.test.ts
 * 数据备份的构造 / 解析 / 合并测试。
 */

import { describe, it, expect } from "vitest";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from "@wechat-rp/shared-types";
import type {
  IBackupPayload,
  ICharacterProfile,
  IMemory,
  IPlotEvent,
  IPlotState,
  ISession,
} from "@wechat-rp/shared-types";
import {
  buildBackup,
  countBackupMessages,
  mergeBackup,
  mergeRuntimeMessages,
  parseBackup,
  serializeBackup,
} from "../backup/BackupFile";

const NOW = 1_700_000_000_000;

function makeSession(id: string, overrides: Partial<ISession> = {}): ISession {
  return {
    id,
    type: "single",
    participantIds: ["char-1", "user"],
    displayName: "苏晚晴",
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCharacter(id: string): ICharacterProfile {
  return {
    id,
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
}

function makeMemory(id: string, content: string): IMemory {
  return {
    id,
    characterId: "char-1",
    kind: "fact",
    content,
    keywords: [],
    importance: 3,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
  };
}

function makePlot(
  sessionId: string,
  updatedAt: number,
  events: ReadonlyArray<IPlotEvent> = [],
): IPlotState {
  return {
    sessionId,
    chapter: "第一章",
    scene: "咖啡馆",
    timeLabel: "傍晚",
    location: "街角",
    relations: [],
    openThreads: [],
    synopsis: "两人重逢",
    events,
    history: [],
    updatedAt,
  };
}

/** 造一份最小可用的备份内容，再按需覆盖字段。 */
function makePayload(overrides: Partial<IBackupPayload> = {}): IBackupPayload {
  return {
    sessions: {},
    activeSessionId: null,
    sessionRuntimes: {},
    drafts: {},
    contacts: {},
    characters: {},
    promptTemplates: {},
    apiConfig: {
      adapter: "mock",
      provider: "mock",
      baseURL: "",
      model: "mock-1",
      temperature: 0.8,
      maxTokens: 1024,
      maxRetries: 3,
      timeoutMs: 30000,
    },
    realtimeAIConfig: { enabled: false, intervalMs: 60000 },
    memories: {},
    loreEntries: {},
    plotStates: {},
    digestCursors: {},
    digestConfig: {
      enabled: true,
      threshold: 20,
      maxWindow: 60,
      maxInject: 10,
      maxEvents: 100,
      maxHistory: 5,
    },
    ...overrides,
  };
}

/** 造一条运行时消息（只保留备份关心的字段）。 */
function runtimeMessage(id: string, timestamp: number): unknown {
  return {
    message: {
      id,
      senderId: "user",
      recipientId: "char-1",
      sessionId: "s1",
      timestamp,
      chunkSequence: 0,
      emotion: "neutral",
      type: "text",
      text: id,
      sourceOffset: 0,
    },
    revealed: true,
    pending: false,
  };
}

function runtimeWithMessages(
  messages: ReadonlyArray<unknown>,
): IBackupPayload["sessionRuntimes"][string] {
  return {
    messages,
    presence: "online",
    presenceText: "在线",
    phase: "idle",
    typingIndicator: { active: false, estimatedRemainingMs: 0 },
    pendingCount: 0,
    simulationConfig: {
      realismEnabled: true,
      typingSpeedCpm: "normal",
      hesitationProbability: 0.1,
      typoRate: 0,
      fragmentationThresholdChars: 40,
      scheduleAwarenessEnabled: true,
      typingIndicatorEnabled: true,
      typoAutoCorrectEnabled: true,
      maxInterChunkDelayMs: 1200,
    },
  };
}

describe("buildBackup / countBackup", () => {
  it("统计会话、角色、记忆与消息数量", () => {
    const payload = makePayload({
      sessions: { s1: makeSession("s1"), s2: makeSession("s2") },
      characters: { "char-1": makeCharacter("char-1") },
      memories: { "char-1": [makeMemory("m1", "喜欢猫"), makeMemory("m2", "住上海")] },
      sessionRuntimes: {
        s1: runtimeWithMessages([
          runtimeMessage("msg-1", 1),
          runtimeMessage("msg-2", 2),
        ]),
        s2: runtimeWithMessages([runtimeMessage("msg-3", 3)]),
      },
    });

    const file = buildBackup(payload, NOW);
    expect(file.format).toBe("zhichi-backup");
    expect(file.version).toBe(1);
    expect(file.exportedAt).toBe(NOW);
    expect(file.counts).toEqual({
      sessions: 2,
      characters: 1,
      memories: 2,
      messages: 3,
    });
    expect(countBackupMessages(payload)).toBe(3);
  });

  it("空数据也能导出（计数全 0）", () => {
    const file = buildBackup(makePayload(), NOW);
    expect(file.counts).toEqual({
      sessions: 0,
      characters: 0,
      memories: 0,
      messages: 0,
    });
  });
});

describe("serializeBackup / parseBackup", () => {
  it("序列化后可原样解析回来（往返一致）", () => {
    const payload = makePayload({
      sessions: { s1: makeSession("s1") },
      activeSessionId: "s1",
      memories: { "char-1": [makeMemory("m1", "喜欢猫")] },
      sessionRuntimes: { s1: runtimeWithMessages([runtimeMessage("msg-1", 1)]) },
    });

    const text = serializeBackup(buildBackup(payload, NOW));
    const result = parseBackup(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.exportedAt).toBe(NOW);
    expect(result.file.data.activeSessionId).toBe("s1");
    expect(result.file.data.memories["char-1"]?.[0]?.content).toBe("喜欢猫");
    expect(result.file.data.sessionRuntimes.s1?.messages).toHaveLength(1);
  });

  it("空文件 / 纯空白 → empty", () => {
    expect(parseBackup("")).toEqual({ ok: false, error: "empty" });
    expect(parseBackup("   \n ")).toEqual({ ok: false, error: "empty" });
  });

  it("坏 JSON → not-json", () => {
    expect(parseBackup("{ 这不是 json ")).toEqual({
      ok: false,
      error: "not-json",
    });
  });

  it("无关 JSON / 缺 format → not-backup", () => {
    expect(parseBackup('{"hello":"world"}')).toEqual({
      ok: false,
      error: "not-backup",
    });
    expect(parseBackup('["数组不算备份"]')).toEqual({
      ok: false,
      error: "not-backup",
    });
    expect(
      parseBackup('{"format":"other-tool","version":1,"data":{}}'),
    ).toEqual({ ok: false, error: "not-backup" });
  });

  it("版本高于当前支持 → version-too-new", () => {
    expect(
      parseBackup('{"format":"zhichi-backup","version":99,"data":{}}'),
    ).toEqual({ ok: false, error: "version-too-new" });
  });

  it("缺 data 或 data 不是对象 → bad-payload", () => {
    expect(
      parseBackup('{"format":"zhichi-backup","version":1}'),
    ).toEqual({ ok: false, error: "bad-payload" });
    expect(
      parseBackup('{"format":"zhichi-backup","version":1,"data":"字符串"}'),
    ).toEqual({ ok: false, error: "bad-payload" });
  });

  it("缺字段的老备份按空值补齐，不报错", () => {
    const minimal = JSON.stringify({
      format: "zhichi-backup",
      version: 1,
      exportedAt: NOW,
      data: { sessions: { s1: makeSession("s1") } },
    });

    const result = parseBackup(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.file.data.sessions)).toEqual(["s1"]);
    expect(result.file.data.characters).toEqual({});
    expect(result.file.data.memories).toEqual({});
    expect(result.file.data.sessionRuntimes).toEqual({});
    expect(result.file.data.activeSessionId).toBeNull();
  });

  it("字段类型不符时丢弃该字段而不是整体失败", () => {
    const broken = JSON.stringify({
      format: "zhichi-backup",
      version: 1,
      data: {
        sessions: "不是对象",
        memories: { "char-1": [makeMemory("m1", "喜欢猫")] },
      },
    });

    const result = parseBackup(broken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data.sessions).toEqual({});
    expect(result.file.data.memories["char-1"]).toHaveLength(1);
  });
});

describe("mergeRuntimeMessages", () => {
  it("按消息 ID 去重并按时间升序", () => {
    const merged = mergeRuntimeMessages(
      [runtimeMessage("b", 200), runtimeMessage("c", 300)],
      [runtimeMessage("a", 100), runtimeMessage("c", 300)],
    );
    const ids = merged.map((item) =>
      (item as { message: { id: string } }).message.id,
    );
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("读不到 ID 的消息一律保留（宁重不丢）", () => {
    const merged = mergeRuntimeMessages([{ 坏数据: true }], [{ 也坏: 1 }]);
    expect(merged).toHaveLength(2);
  });
});

describe("mergeBackup", () => {
  /**
   * 守卫用例：往 `IBackupPayload` 加了可选字段，却忘了在 `normalizePayload`
   * 里放行——解析这一关就会把它丢掉，用户"导出→换机器→导入"后一脸茫然。
   * 这张表要随接口一起长，漏了就在这儿红。
   */
  const OPTIONAL_PAYLOAD_KEYS = [
    "loreEntries",
    "userProfile",
    "digestReports",
  ] as const;

  it("可选负载字段必须活过 parseBackup（少放行一个就等于换机器丢数据）", () => {
    const payload = makePayload({
      loreEntries: { "char-1": [] },
      userProfile: { displayName: "小满", bio: "养猫" },
      digestReports: {
        s1: {
          at: NOW,
          messageCount: 20,
          added: 2,
          replaced: 0,
          conflicts: 0,
          events: 1,
        },
      },
    });
    const raw = serializeBackup({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      counts: { sessions: 0, characters: 0, memories: 0, messages: 0 },
      data: payload,
    });

    const parsed = parseBackup(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const key of OPTIONAL_PAYLOAD_KEYS) {
      expect(
        parsed.file.data[key],
        `IBackupPayload.${key} 被 parseBackup 丢了`,
      ).not.toBeUndefined();
    }
    expect(parsed.file.data.userProfile?.bio).toBe("养猫");
  });

  it("同 ID 以导入文件为准，新 ID 追加", () => {
    const local = makePayload({
      sessions: { s1: makeSession("s1", { displayName: "本地名" }) },
      characters: { "char-1": makeCharacter("char-1") },
    });
    const incoming = makePayload({
      sessions: {
        s1: makeSession("s1", { displayName: "备份名" }),
        s2: makeSession("s2"),
      },
      characters: { "char-2": makeCharacter("char-2") },
    });

    const merged = mergeBackup(local, incoming);
    expect(Object.keys(merged.sessions).sort()).toEqual(["s1", "s2"]);
    expect(merged.sessions.s1?.displayName).toBe("备份名");
    expect(Object.keys(merged.characters).sort()).toEqual([
      "char-1",
      "char-2",
    ]);
  });

  it("记忆按 ID 求并集，两边都不丢", () => {
    const local = makePayload({
      memories: { "char-1": [makeMemory("m1", "本地记忆")] },
    });
    const incoming = makePayload({
      memories: { "char-1": [makeMemory("m2", "备份记忆")] },
    });

    const merged = mergeBackup(local, incoming);
    const ids = merged.memories["char-1"]?.map((m) => m.id).sort();
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("剧情事件求并集，状态卡取更新时间更晚的一份", () => {
    const localState = makePlot("s1", NOW + 1000, [
      {
        id: "e-local",
        summary: "本地事件",
        at: NOW,
        importance: 3,
        sourceMessageIds: [],
        manual: true,
      },
    ]);
    const incomingState = makePlot("s1", NOW, [
      {
        id: "e-backup",
        summary: "备份事件",
        at: NOW + 1,
        importance: 3,
        sourceMessageIds: [],
        manual: true,
      },
    ]);

    const merged = mergeBackup(
      makePayload({ plotStates: { s1: localState } }),
      makePayload({ plotStates: { s1: incomingState } }),
    );

    // 状态卡：本地更新更晚 → 保留本地
    expect(merged.plotStates.s1?.chapter).toBe("第一章");
    expect(merged.plotStates.s1?.updatedAt).toBe(NOW + 1000);
    // 事件：两条都在，且按时间升序
    expect(merged.plotStates.s1?.events.map((e) => e.id)).toEqual([
      "e-local",
      "e-backup",
    ]);
  });

  it("消息按 ID 去重合并，避免同一批消息存两份", () => {
    const merged = mergeBackup(
      makePayload({
        sessionRuntimes: {
          s1: runtimeWithMessages([
            runtimeMessage("msg-1", 100),
            runtimeMessage("msg-2", 200),
          ]),
        },
      }),
      makePayload({
        sessionRuntimes: {
          s1: runtimeWithMessages([
            runtimeMessage("msg-1", 100),
            runtimeMessage("msg-3", 300),
          ]),
        },
      }),
    );

    const ids = (
      merged.sessionRuntimes.s1?.messages as ReadonlyArray<{
        message: { id: string };
      }>
    ).map((item) => item.message.id);
    expect(ids).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("本地正在输入的草稿不会被导入覆盖", () => {
    const merged = mergeBackup(
      makePayload({ drafts: { s1: "打了一半的内容" } }),
      makePayload({ drafts: { s1: "备份里的旧草稿", s2: "新会话草稿" } }),
    );
    expect(merged.drafts.s1).toBe("打了一半的内容");
    expect(merged.drafts.s2).toBe("新会话草稿");
  });

  it("活跃会话：本地有效则保留，否则回退到导入文件，再否则取第一个会话", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");

    // 本地有效 → 保留本地
    expect(
      mergeBackup(
        makePayload({ sessions: { s1 }, activeSessionId: "s1" }),
        makePayload({ sessions: { s2 }, activeSessionId: "s2" }),
      ).activeSessionId,
    ).toBe("s1");

    // 本地指向已不存在的会话 → 用导入文件的
    expect(
      mergeBackup(
        makePayload({ sessions: { s2 }, activeSessionId: "已删除的会话" }),
        makePayload({ sessions: { s1 }, activeSessionId: "s1" }),
      ).activeSessionId,
    ).toBe("s1");

    // 两边都没有指定 → 取合并后的第一个会话
    expect(
      mergeBackup(
        makePayload({ sessions: { s2 } }),
        makePayload({ sessions: { s1 } }),
      ).activeSessionId,
    ).toBe("s1");
  });

  it("导入全空的备份不会破坏本地数据", () => {
    const local = makePayload({
      sessions: { s1: makeSession("s1") },
      activeSessionId: "s1",
      memories: { "char-1": [makeMemory("m1", "本地记忆")] },
      sessionRuntimes: { s1: runtimeWithMessages([runtimeMessage("msg-1", 1)]) },
    });

    const merged = mergeBackup(local, makePayload());
    expect(Object.keys(merged.sessions)).toEqual(["s1"]);
    expect(merged.activeSessionId).toBe("s1");
    expect(merged.memories["char-1"]).toHaveLength(1);
    expect(merged.sessionRuntimes.s1?.messages).toHaveLength(1);
  });
});
