/**
 * @file backupRunner.test.ts
 * 备份组装层：读快照（**绝不能带上 API Key**）、导出、导入合并。
 *
 * core 的 BackupFile 已经测过"构造/解析/合并"的纯逻辑，
 * 这里测的是组装层这段：从 store 里读什么、往 store 里写什么。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ICharacterProfile, IBackupFile } from "@wechat-rp/shared-types";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import {
  buildBackupText,
  exportBackupToFile,
  importBackupFromFile,
  readLocalSnapshot,
} from "../backupRunner";

const downloads: Array<{ text: string; filename: string }> = [];
vi.mock("../download", () => ({
  downloadTextFile: (text: string, filename: string) => {
    downloads.push({ text, filename });
  },
  sanitizeFileName: (name: string) => name,
}));

const NOW = new Date(2026, 8, 13, 15, 20, 0).getTime();
const CHAR = "char-1";

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

/** jsdom 的 File 没有 text()，补一个测试替身（与 characterCardRunner 测试同一套路）。 */
function textFile(name: string, content: string): File {
  return {
    name,
    type: "application/json",
    size: content.length,
    text: async () => content,
  } as unknown as File;
}

beforeEach(() => {
  downloads.length = 0;
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    contacts: {},
    sessions: {},
    promptTemplates: {},
    memories: {},
    loreEntries: {},
    plotStates: {},
    activeSessionId: null,
    apiKey: "sk-测试用的假钥匙",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("readLocalSnapshot / buildBackupText", () => {
  it("快照里**不含 API Key**（它只驻留内存，绝不落盘）", () => {
    const snapshot = readLocalSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain("sk-测试用的假钥匙");
    expect(
      Object.prototype.hasOwnProperty.call(snapshot, "apiKey"),
    ).toBe(false);
  });

  it("导出的备份文本是完整的备份文件结构", () => {
    const text = buildBackupText(NOW);
    const parsed = JSON.parse(text) as IBackupFile;

    expect(parsed.format).toContain("zhichi");
    expect(parsed.data.characters[CHAR]!.displayName).toBe("苏晚晴");
    expect(parsed.exportedAt).toBe(NOW);
    // 安全兜底：整份文件里搜不到 key
    expect(text).not.toContain("sk-测试用的假钥匙");
  });

  it("导出到文件：文件名带日期，回执里有统计", () => {
    const counts = exportBackupToFile(NOW);

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe("zhichi-backup-20260913-152000.json");
    expect(counts.characters).toBe(1);
  });
});

describe("importBackupFromFile", () => {
  it("导入备份：新角色合并进来，本地原有数据保留", async () => {
    const incoming = JSON.parse(buildBackupText(NOW)) as IBackupFile;
    incoming.data.characters["char-2"] = { ...profile, id: "char-2", displayName: "林笑笑" };
    useSessionStore.setState({ characters: { [CHAR]: profile } });

    const result = await importBackupFromFile(
      textFile("backup.json", JSON.stringify(incoming)),
    );

    expect(result.ok).toBe(true);
    const names = Object.values(useSessionStore.getState().characters).map(
      (c) => c.displayName,
    );
    expect(names).toContain("苏晚晴");
    expect(names).toContain("林笑笑");
  });

  it("坏文件给可读提示，不动本地数据", async () => {
    const before = useSessionStore.getState().characters;
    const result = await importBackupFromFile(textFile("bad.json", "不是 JSON"));

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(useSessionStore.getState().characters).toEqual(before);
  });

  it("「关于你」**进得了备份也回得来**（回归：早先导出再导入会整段丢）", async () => {
    useSessionStore.setState({
      userProfile: { displayName: "小满", bio: "25 岁，程序员，养了一只叫团团的猫" },
      digestReports: {
        s1: {
          at: NOW,
          messageCount: 20,
          added: 3,
          replaced: 1,
          conflicts: 0,
          events: 2,
        },
      },
    });

    // 导出 → 文本
    const text = buildBackupText(NOW);
    const parsed = JSON.parse(text) as IBackupFile;
    expect(parsed.data.userProfile?.displayName).toBe("小满");
    expect(parsed.data.digestReports?.s1?.added).toBe(3);

    // 换一台"干净机器"：把本地这两项清掉，再导入
    useSessionStore.setState({
      userProfile: { displayName: "我", bio: "" },
      digestReports: {},
    });
    const result = await importBackupFromFile(textFile("backup.json", text));

    expect(result.ok).toBe(true);
    const after = useSessionStore.getState();
    expect(after.userProfile.displayName).toBe("小满");
    expect(after.userProfile.bio).toContain("团团");
    expect(after.digestReports.s1?.added).toBe(3);
  });

  it("老备份文件里没有这两项时，不会把本地的覆盖成空的", async () => {
    useSessionStore.setState({
      userProfile: { displayName: "小满", bio: "本地写的" },
      digestReports: {},
    });
    const legacy = JSON.parse(buildBackupText(NOW)) as {
      data: Record<string, unknown>;
    };
    delete legacy.data.userProfile;
    delete legacy.data.digestReports;

    const result = await importBackupFromFile(
      textFile("legacy.json", JSON.stringify(legacy)),
    );

    expect(result.ok).toBe(true);
    expect(useSessionStore.getState().userProfile.displayName).toBe("小满");
  });
});
