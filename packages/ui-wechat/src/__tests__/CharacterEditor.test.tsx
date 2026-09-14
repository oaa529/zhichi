/**
 * @file CharacterEditor.test.tsx
 * 角色编辑器的「AI 生成」入口：只在注入了生成器时出现，生成结果直接填表。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ICharacterDraft } from "@wechat-rp/core";
import { CharacterEditor } from "../components/CharacterEditor";
import type { ICharacterGenOutcome } from "../components/CharacterEditor";
import { useSessionStore } from "../store/sessionStore";
import type {
  CharacterEmotion,
  ICharacterProfile,
} from "@wechat-rp/shared-types";

/**
 * 缩放的读写依赖 canvas（jsdom 不支持），这里只关心"调用了几次、参数是什么"。
 * 返回带尺寸标记的假 data URL，方便断言缩略图与大图分别生成了。
 */
vi.mock("../utils/imageFile", () => ({
  readImageAsDataUrl: vi.fn(
    async (_file: File, maxEdge = 256) => `data:image/png;base64,edge-${maxEdge}`,
  ),
}));

const profile: ICharacterProfile = {
  id: "char-1",
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

/** 删除功能的用例需要 store 里真的有一个角色。 */
function seedCharacter(): void {
  useSessionStore.setState({
    characters: { [profile.id]: profile },
    contacts: {},
    sessions: {},
    activeSessionId: null,
    memories: { [profile.id]: [] },
    loreEntries: {},
    plotStates: {},
  });
}

const DRAFT: ICharacterDraft = {
  displayName: "林夏知",
  bio: "高中同桌，嘴硬心软的猫奴",
  archetype: "playful",
  background: "高中三年同桌，总把胳膊肘压在你课本上。",
  personality: "嘴硬心软，嘴上嫌弃手却很诚实。",
  speechStyle: "短句，爱用反问和「啧」开头。",
  worldSetting: "现代都市，同一家公司。",
  greeting: "啧，你又把咖啡洒桌上了是吧？",
  examples: "用户：谢谢\n林夏知：谁要谢你。",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CharacterEditor · AI 生成", () => {
  it("没有注入生成器时不显示这块入口", () => {
    render(<CharacterEditor editingCharacterId={null} onClose={() => {}} />);
    expect(screen.queryByText("AI 生成角色")).toBeNull();
  });

  it("注入生成器后显示入口与说明", () => {
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByText("AI 生成角色")).toBeTruthy();
    expect(screen.getByPlaceholderText(/高中同桌/)).toBeTruthy();
  });

  it("生成成功后把草稿填进表单（名字/简介/开场白/提示词）", async () => {
    const onGenerate = vi.fn(
      async (): Promise<ICharacterGenOutcome> => ({
        ok: true,
        message: "已生成「林夏知」，可以直接用，也可以改。",
        draft: DRAFT,
      }),
    );
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );

    const input = screen.getByPlaceholderText(/高中同桌/);
    fireEvent.change(input, { target: { value: "高中同桌，傲娇但细心" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "生成" }));
    });

    expect(onGenerate).toHaveBeenCalledWith(
      "高中同桌，傲娇但细心",
      // 现在会带上进度回调与取消信号
      expect.objectContaining({
        onProgress: expect.any(Function),
        signal: expect.anything(),
      }),
    );
    // 表单被填充
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe(
      "林夏知",
    );
    expect((screen.getByLabelText("简介") as HTMLInputElement).value).toBe(
      "高中同桌，嘴硬心软的猫奴",
    );
    expect(
      (screen.getByLabelText("开场白") as HTMLTextAreaElement).value,
    ).toBe("啧，你又把咖啡洒桌上了是吧？");

    const promptArea = screen.getByPlaceholderText(/你是林夏知/) as HTMLTextAreaElement;
    expect(promptArea.value).toContain("【身份背景】");
    expect(promptArea.value).toContain("【示例对话】");
    // 生成结果提示
    expect(screen.getByRole("status").textContent).toContain("已生成");
  });

  it("生成失败时给出提示且不动表单", async () => {
    const onGenerate = vi.fn(
      async (): Promise<ICharacterGenOutcome> => ({
        ok: false,
        message: "当前是本地演示模式，先在设置里配好 API 才能用 AI 生成。",
      }),
    );
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/高中同桌/), {
      target: { value: "随便写点什么" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "生成" }));
    });

    expect(screen.getByRole("status").textContent).toContain("本地演示模式");
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe("");
  });

  it("生成过程中显示进度与取消按钮（等待不再像卡死）", async () => {
    // 手动控制 promise：先让界面停在"生成中"
    let resolveGen: (value: ICharacterGenOutcome) => void = () => {};
    let progress: ((p: { receivedChars: number; name: string | null }) => void) | undefined;
    const onGenerate = vi.fn((_description: string, hooks?: { onProgress?: typeof progress }) => {
      progress = hooks?.onProgress;
      return new Promise<ICharacterGenOutcome>((resolve) => {
        resolveGen = resolve;
      });
    });

    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/高中同桌/), {
      target: { value: "高中同桌" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    // 还没收到任何内容时：只有一句"正在生成…"
    expect(screen.getByRole("status").textContent).toContain("正在生成…");
    // 生成中主按钮变成"取消"
    expect(screen.getByRole("button", { name: "取消生成" })).toBeTruthy();

    // 收到一段流式输出（含角色名）后，进度条把它显示出来
    await act(async () => {
      progress?.({ receivedChars: 180, name: "林夏知" });
    });
    expect(screen.getByRole("status").textContent).toContain("正在生成「林夏知」");
    expect(screen.getByRole("status").textContent).toContain("已接收 180 字");

    await act(async () => {
      resolveGen({ ok: false, message: "已取消生成。" });
    });
    expect(screen.getByRole("status").textContent).toContain("已取消生成");
    expect(screen.getByRole("button", { name: "生成" })).toBeTruthy();
  });

  it("点「取消」会把中断信号传给生成器", async () => {
    let capturedSignal: AbortSignal | undefined;
    const onGenerate = vi.fn(
      (_description: string, hooks?: { signal?: AbortSignal }) => {
        capturedSignal = hooks?.signal;
        return new Promise<ICharacterGenOutcome>(() => {
          // 永不 resolve：模拟还在生成
        });
      },
    );
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/高中同桌/), {
      target: { value: "随便写点什么" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(capturedSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("描述为空时生成按钮不可点", () => {
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "生成" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("CharacterEditor · 生成多版本", () => {
  /** 造一版草稿（只关心名字，方便断言表单切到哪一版）。 */
  function draftNamed(name: string): ICharacterDraft {
    return { ...DRAFT, displayName: name, greeting: `${name} 的开场白` };
  }

  it("生成两版后出现版本导航，表单显示最新一版", async () => {
    const drafts = [draftNamed("第一版"), draftNamed("第二版")];
    let call = 0;
    const onGenerate = vi.fn(async (): Promise<ICharacterGenOutcome> => ({
      ok: true,
      message: "已生成",
      draft: drafts[call++]!,
    }));
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/高中同桌/), {
      target: { value: "高中同桌" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "生成" }));
    });
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe("第一版");
    // 只有一版时不显示导航
    expect(screen.queryByText(/第 1\/1 版/)).toBeNull();

    // 再来一版
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再生成一版" }));
    });
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe("第二版");
    expect(screen.getByText("第 2/2 版")).toBeTruthy();
  });

  it("可以在生成过的两版之间来回切（表单跟着换）", async () => {
    const drafts = [draftNamed("第一版"), draftNamed("第二版")];
    let call = 0;
    const onGenerate = vi.fn(async (): Promise<ICharacterGenOutcome> => ({
      ok: true,
      message: "已生成",
      draft: drafts[call++]!,
    }));
    render(
      <CharacterEditor
        editingCharacterId={null}
        onClose={() => {}}
        onGenerate={onGenerate}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/高中同桌/), {
      target: { value: "高中同桌" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "生成" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再生成一版" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上一版" }));
    });
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe("第一版");
    expect(
      (screen.getByLabelText("开场白") as HTMLTextAreaElement).value,
    ).toBe("第一版 的开场白");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下一版" }));
    });
    expect((screen.getByLabelText("角色名") as HTMLInputElement).value).toBe("第二版");
  });
});

describe("CharacterEditor · 情绪覆盖提示", () => {
  /** 造一个带指定情绪立绘的角色。 */
  function seedWithSprites(emotions: ReadonlyArray<CharacterEmotion>): void {
    useSessionStore.setState({
      characters: {
        [profile.id]: {
          ...profile,
          visualMetadata: {
            ...profile.visualMetadata,
            sprites: emotions.map((emotion) => ({
              emotion,
              url: `data:image/svg+xml,${emotion}`,
            })),
          },
        },
      },
    });
  }

  it("缺情绪时提示缺哪几种", () => {
    seedWithSprites(["neutral", "happy"]);
    render(<CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />);

    const hint = screen.getByRole("status").textContent ?? "";
    expect(hint).toContain("已覆盖 2/8 种");
    expect(hint).toContain("缺：");
    expect(hint).toContain("难过");
  });

  it("全覆盖时给一句肯定，不再列缺口", () => {
    seedWithSprites([
      "neutral",
      "happy",
      "sad",
      "angry",
      "shy",
      "surprised",
      "thinking",
      "sleepy",
    ]);
    render(<CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />);

    const hint = screen.getByRole("status").textContent ?? "";
    expect(hint).toContain("全部 8 种");
    expect(hint).not.toContain("缺：");
  });

  it("一张立绘都没有时不显示覆盖提示（不吓唬新用户）", () => {
    useSessionStore.setState({ characters: { [profile.id]: profile } });
    render(<CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />);
    expect(screen.queryByText(/情绪已覆盖/)).toBeNull();
  });
});

describe("CharacterEditor · 立绘缩略图", () => {
  it("上传立绘时同时生成 96px 缩略图（这个字段此前只有读没有写）", async () => {
    seedCharacter();
    const { container } = render(
      <CharacterEditor editingCharacterId={null} onClose={() => {}} />,
    );

    // 通过"添加立绘"的 label 找到它的文件输入
    const label = screen.getByText("+ 添加立绘").closest("label");
    const input = label?.querySelector("input[type='file']") as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["x"], "sprite.png", { type: "image/png" })] },
      });
    });

    fireEvent.change(screen.getByLabelText("角色名"), {
      target: { value: "测试角色" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存角色/ }));

    const saved = Object.values(useSessionStore.getState().characters).find(
      (character) => character.displayName === "测试角色",
    );
    expect(saved).toBeTruthy();
    const sprite = saved!.visualMetadata.sprites[0]!;
    expect(sprite.url).toBe("data:image/png;base64,edge-512");
    expect(sprite.thumbnailUrl).toBe("data:image/png;base64,edge-96");
    // 有立绘就该允许"固定立绘"
    expect(saved!.visualMetadata.supportsPinSprite).toBe(true);
    void container;
  });
});

describe("CharacterEditor · 最终提示词预览", () => {
  it("点一下能看到拼装结果（角色卡 + 人设文本 + 关于你 + 风格/情绪/引用）", () => {
    useSessionStore
      .getState()
      .setUserProfile({ displayName: "小满", bio: "程序员，养猫" });
    render(<CharacterEditor editingCharacterId={null} onClose={() => {}} />);

    // 默认收起
    expect(document.querySelector(".zhichi-char-editor__preview")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("给角色起个名字"), {
      target: { value: "林夏知" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览最终提示词" }));

    const text =
      document.querySelector(".zhichi-char-editor__preview")!.textContent ?? "";
    expect(text).toContain("你是林夏知");
    expect(text).toContain("【关于对方】");
    expect(text).toContain("小满");
    expect(text).toContain("【回复风格】");
    expect(text).toContain("【情绪标记】");
    expect(text).toContain("【引用对方的话】");
  });

  it("人设文本区写的内容会出现在预览里（与保存落库同源）", () => {
    render(<CharacterEditor editingCharacterId={null} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("给角色起个名字"), {
      target: { value: "林夏知" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/第一人称与用户进行自然对话/),
      { target: { value: "说话要短，爱用反问句。" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "预览最终提示词" }));

    expect(
      document.querySelector(".zhichi-char-editor__preview")!.textContent,
    ).toContain("说话要短，爱用反问句。");
  });
});

describe("CharacterEditor · 忙碌时段", () => {
  it("没配时显示提示，不显示任何时段行", () => {
    render(<CharacterEditor editingCharacterId={null} onClose={() => {}} />);

    expect(screen.getByText(/没配就是不忙/)).toBeTruthy();
    expect(screen.queryByLabelText("忙碌时段 1 开始时间")).toBeNull();
  });

  it("添加一行 → 改时间与文案 → 保存进角色档案的 busyPeriods", () => {
    seedCharacter();
    render(
      <CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /添加忙碌时段/ }));
    fireEvent.change(screen.getByLabelText("忙碌时段 1 开始时间"), {
      target: { value: "14:00" },
    });
    fireEvent.change(screen.getByLabelText("忙碌时段 1 结束时间"), {
      target: { value: "18:00" },
    });
    fireEvent.change(screen.getByLabelText("忙碌时段 1 文案"), {
      target: { value: "在上班" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(
      useSessionStore.getState().characters[profile.id]?.schedule.busyPeriods,
    ).toEqual([{ start: "14:00", end: "18:00", label: "在上班" }]);
  });

  it("删掉之后保存，档案里不留空数组（卡片里少一个无意义字段）", () => {
    seedCharacter();
    render(
      <CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /添加忙碌时段/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除忙碌时段 1" }));
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    expect(
      useSessionStore.getState().characters[profile.id]?.schedule.busyPeriods,
    ).toBeUndefined();
  });
});

describe("CharacterEditor · 删除角色", () => {
  it("新建模式没有删除入口（还没保存过的东西谈不上删除）", () => {
    render(<CharacterEditor editingCharacterId={null} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "删除角色" })).toBeNull();
  });

  it("编辑模式点删除：确认后角色连同数据一起删掉，并关闭面板", () => {
    seedCharacter();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onClose = vi.fn();
    render(<CharacterEditor editingCharacterId={profile.id} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));

    expect(useSessionStore.getState().characters[profile.id]).toBeUndefined();
    expect(useSessionStore.getState().memories[profile.id]).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("确认框点取消时什么都不删、也不关闭面板", () => {
    seedCharacter();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onClose = vi.fn();
    render(<CharacterEditor editingCharacterId={profile.id} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));

    expect(useSessionStore.getState().characters[profile.id]).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("确认框把「会一起删掉什么」写清楚（不是一句干巴巴的确认）", () => {
    seedCharacter();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CharacterEditor editingCharacterId={profile.id} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "删除角色" }));

    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("苏晚晴");
    expect(message).toContain("聊天记录");
    expect(message).toContain("无法恢复");
  });
});
