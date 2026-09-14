/**
 * @file CharacterEditor.tsx
 * 角色编辑器。表单驱动 ICharacterProfile 创建/编辑。
 *
 * 内置 6 个 CharacterArchetype 预设模板，用户可基于模板快速创建或完全自定义。
 * 美化版：卡片式布局、头像预览、分组展示、图标装饰。
 */

import { memo, useState, useCallback, useEffect, useRef } from "react";
import type { FC, ChangeEvent } from "react";
import type { ICharacterDraft } from "@wechat-rp/core";
import { formatDraftAsPromptText } from "@wechat-rp/core";
import { useSessionStore } from "../store/sessionStore";
import { buildSystemPromptPreview } from "@wechat-rp/core";
import { buildCharacterTemplate } from "../utils/characterTemplate";
import { readImageAsDataUrl } from "../utils/imageFile";
import { EMOTION_LABELS } from "../utils/emotionLabel";
import type {
  ICharacterProfile,
  ICharacterSprite,
  CharacterArchetype,
  CharacterEmotion,
  ICharacterBusyPeriod,
  ICharacterSchedule,
  CharacterSleepReplyPolicy,
  IReplyStyle,
  ReplyLength,
} from "@wechat-rp/shared-types";
import { DEFAULT_REPLY_STYLE } from "@wechat-rp/shared-types";
import { Icon } from "./Icon";

export interface ICharacterEditorProps {
  /** 编辑模式时传入的现有角色 ID。null = 新建模式。 */
  readonly editingCharacterId?: string | null;
  /** 保存/取消回调。 */
  readonly onClose?: () => void;
  /** 导出当前角色为角色卡文件（仅编辑已有角色时可用）。 */
  readonly onExportCharacterCard?: (characterId: string) => void;
  /**
   * AI 生成角色草稿（由组装层注入；没配 API 或演示模式下不传，
   * 面板就不显示这块入口）。
   */
  readonly onGenerate?: (
    description: string,
    hooks?: ICharacterGenHooks,
  ) => Promise<ICharacterGenOutcome>;
}

/** 生成结果（形状与 core 的 ICharacterDraft 一致）。 */
export interface ICharacterGenOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly draft?: ICharacterDraft;
}

/** 生成过程的进度与取消句柄（组装层据此把流式输出转发回来）。 */
export interface ICharacterGenHooks {
  readonly onProgress?: (progress: {
    readonly receivedChars: number;
    readonly name: string | null;
  }) => void;
  readonly signal?: AbortSignal;
}

/** 立绘情绪选项（与引擎的情绪枚举一一对应）。 */
/** 情绪选项（中文标签与立绘查看器共用一份映射）。 */
const EMOTION_OPTIONS: ReadonlyArray<readonly [CharacterEmotion, string]> = (
  Object.keys(EMOTION_LABELS) as CharacterEmotion[]
).map((emotion) => [emotion, EMOTION_LABELS[emotion]] as const);

/** 回复长度档位（含给用户看的说明）。 */
const REPLY_LENGTH_OPTIONS: ReadonlyArray<
  readonly [ReplyLength, string, string]
> = [
  ["terse", "极简", "一句 10 字上下"],
  ["short", "简短", "1~2 句，30 字内"],
  ["medium", "适中", "2~4 句"],
  ["detailed", "详细", "多说几句"],
];

/** 预设模板。 */
const ARCHETYPE_PRESETS: Record<CharacterArchetype, Partial<ICharacterProfile> & { icon: string; label: string; desc: string }> = {
  energetic: {
    bio: "活泼好动的伙伴",
    icon: "⚡",
    label: "活泼",
    desc: "快速回复、爱用表情、话题跳跃",
    personalityTraits: {
      archetype: "energetic",
      typingSpeedMultiplier: 1.5,
      fragmentationBias: 0.7,
      hesitationProbability: 0.05,
      typoRate: 0.08,
      stickerFrequency: 0.3,
    },
  },
  gentle: {
    bio: "温润如水的知心人",
    icon: "🌸",
    label: "温柔",
    desc: "慢条斯理、关心体贴、偶尔犹豫",
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 0.85,
      fragmentationBias: 0.6,
      hesitationProbability: 0.18,
      typoRate: 0.04,
      stickerFrequency: 0.2,
    },
  },
  serious: {
    bio: "严肃认真的对话者",
    icon: "🎯",
    label: "严肃",
    desc: "逻辑清晰、少用表情、直接了当",
    personalityTraits: {
      archetype: "serious",
      typingSpeedMultiplier: 1.0,
      fragmentationBias: 0.2,
      hesitationProbability: 0.05,
      typoRate: 0.01,
      stickerFrequency: 0.05,
    },
  },
  playful: {
    bio: "顽皮爱闹的好友",
    icon: "😜",
    label: "顽皮",
    desc: "爱开玩笑、调皮捣蛋、表情刷屏",
    personalityTraits: {
      archetype: "playful",
      typingSpeedMultiplier: 1.3,
      fragmentationBias: 0.8,
      hesitationProbability: 0.1,
      typoRate: 0.12,
      stickerFrequency: 0.5,
    },
  },
  reserved: {
    bio: "内敛沉稳的倾听者",
    icon: "🌙",
    label: "内敛",
    desc: "字少言轻、深思熟虑、慢回复",
    personalityTraits: {
      archetype: "reserved",
      typingSpeedMultiplier: 0.7,
      fragmentationBias: 0.3,
      hesitationProbability: 0.3,
      typoRate: 0.02,
      stickerFrequency: 0.1,
    },
  },
  "night-owl": {
    bio: "夜猫子，深夜最活跃",
    icon: "🦉",
    label: "夜猫",
    desc: "作息颠倒、深夜活跃、凌晨话多",
    schedule: {
      wakeTime: "10:00",
      sleepTime: "03:00",
      scheduleEnabled: true,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "drowsy-burst",
    },
    personalityTraits: {
      archetype: "night-owl",
      typingSpeedMultiplier: 1.1,
      fragmentationBias: 0.5,
      hesitationProbability: 0.12,
      typoRate: 0.06,
      stickerFrequency: 0.25,
    },
  },
};

const ARCHETYPE_LIST = Object.entries(ARCHETYPE_PRESETS) as ReadonlyArray<
  [CharacterArchetype, typeof ARCHETYPE_PRESETS[CharacterArchetype]]
>;

export const CharacterEditor: FC<ICharacterEditorProps> = memo(
  ({ editingCharacterId, onClose, onExportCharacterCard, onGenerate }) => {
    const createCharacter = useSessionStore((s) => s.createCharacter);
    const updateCharacter = useSessionStore((s) => s.updateCharacter);
    const deleteCharacter = useSessionStore((s) => s.deleteCharacter);
    const promptTemplates = useSessionStore((s) => s.promptTemplates);
    const createPromptTemplate = useSessionStore((s) => s.createPromptTemplate);
  const updatePromptTemplate = useSessionStore((s) => s.updatePromptTemplate);
  const userProfile = useSessionStore((s) => s.userProfile);
    const existing = useSessionStore((s) =>
      editingCharacterId ? s.characters[editingCharacterId] : null,
    );

    const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
    const [bio, setBio] = useState(existing?.bio ?? "");
    /**
     * 开场白：新会话里角色主动说的第一句话。
     * 社区卡（SillyTavern）导入时会带过来，也可以在这里自己写。
     */
    const [greeting, setGreeting] = useState(existing?.greeting ?? "");
    const [avatarUrl, setAvatarUrl] = useState(existing?.visualMetadata.avatarUrl ?? "");
    const [archetype, setArchetype] = useState<CharacterArchetype>(
      existing?.personalityTraits.archetype ?? "gentle",
    );
    const [wakeTime, setWakeTime] = useState(existing?.schedule.wakeTime ?? "07:30");
    const [sleepTime, setSleepTime] = useState(existing?.schedule.sleepTime ?? "23:30");
    const [scheduleEnabled, setScheduleEnabled] = useState(
      existing?.schedule.scheduleEnabled ?? true,
    );
    const [sleepPolicy, setSleepPolicy] = useState<CharacterSleepReplyPolicy>(
      existing?.schedule.sleepReplyPolicy ?? "drowsy-burst",
    );
    /**
     * 忙碌时段（上课 / 上班 / 通勤）。
     *
     * 与睡眠的区别：睡着时看不到消息，忙着时看得到、只是没空细说——
     * 所以忙碌不拦回复，只让它更短、更"待会儿再聊"。
     */
    const [busyPeriods, setBusyPeriods] = useState<
      ReadonlyArray<ICharacterBusyPeriod>
    >(existing?.schedule.busyPeriods ?? []);
    /** 文本回复风格（长度档位 + 是否允许旁白）。 */
    const [replyStyle, setReplyStyle] = useState<IReplyStyle>(
      existing?.replyStyle ?? DEFAULT_REPLY_STYLE,
    );
    /** 立绘列表（跟着表单走，保存时写回角色档案）。 */
  const [sprites, setSprites] = useState<ReadonlyArray<ICharacterSprite>>(
    existing?.visualMetadata.sprites ?? [],
  );
  /** 是否展开"最终提示词预览"。 */
  const [previewOpen, setPreviewOpen] = useState(false);
    /** 图片处理失败的提示（选了非图片文件、解码失败等）。 */
    const [imageError, setImageError] = useState<string | null>(null);
    /** AI 生成：描述输入 + 进行中状态 + 结果提示。 */
    const [genDescription, setGenDescription] = useState("");
    const [genBusy, setGenBusy] = useState(false);
    const [genMessage, setGenMessage] = useState<string | null>(null);
    /** 生成进度：已接收字数 + 从流里读到的角色名（让等待可见）。 */
    const [genProgress, setGenProgress] = useState<{
      readonly receivedChars: number;
      readonly name: string | null;
    } | null>(null);
    /**
     * 是否已经等太久（模型先"想"再吐字）。
     *
     * 实测：推理型模型前十几秒只思考、不输出正文，这段时间界面若只显示
     * "正在生成…"，跟卡死没有区别。超过 5 秒就把话说明白。
     */
    const [genSlow, setGenSlow] = useState(false);
    /**
     * 本次面板打开期间生成过的草稿（按顺序）。
     *
     * 不满意时可以「再生成一版」而不丢掉上一版——两版之间能来回切着看，
     * 比"重新生成一次、上一版没了"实用得多；也刻意不做"一次生成 3 版"，
     * 那是 3 倍 token，用户未必需要。
     */
    const [genVersions, setGenVersions] = useState<{
      readonly list: ReadonlyArray<ICharacterDraft>;
      /** 当前显示的是第几版（-1 = 还没生成过）。 */
      readonly index: number;
    }>({ list: [], index: -1 });
    const genAbortRef = useRef<AbortController | null>(null);
    const [promptContent, setPromptContent] = useState(
      () =>
        (existing?.promptTemplateId
          ? useSessionStore.getState().promptTemplates[existing.promptTemplateId]
              ?.content
          : undefined) ?? "",
    );

    // 模板 hydration 可能晚于组件挂载：绑定模板到位后补一次回填
    useEffect(() => {
      if (promptContent) return;
      const boundId = existing?.promptTemplateId;
      if (!boundId) return;
      const content = promptTemplates[boundId]?.content;
      if (content) setPromptContent(content);
      // 仅在模板/角色变化时尝试回填
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [existing?.promptTemplateId, promptTemplates]);

    const handleArchetypeChange = useCallback((arch: CharacterArchetype) => {
      setArchetype(arch);
      const preset = ARCHETYPE_PRESETS[arch];
      if (preset?.bio && !bio) setBio(preset.bio);
      if (preset?.schedule && !existing) {
        setWakeTime(preset.schedule.wakeTime ?? wakeTime);
        setSleepTime(preset.schedule.sleepTime ?? sleepTime);
      }
    }, [bio, existing, wakeTime, sleepTime]);

    const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setDisplayName(e.target.value);
    }, []);

    const handleBioChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setBio(e.target.value);
    }, []);

    const handleAvatarChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setAvatarUrl(e.target.value);
    }, []);

    /** 选本地图片当头像：缩放后内联成 data URL，跟着角色卡一起走。 */
    const handleAvatarFile = useCallback(
      async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setImageError(null);
        try {
          setAvatarUrl(await readImageAsDataUrl(file, 256));
        } catch (error) {
          console.warn("[CharacterEditor] 头像读取失败：", error);
          setImageError("这张图片读不出来，换一张试试（支持 png/jpg/webp）。");
        }
      },
      [],
    );

    /** 添加一张立绘，默认挂到"平静"，可在列表里改。 */
    const handleAddSpriteFile = useCallback(
      async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setImageError(null);
        try {
          const url = await readImageAsDataUrl(file, 512);
          /**
           * 顺手存一张 96px 缩略图。
           *
           * `ICharacterSprite.thumbnailUrl` 这个字段一直只有读没有写——
           * 立绘查看器底部的缩略图条其实在拿 512px 大图缩着显示，
           * 八张图打开时都要按原尺寸解码。存一张真缩略图就没这回事了。
           */
          let thumbnailUrl: string | undefined;
          try {
            thumbnailUrl = await readImageAsDataUrl(file, 96);
          } catch {
            // 缩略图失败不影响主立绘（渲染时会回退用大图）
          }
          setSprites((list) => [
            ...list,
            {
              emotion: "neutral" as CharacterEmotion,
              url,
              ...(thumbnailUrl ? { thumbnailUrl } : {}),
            },
          ]);
        } catch (error) {
          console.warn("[CharacterEditor] 立绘读取失败：", error);
          setImageError("这张图片读不出来，换一张试试（支持 png/jpg/webp）。");
        }
      },
      [],
    );

    const handleSpriteEmotion = useCallback(
      (index: number, emotion: CharacterEmotion) => {
        setSprites((list) =>
          list.map((sprite, i) => (i === index ? { ...sprite, emotion } : sprite)),
        );
      },
      [],
    );

    const handleRemoveSprite = useCallback((index: number) => {
      setSprites((list) => list.filter((_, i) => i !== index));
    }, []);

    const handleWakeChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setWakeTime(e.target.value);
    }, []);

    const handleSleepChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setSleepTime(e.target.value);
    }, []);

    const handleScheduleToggle = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setScheduleEnabled(e.target.checked);
    }, []);

    const handleSleepPolicyChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
      setSleepPolicy(e.target.value as CharacterSleepReplyPolicy);
    }, []);

    /** 加一段忙碌时段：默认给一个"上午有课"的样板，用户再改。 */
    const handleAddBusyPeriod = useCallback(() => {
      setBusyPeriods((prev) => [
        ...prev,
        { start: "09:00", end: "12:00", label: "在上课" },
      ]);
    }, []);

    const handleRemoveBusyPeriod = useCallback((index: number) => {
      setBusyPeriods((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const handleBusyPeriodChange = useCallback(
      (index: number, patch: Partial<ICharacterBusyPeriod>) => {
        setBusyPeriods((prev) =>
          prev.map((period, i) =>
            i === index ? { ...period, ...patch } : period,
          ),
        );
      },
      [],
    );

    const handlePromptChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
      setPromptContent(e.target.value);
    }, []);

    /**
     * AI 生成：把一句话描述扩写成角色设定，直接填进表单。
     *
     * 填完不自动保存——生成的东西总要让人过一眼、改两笔再落库。
     */
    const handleGenerate = useCallback(async () => {
      if (!onGenerate || genBusy) return;
      setGenBusy(true);
      setGenMessage(null);
      setGenProgress(null);
      setGenSlow(false);
      const slowTimer = setTimeout(() => setGenSlow(true), 5000);
      const controller = new AbortController();
      genAbortRef.current = controller;
      try {
        const result = await onGenerate(genDescription, {
          signal: controller.signal,
          /**
           * 生成要等模型写完整张卡（几十秒）。把流式进度显示出来，
           * 用户才知道是在写、不是卡住了。
           */
          onProgress: (progress) => {
            // 一旦开始吐字，就不必再说"响应较慢"了
            clearTimeout(slowTimer);
            setGenSlow(false);
            setGenProgress(progress);
          },
        });
        setGenMessage(result.message);
        const draft = result.draft;
        if (result.ok && draft) {
          setGenVersions((prev) => ({
            list: [...prev.list, draft],
            index: prev.list.length,
          }));
        }
      } catch (error) {
        console.warn("[CharacterEditor] 生成失败：", error);
        setGenMessage("生成出错了，请重试。");
      } finally {
        clearTimeout(slowTimer);
        genAbortRef.current = null;
        setGenProgress(null);
        setGenSlow(false);
        setGenBusy(false);
      }
    }, [onGenerate, genBusy, genDescription]);

    /** 用户点"取消"：中断这次生成（面板不关，仍可改描述重来）。 */
    const handleCancelGenerate = useCallback(() => {
      genAbortRef.current?.abort();
    }, []);

    /** 把某一版草稿填进表单。 */
    const applyDraft = useCallback((draft: ICharacterDraft) => {
      setDisplayName(draft.displayName);
      setBio(draft.bio);
      setArchetype(draft.archetype);
      setGreeting(draft.greeting);
      setPromptContent(formatDraftAsPromptText(draft));
    }, []);

    /** 生成完成或切换版本时，把当前那一版填进表单。 */
    useEffect(() => {
      const draft = genVersions.list[genVersions.index];
      if (draft) applyDraft(draft);
    }, [genVersions, applyDraft]);

    /** 在生成过的几版之间来回切。 */
    const handleSwitchVersion = useCallback((delta: number) => {
      setGenVersions((prev) => {
        const next = prev.index + delta;
        if (next < 0 || next >= prev.list.length) return prev;
        return { ...prev, index: next };
      });
    }, []);

    // 面板关闭时也把在跑的生成取消掉，避免"关了面板请求还在烧 token"
    useEffect(() => {
      return () => genAbortRef.current?.abort();
    }, []);

    /**
     * 删除角色（连同聊天记录、记忆与世界设定）。
     *
     * 此前"删除角色"只存在于 store 里，界面上没有任何入口——
     * 想删掉不用的角色只能去改数据备份。删的东西不可恢复，
     * 所以二次确认里把"会一起删掉什么"写清楚。
     */
    const handleDelete = useCallback(() => {
      if (!existing) return;
      const confirmed = window.confirm(
        `确认删除角色「${existing.displayName}」？\n` +
          "它的聊天记录、长期记忆与世界设定会一起删除，且无法恢复。",
      );
      if (!confirmed) return;
      deleteCharacter(existing.id);
      onClose?.();
    }, [existing, deleteCharacter, onClose]);

    const handleSave = useCallback(() => {
      if (!displayName.trim()) return;

      const preset = ARCHETYPE_PRESETS[archetype];
      const characterId =
        existing?.id ?? `char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 用户填写的提示词落到角色专属模板，并绑定到 promptTemplateId；
      // 留空则解绑（不指向不存在的模板）
      const template = buildCharacterTemplate(
        characterId,
        displayName,
        promptContent,
      );
      if (template) {
        if (promptTemplates[template.id]) {
          updatePromptTemplate(template.id, template);
        } else {
          createPromptTemplate(template);
        }
      }
      const profile: ICharacterProfile = {
        id: characterId,
        displayName: displayName.trim(),
        bio: bio.trim() || preset?.bio || "",
        visualMetadata: {
          // 留空就显示首字占位块。以前留空会兜底到第三方图床，
          // 那个外链一旦失效，头像就只剩破图标，角色卡也跟着不自包含。
          avatarUrl: avatarUrl.trim(),
          sprites,
          // 有立绘才谈得上"固定立绘"
          supportsPinSprite: sprites.length > 0,
          defaultSpriteAnchor:
            existing?.visualMetadata.defaultSpriteAnchor ?? "left",
        },
        schedule: {
          wakeTime,
          sleepTime,
          scheduleEnabled,
          timezone: "Asia/Shanghai",
          sleepReplyPolicy: sleepPolicy,
          // 空数组不写进档案：卡片里少一个无意义字段
          ...(busyPeriods.length > 0 ? { busyPeriods } : {}),
        } satisfies ICharacterSchedule,
        personalityTraits: {
          archetype,
          typingSpeedMultiplier: preset?.personalityTraits?.typingSpeedMultiplier ?? 1.0,
          fragmentationBias: preset?.personalityTraits?.fragmentationBias ?? 0.3,
          hesitationProbability: preset?.personalityTraits?.hesitationProbability ?? 0.1,
          typoRate: preset?.personalityTraits?.typoRate ?? 0.05,
          stickerFrequency: preset?.personalityTraits?.stickerFrequency ?? 0.2,
        },
        promptTemplateId: template ? template.id : "",
        replyStyle,
        // 留空等于"没有开场白"（不写空字符串，免得卡片里多一个无意义字段）
        ...(greeting.trim() ? { greeting: greeting.trim() } : {}),
      };

      if (existing) {
        updateCharacter(existing.id, profile);
      } else {
        createCharacter(profile);
      }
      onClose?.();
    }, [displayName, bio, greeting, archetype, avatarUrl, wakeTime, sleepTime, scheduleEnabled, sleepPolicy, busyPeriods, existing, promptContent, promptTemplates, createPromptTemplate, updatePromptTemplate, createCharacter, updateCharacter, onClose, replyStyle, sprites]);

    // 头像预览 URL（优先用户填写的，否则用 archetype 默认）
    const previewAvatarUrl = avatarUrl.trim();

    /**
     * 最终提示词预览。
     *
     * 用表单里的当前值拼一个"临时角色"（还没保存也能看），
     * 模板就是上面那段人设文本——与保存时落到角色身上的完全同源，
     * 所以预览看到的就是真实请求里的那一段。
     */
    const previewProfile: ICharacterProfile = {
      id: existing?.id ?? "preview",
      displayName: displayName.trim() || "（未命名）",
      bio: bio.trim() || ARCHETYPE_PRESETS[archetype]?.bio || "",
      visualMetadata: {
        avatarUrl: "",
        sprites: [],
        supportsPinSprite: false,
        defaultSpriteAnchor: "left",
      },
      schedule: {
        wakeTime,
        sleepTime,
        scheduleEnabled,
        timezone: "Asia/Shanghai",
        sleepReplyPolicy: sleepPolicy,
      },
      personalityTraits: {
        archetype,
        // 与保存时同源：预设里没给的字段用与 handleSave 一致的默认值
        typingSpeedMultiplier:
          ARCHETYPE_PRESETS[archetype]?.personalityTraits?.typingSpeedMultiplier ?? 1,
        fragmentationBias:
          ARCHETYPE_PRESETS[archetype]?.personalityTraits?.fragmentationBias ?? 0.3,
        hesitationProbability:
          ARCHETYPE_PRESETS[archetype]?.personalityTraits?.hesitationProbability ??
          0.1,
        typoRate: ARCHETYPE_PRESETS[archetype]?.personalityTraits?.typoRate ?? 0.05,
        stickerFrequency:
          ARCHETYPE_PRESETS[archetype]?.personalityTraits?.stickerFrequency ?? 0.2,
      },
      promptTemplateId: "",
      replyStyle,
    };
    const promptPreview = buildSystemPromptPreview(
      previewProfile,
      buildCharacterTemplate(
        previewProfile.id,
        previewProfile.displayName,
        promptContent,
      ),
      userProfile,
    );

    return (
      <div className="zhichi-char-editor" role="dialog" aria-label="角色编辑">
        <div className="zhichi-char-editor__backdrop" onClick={onClose} />

        <div className="zhichi-char-editor__dialog">
          {/* 头部 */}
          <header className="zhichi-char-editor__header">
            <div className="zhichi-char-editor__header-title">
              <Icon name="sparkles" size={20} />
              <h2>{existing ? "编辑角色" : "新建角色"}</h2>
            </div>
            <button
              type="button"
              className="zhichi-char-editor__close"
              onClick={onClose}
              aria-label="关闭"
            >
              <Icon name="close" size={18} />
            </button>
          </header>

          <div className="zhichi-char-editor__body">
            {/* 头像预览区 */}
            <section className="zhichi-char-editor__avatar-section">
              <div className="zhichi-char-editor__avatar-preview">
                {previewAvatarUrl ? (
                  <img src={previewAvatarUrl} alt={displayName || "角色头像"} />
                ) : (
                  <span className="zhichi-char-editor__avatar-placeholder">
                    {displayName.slice(0, 1) || "?"}
                  </span>
                )}
              </div>
              <div className="zhichi-char-editor__avatar-meta">
                <p className="zhichi-char-editor__avatar-tip">
                  头像 URL 留空将自动生成
                </p>
              </div>
            </section>

            {/* AI 生成：给不出人设的用户一个起点 */}
            {onGenerate && (
              <section className="zhichi-char-editor__section zhichi-char-editor__forge">
                <h3 className="zhichi-char-editor__section-title">
                  <Icon name="sparkles" size={16} />
                  AI 生成角色
                </h3>
                <p className="zhichi-char-editor__forge-hint">
                  用一句话描述想要的角色，AI 会写好背景、性格、说话风格与开场白，
                  直接填进下面的表单（生成后还能改）。
                </p>
                <div className="zhichi-char-editor__forge-row">
                  <input
                    type="text"
                    value={genDescription}
                    placeholder="如：高中同桌，傲娇但细心，喜欢猫"
                    onChange={(e) => setGenDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleGenerate();
                      }
                    }}
                    className="zhichi-char-editor__input"
                    disabled={genBusy}
                  />
                  {genBusy ? (
                    <button
                      type="button"
                      className="zhichi-char-editor__forge-btn zhichi-char-editor__forge-btn--ghost"
                      aria-label="取消生成"
                      title="取消这次生成"
                      onClick={handleCancelGenerate}
                    >
                      取消
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="zhichi-char-editor__forge-btn"
                      onClick={() => void handleGenerate()}
                      disabled={!genDescription.trim()}
                    >
                      {genVersions.list.length > 0 ? "再生成一版" : "生成"}
                    </button>
                  )}
                </div>
                {!genBusy && genVersions.list.length > 1 && (
                  <div className="zhichi-char-editor__forge-versions">
                    <button
                      type="button"
                      aria-label="上一版"
                      title="看上一版"
                      disabled={genVersions.index <= 0}
                      onClick={() => handleSwitchVersion(-1)}
                    >
                      ◀
                    </button>
                    <span>
                      第 {genVersions.index + 1}/{genVersions.list.length} 版
                    </span>
                    <button
                      type="button"
                      aria-label="下一版"
                      title="看下一版"
                      disabled={genVersions.index >= genVersions.list.length - 1}
                      onClick={() => handleSwitchVersion(1)}
                    >
                      ▶
                    </button>
                  </div>
                )}
                {genBusy && (
                  <p
                    className="zhichi-char-editor__forge-msg zhichi-char-editor__forge-msg--progress"
                    role="status"
                  >
                    {genProgress
                      ? `正在生成${genProgress.name ? `「${genProgress.name}」` : ""}…已接收 ${genProgress.receivedChars} 字`
                      : genSlow
                        ? "正在生成…（模型首次响应较慢，请再等等）"
                        : "正在生成…"}
                  </p>
                )}
                {!genBusy && genMessage && (
                  <p className="zhichi-char-editor__forge-msg" role="status">
                    {genMessage}
                  </p>
                )}
              </section>
            )}

            {/* 基本信息 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="prompt" size={16} />
                基本信息
              </h3>
              <label className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">角色名</span>
                <input
                  type="text"
                  value={displayName}
                  placeholder="给角色起个名字"
                  onChange={handleNameChange}
                  className="zhichi-char-editor__input"
                />
              </label>
              <label className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">简介</span>
                <input
                  type="text"
                  value={bio}
                  placeholder="一句话简介"
                  onChange={handleBioChange}
                  className="zhichi-char-editor__input"
                />
              </label>
              <label className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">开场白</span>
                <textarea
                  value={greeting}
                  placeholder="新会话里角色说的第一句话（留空则角色不主动开口）"
                  onChange={(e) => setGreeting(e.target.value)}
                  className="zhichi-char-editor__textarea"
                  rows={3}
                />
              </label>
              <label className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">头像 URL</span>
                <input
                  type="text"
                  value={avatarUrl}
                  placeholder="https://..."
                  onChange={handleAvatarChange}
                  className="zhichi-char-editor__input"
                />
              </label>
              <div className="zhichi-char-editor__image-actions">
                <label className="zhichi-char-editor__image-btn">
                  选本地图片
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={handleAvatarFile}
                  />
                </label>
                {avatarUrl && (
                  <button
                    type="button"
                    className="zhichi-char-editor__image-btn"
                    onClick={() => setAvatarUrl("")}
                  >
                    清除头像
                  </button>
                )}
                <span className="zhichi-char-editor__image-hint">
                  本地图片会缩放后内联保存，换机器、导出角色卡都不会丢
                </span>
              </div>
              {imageError && (
                <p className="zhichi-char-editor__image-error" role="status">
                  {imageError}
                </p>
              )}
            </section>

            {/* 立绘 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="sparkles" size={16} />
                立绘（可选）
              </h3>
              <p className="zhichi-char-editor__hint">
                按情绪准备立绘，聊天时会随语气自动切换；不传就只用头像。
                图片会缩放后内联保存（最长边 512），因此角色卡自带素材。
              </p>
              {sprites.length > 0 && (
                <>
                  {/*
                    情绪覆盖提示：配了几张、缺哪几种。
                    之前只能自己数——八种情绪漏掉几种，聊天时那几种语气
                    就默默退回第一张立绘，用户根本不知道。
                  */}
                  <p
                    className="zhichi-char-editor__sprite-coverage"
                    role="status"
                  >
                    {(() => {
                      const covered = new Set(sprites.map((s) => s.emotion));
                      const all = Object.keys(EMOTION_LABELS) as CharacterEmotion[];
                      const missing = all.filter((emotion) => !covered.has(emotion));
                      if (missing.length === 0) {
                        return `情绪已覆盖全部 ${all.length} 种`;
                      }
                      return (
                        `情绪已覆盖 ${covered.size}/${all.length} 种 · 缺：` +
                        missing.map((emotion) => EMOTION_LABELS[emotion]).join("、")
                      );
                    })()}
                  </p>
                  <ul className="zhichi-char-editor__sprite-list">
                  {sprites.map((sprite, index) => (
                    <li key={`${index}-${sprite.emotion}`} className="zhichi-char-editor__sprite-row">
                      <img
                        className="zhichi-char-editor__sprite-thumb"
                        src={sprite.url}
                        alt=""
                      />
                      <select
                        className="zhichi-char-editor__sprite-emotion"
                        aria-label={`第 ${index + 1} 张立绘的情绪`}
                        value={sprite.emotion}
                        onChange={(e) =>
                          handleSpriteEmotion(
                            index,
                            e.target.value as CharacterEmotion,
                          )
                        }
                      >
                        {EMOTION_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="zhichi-char-editor__sprite-remove"
                        aria-label={`删除第 ${index + 1} 张立绘`}
                        onClick={() => handleRemoveSprite(index)}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                  </ul>
                </>
              )}
              <label className="zhichi-char-editor__image-btn">
                + 添加立绘
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleAddSpriteFile}
                />
              </label>
            </section>

            {/* 回复风格 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="chat" size={16} />
                回复风格
              </h3>
              <p className="zhichi-char-editor__hint">
                这是模型实际写多少字、写不写旁白；分几条气泡、打字多快由拟真引擎控制。
              </p>
              <div className="zhichi-char-editor__length-options" role="radiogroup" aria-label="回复长度">
                {REPLY_LENGTH_OPTIONS.map(([value, label, desc]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={replyStyle.length === value}
                    className={`zhichi-char-editor__length-btn${
                      replyStyle.length === value
                        ? " zhichi-char-editor__length-btn--active"
                        : ""
                    }`}
                    onClick={() => setReplyStyle((s) => ({ ...s, length: value }))}
                  >
                    <span className="zhichi-char-editor__length-label">{label}</span>
                    <span className="zhichi-char-editor__length-desc">{desc}</span>
                  </button>
                ))}
              </div>
              <label className="zhichi-char-editor__toggle">
                <input
                  type="checkbox"
                  checked={replyStyle.allowActions}
                  onChange={(e) =>
                    setReplyStyle((s) => ({ ...s, allowActions: e.target.checked }))
                  }
                />
                <span>允许动作/神态描写（如"（放下手里的书）"）</span>
              </label>
            </section>

            {/* 性格模板 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="heart" size={16} />
                性格模板
              </h3>
              <div className="zhichi-char-editor__archetypes">
                {ARCHETYPE_LIST.map(([id, preset]) => (
                  <button
                    key={id}
                    type="button"
                    className={`zhichi-char-editor__archetype ${archetype === id ? "zhichi-char-editor__archetype--active" : ""}`}
                    onClick={() => handleArchetypeChange(id)}
                  >
                    <span className="zhichi-char-editor__archetype-icon">{preset.icon}</span>
                    <span className="zhichi-char-editor__archetype-label">{preset.label}</span>
                    <span className="zhichi-char-editor__archetype-desc">{preset.desc}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* 作息设置 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="moon" size={16} />
                作息设置
              </h3>
              <div className="zhichi-char-editor__schedule-row">
                <label className="zhichi-char-editor__field">
                  <span className="zhichi-char-editor__field-label">起床时间</span>
                  <input
                    type="time"
                    value={wakeTime}
                    onChange={handleWakeChange}
                    className="zhichi-char-editor__input"
                  />
                </label>
                <label className="zhichi-char-editor__field">
                  <span className="zhichi-char-editor__field-label">入睡时间</span>
                  <input
                    type="time"
                    value={sleepTime}
                    onChange={handleSleepChange}
                    className="zhichi-char-editor__input"
                  />
                </label>
              </div>
              <label className="zhichi-char-editor__field zhichi-char-editor__field--checkbox">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={handleScheduleToggle}
                />
                <span>启用作息感知（深夜自动减少回复）</span>
              </label>
              <label className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">睡眠回复策略</span>
                <select
                  value={sleepPolicy}
                  onChange={handleSleepPolicyChange}
                  className="zhichi-char-editor__select"
                >
                  <option value="drowsy-burst">半梦半醒（drowsy-burst）</option>
                  <option value="silent">完全静默（silent）</option>
                  <option value="next-day-queue">次日补发（next-day-queue）</option>
                </select>
              </label>

              {/*
                忙碌时段：睡着时角色看不到消息，忙着时看得到、只是没空细说。
                没有这一栏之前，"在上课/在开会"这种日常状态无处可配。
              */}
              <div className="zhichi-char-editor__field">
                <span className="zhichi-char-editor__field-label">
                  忙碌时段（上课 / 上班）
                </span>
                {busyPeriods.length === 0 && (
                  <p className="zhichi-char-editor__busy-hint">
                    没配就是不忙。加上之后，这段时间里角色会显示"在上课"这类状态，
                    回复也会更短、更像忙里偷闲。
                  </p>
                )}
                {busyPeriods.map((period, index) => (
                  <div
                    className="zhichi-char-editor__busy-row"
                    key={`busy-${index}`}
                  >
                    <input
                      type="time"
                      value={period.start}
                      aria-label={`忙碌时段 ${index + 1} 开始时间`}
                      onChange={(e) =>
                        handleBusyPeriodChange(index, { start: e.target.value })
                      }
                      className="zhichi-char-editor__input"
                    />
                    <input
                      type="time"
                      value={period.end}
                      aria-label={`忙碌时段 ${index + 1} 结束时间`}
                      onChange={(e) =>
                        handleBusyPeriodChange(index, { end: e.target.value })
                      }
                      className="zhichi-char-editor__input"
                    />
                    <input
                      type="text"
                      value={period.label}
                      placeholder="在上课"
                      aria-label={`忙碌时段 ${index + 1} 文案`}
                      onChange={(e) =>
                        handleBusyPeriodChange(index, { label: e.target.value })
                      }
                      className="zhichi-char-editor__input"
                    />
                    <button
                      type="button"
                      className="zhichi-char-editor__busy-remove"
                      aria-label={`删除忙碌时段 ${index + 1}`}
                      onClick={() => handleRemoveBusyPeriod(index)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="zhichi-char-editor__busy-add"
                  onClick={handleAddBusyPeriod}
                >
                  + 添加忙碌时段
                </button>
              </div>
            </section>

            {/* 角色设定 */}
            <section className="zhichi-char-editor__section">
              <h3 className="zhichi-char-editor__section-title">
                <Icon name="prompt" size={16} />
                角色设定（System Prompt）
              </h3>
              <textarea
                className="zhichi-char-editor__textarea"
                value={promptContent}
                placeholder={`你是${displayName || "角色名"}，${bio || "简介"}。\n\n请根据以上设定，以第一人称与用户进行自然对话...`}
                rows={5}
                onChange={handlePromptChange}
              />
              {/*
                最终提示词预览：模板字段是给用户填的，拼出来到底长什么样、
                有没有互相打架，此前只能靠想象。
              */}
              <button
                type="button"
                className="zhichi-char-editor__preview-toggle"
                onClick={() => setPreviewOpen((open) => !open)}
                aria-expanded={previewOpen}
              >
                {previewOpen ? "收起最终提示词" : "预览最终提示词"}
              </button>
              {previewOpen && (
                <>
                  <pre className="zhichi-char-editor__preview">
                    {promptPreview}
                  </pre>
                  <p className="zhichi-char-editor__preview-hint">
                    这是每轮都会发出的**稳定前缀**（角色卡 + 人设模板 + 关于你 +
                    回复风格 + 情绪标记 + 引用规则）。睡眠/忙碌/心情、长期记忆、
                    剧情摘要属于每轮动态内容，不在这里显示。
                  </p>
                </>
              )}
            </section>
          </div>

          {/* 底部操作 */}
          <footer className="zhichi-char-editor__footer">
            {/* 删除角色：只在编辑已有角色时出现，放在最左（远离"保存"） */}
            {existing && (
              <button
                type="button"
                className="zhichi-char-editor__btn zhichi-char-editor__btn--danger"
                onClick={handleDelete}
                title="删除这个角色（聊天记录、记忆与设定会一起删除）"
              >
                删除角色
              </button>
            )}
            {/* 导出角色卡：只在编辑已有角色时出现（新建的角色还没保存） */}
            {editingCharacterId && onExportCharacterCard && (
              <button
                type="button"
                className="zhichi-char-editor__btn zhichi-char-editor__btn--ghost"
                onClick={() => onExportCharacterCard(editingCharacterId)}
                title="导出这张角色卡，可以备份或分享给别人"
              >
                导出角色卡
              </button>
            )}
            <button type="button" className="zhichi-char-editor__btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="zhichi-char-editor__btn zhichi-char-editor__btn--save"
              onClick={handleSave}
              disabled={!displayName.trim()}
            >
              <Icon name="check" size={16} />
              保存角色
            </button>
          </footer>
        </div>
      </div>
    );
  },
);

CharacterEditor.displayName = "CharacterEditor";
