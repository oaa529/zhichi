# 微信式多角色 + Bug 修复实施计划

## Context

当前项目存在两个问题：
1. **Bug**：消息并行输出。`RealismEngine.scheduleChunkDelivery()` 中 `isFirst` 判断基于 `deliveredChunkCount`，但该值只在 `setTimeout` 回调内的 `deliverChunk()` 中递增。当 LLM 流式输出多个 chunk 时，它们几乎同时进入排程，全部被当作 `isFirst=true` → `preDelay=0` → 并行交付。
2. **功能不足**：当前是单角色单会话架构，用户需要微信式体验：多角色管理、会话列表侧边栏、API配置、通讯录。

用户确认：群聊AI行为为"多人依次回复"，角色来源为"模板+自定义"，Bug+核心功能一起做。群聊/提示词管理放后续迭代。

---

## 阶段 A：修复消息并行交付 Bug

**修改 [RealismEngine.ts](file:///d:/咫尺/packages/core/src/RealismEngine.ts)**

1. 新增字段 `private scheduledChunkCount = 0;` 和 `private nextDeliveryTime = 0;`
2. `resetRunState()` 中同步重置这两个字段
3. `scheduleChunkDelivery()` 改为排队算法：
   - `isFirst = this.scheduledChunkCount === 0`（替换 `deliveredChunkCount`）
   - 立即 `this.scheduledChunkCount += 1`
   - `const now = Date.now();`
   - `const base = Math.max(now, this.nextDeliveryTime);`
   - `const deliveryTime = base + plan.preDeliveryDelayMs;`
   - `this.nextDeliveryTime = deliveryTime + typer.estimateTypingDurationMs(chunk.text.length);`
   - `setTimeout(..., Math.max(0, deliveryTime - now))`

**新增测试** [RealismEngine.scheduling.test.ts](file:///d:/咫尺/packages/core/src/__tests__/RealismEngine.scheduling.test.ts)：喂入 3 个快速 delta，断言 chunk-delivered 事件 timestamp 单调递增。

---

## 阶段 B：扩展数据模型（shared/types）

**新建 `shared/types/src/session.ts`**：

```typescript
export interface ISession {
  readonly id: string;
  readonly type: "single" | "group";       // 第一版只实现 single
  readonly participantIds: ReadonlyArray<string>;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly lastMessagePreview: string;
  readonly lastMessageTime: number;
  readonly unreadCount: number;
  readonly isPinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IContact {
  readonly characterId: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly bio: string;
  readonly isPinned: boolean;
}

export interface IPromptTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly variables: ReadonlyArray<string>;
}

export interface IApiConfig {
  readonly adapter: "openai" | "claude" | "mock";
  readonly baseURL: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly maxRetries: number;
  readonly timeoutMs: number;
}
```

**修改 `shared/types/src/index.ts`**：追加 `export * from "./session";`

**修改 `shared/types/src/message.ts`**：`IMessageBase` 新增 `readonly sessionId: string;`

---

## 阶段 C：Store 多会话化

**新建 `packages/ui-wechat/src/store/sessionStore.ts`**：

顶层状态：
- `sessions: Record<string, ISession>` — 会话列表
- `contacts: Record<string, IContact>` — 通讯录
- `characters: Record<string, ICharacterProfile>` — 角色档案
- `promptTemplates: Record<string, IPromptTemplate>` — 提示词模板
- `apiConfig: IApiConfig` — API 配置
- `apiKey: string` — 内存态 API Key（不持久化）
- `activeSessionId: string | null` — 当前打开的会话
- `sessionStates: Record<string, ISessionRuntime>` — 每会话独立的 messages/presence/phase/typing

Actions：
- `createSession(characterId)` / `deleteSession(id)` / `switchSession(id)`
- `createCharacter(profile)` / `updateCharacter(id, patch)` / `deleteCharacter(id)`
- `setApiConfig(patch)` / `setApiKey(key)`
- `createPromptTemplate(tpl)` / `updatePromptTemplate(id, patch)`
- `appendMessageToSession(sessionId, message)` — 替代原 `appendDebugMessage`
- `_handleEngineOutputForSession(sessionId, output)` — 按会话分发引擎输出

**重构 `packages/ui-wechat/src/store/chatStore.ts`**：
- 保留为单会话运行时切片（`ISessionRuntime`：messages/presence/phase/typingIndicator/pendingCount/lastError）
- 导出 `useSessionStore`（全局）和 `useActiveSession()` selector hook
- `attachEngine(engine)` 改为按 `activeSessionId` 关联引擎与 `sessionStates[sessionId]`
- `partialize` 序列化 sessions/contacts/characters/promptTemplates/apiConfig/sessionStates

**新建 `packages/core/src/EngineManager.ts`**：
- `Map<sessionId, RealismEngine>` 管理多引擎实例
- `getOrCreate(sessionId, profile, config)` — 懒创建
- `dispose(sessionId)` / `disposeAll()`
- 单例 LLM adapter 共享（避免多引擎重复创建 adapter）

---

## 阶段 D：微信式 UI 组件

**新建 6 个组件（`packages/ui-wechat/src/components/`）**：

| 组件 | 职责 |
|---|---|
| `WeChatShell.tsx` | 三栏布局容器（侧边栏 + 主区 + 可选右栏），顶部标题栏 |
| `SessionList.tsx` | 左侧会话列表（复用 ContactList 的列表模式），显示最近消息预览、未读红点、置顶分组 |
| `ContactsPanel.tsx` | 通讯录面板：联系人列表 + "+" 新建角色入口 |
| `SettingsPanel.tsx` | 设置面板：API 配置表单（adapter/baseURL/model/temperature/maxTokens/apiKey）+ 拟真度控制 |
| `CharacterEditor.tsx` | 角色编辑器：表单驱动 ICharacterProfile，6 个 CharacterArchetype 预设模板 |
| `ChatTabBar.tsx` | 底部三 Tab（聊天/通讯录/设置），微信风格图标 + 红点 |

**修改 `ChatSessionView.tsx`**：props 从 `characterDisplayName/avatarUrl/profile` 改为 `sessionId`，内部通过 `useActiveSession()` 自取数据。

**修改 `InputBar.tsx`**：`onSubmit` 改为 `onSubmitForSession(sessionId, text)`。

**修改 `components/index.ts`**：导出 6 个新组件。

**扩展 `apps/web/src/global.css`**：新增 `.wechat-shell`、`.wechat-shell__sidebar`、`.wechat-tab-bar`、`.wechat-session-list__item`、`.wechat-contacts`、`.wechat-settings` 等 BEM 块。

---

## 阶段 E：App.tsx 重装

**重写 `apps/web/src/App.tsx`**：
- 移除 `DEMO_PROFILE` 硬编码 → 迁至 store 初始化时的种子数据
- 用 `<WeChatShell />` 替换现有 JSX
- 保留调试关键词（图片/语音/贴图等），迁入 SettingsPanel 的"调试"折叠区
- `EngineManager` 替代单引擎 useMemo

**修改 `apps/web/src/llmRuntime.ts`**：
- `getLLMConfig()` 从 `useSessionStore.getState().apiConfig` 读取
- `VITE_LLM_*` 环境变量仅作首次启动 fallback
- 新增 `recreateAdapter()` — API config 变更后重建 adapter + 通知所有引擎 `setLLMConfig`

---

## 阶段 F：持久化收尾

**修改 `packages/core/src/storage/schema.ts`**：`SCHEMA_VERSION = 2`，新增 v1→v2 迁移（给 messages 补 `sessionId`，旧扁平 snapshot 包为 `sessions`）。

**修改 `packages/ui-wechat/src/store/persistMiddleware.ts`**：partialize 拆为 `sessions`/`contacts`/`characters`/`promptTemplates`/`apiConfig`/`sessionStates`，apiKey 不序列化。

---

## 实施顺序

1. **阶段 A**（独立可合入，无类型破坏）
2. **阶段 B**（数据模型，无破坏性变更）
3. **阶段 C**（Store，依赖 B）
4. **阶段 D**（UI，依赖 C）
5. **阶段 E**（App 装配，依赖 C+D）
6. **阶段 F**（持久化，与 E 同步）

---

## 验证

- `pnpm vitest run` — 全部测试通过（含新增 scheduling test）
- `pnpm -r typecheck` — 4 包全绿
- `pnpm build` — 构建成功
- `pnpm dev` — 手动验证：
  1. 消息逐条串行交付（不再并行）
  2. 左侧会话列表显示正常
  3. 切换会话后消息不串
  4. 通讯录中新建角色后出现在会话列表
  5. 设置面板配置 API 后可正常对话
  6. 刷新页面后会话/角色/消息恢复
