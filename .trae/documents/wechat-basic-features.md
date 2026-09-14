# 微信基础功能集合实现计划

## Context

用户希望补齐微信常用基础功能，让咫尺更贴近真实微信体验。当前应用已有三栏布局、会话列表、聊天、提示词模板等核心功能，但缺少：可调整侧栏宽度、会话项操作菜单（置顶/删除）、AI 主动发消息、未读红点等微信标志性交互。

本计划新增 5 项功能，全部复用现有 store 和组件体系，不引入新依赖。

---

## 功能清单

### 1. 可拖拽侧边栏宽度

**改动文件：**
- [WeChatShell.tsx](file:///d:/咫尺/packages/ui-wechat/src/components/WeChatShell.tsx) — 新增 `sidebarWidth` state（默认 300，范围 220~520），在 TabBar 与 sidebar 之间插入拖拽分隔条，mousedown/mousemove/mouseup 处理拖拽
- [global.css](file:///d:/咫尺/apps/web/src/global.css) — 新增 `.zhichi-shell__resizer` 样式（4px 宽，hover 高亮，cursor: col-resize）

**实现要点：**
- 拖拽时给 `document` 绑定 mousemove/mouseup，结束时解绑
- sidebar 宽度由 inline style 控制：`style={{ width: sidebarWidth }}`

### 2. 会话项三点菜单（置顶/标为已读/删除）

**改动文件：**
- [sessionStore.ts](file:///d:/咫尺/packages/ui-wechat/src/store/sessionStore.ts) — 新增 actions：`togglePinSession`、`markSessionAsRead`、`incrementUnread`、`clearUnread`、`updateSessionPreview`
- [SessionList.tsx](file:///d:/咫尺/packages/ui-wechat/src/components/SessionList.tsx) — SessionListItem 右下角加三点按钮（复用 Icon `more`），点击弹出下拉菜单，点击外部关闭（useRef + click outside）
- [global.css](file:///d:/咫尺/apps/web/src/global.css) — 新增 `.zhichi-session-menu` 下拉菜单样式

**菜单项：**
- 置顶/取消置顶（togglePinSession）
- 标为已读（markSessionAsRead）
- 删除会话（deleteSession，已有）

**switchSession 改造：** 切换会话时自动 clearUnread。

### 3. 未读消息红点

**改动文件：**
- [App.tsx](file:///d:/咫尺/apps/web/src/App.tsx) — 新增"背景订阅器"：为非活跃会话的引擎建立轻量订阅，收到 `chunk-delivered` 时调用 `incrementUnread` + `updateSessionPreview`
- [chatStore.ts](file:///d:/咫尺/packages/ui-wechat/src/store/chatStore.ts) — `chunk-delivered` 分支中，若消息 `sessionId !== activeSessionId`，走 sessionStore 背景更新（活跃会话不显示，非活跃累计未读）

**红点位置：** 会话列表头像左上角（已有 badge 在右上角，新增左上角小圆点样式 `.zhichi-session-list__unread-dot`），区分"未读数 badge"（右上）和"有新消息红点"（左上）。

**已实现部分：** `ISession.unreadCount` 字段和 badge 已存在，补充更新逻辑即可。

### 4. 实时 AI 主动发消息

**改动文件：**
- [session.ts](file:///d:/咫尺/shared/types/src/session.ts) — 新增 `IRealtimeAIConfig` 接口（`enabled: boolean`, `intervalMs: number`）
- [sessionStore.ts](file:///d:/咫尺/packages/ui-wechat/src/store/sessionStore.ts) — 新增 `realtimeAIConfig` 状态 + `setRealtimeAIConfig` action，持久化
- [PromptPanel.tsx](file:///d:/咫尺/packages/ui-wechat/src/components/PromptPanel.tsx) — 顶部新增"实时 AI"配置区：开关 + 间隔输入（默认 60s）
- [App.tsx](file:///d:/咫尺/apps/web/src/App.tsx) — 新增 useEffect 定时器：当 `realtimeAIConfig.enabled` 且引擎非 streaming 时，调用 `engine.startStreamWithAdapter(PROACTIVE_PROMPT, adapter)`

**主动消息触发词（PROACTIVE_PROMPT）：**
```
（系统：现在是一个自然时机，请以角色身份主动给对方发一条消息。可以是日常问候、分享心情或发起话题。保持人设，不要提及系统提示。）
```

**触发范围：** 默认仅触发活跃会话（避免复杂度），通过背景订阅器（功能3）支持非活跃会话的红点显示。

### 5. 微信基础功能（整合）

上述功能已覆盖：置顶排序（已实现）、删除会话（已有）、标为已读、未读红点。无需额外文件。

---

## 不改动的文件

- [RealismEngine.ts](file:///d:/咫尺/packages/core/src/RealismEngine.ts) — 引擎逻辑不变，复用 `startStreamWithAdapter`
- [EngineManager.ts](file:///d:/咫尺/packages/core/src/EngineManager.ts) — 复用 `getOrCreate`
- [ChatTabBar.tsx](file:///d:/咫尺/packages/ui-wechat/src/components/ChatTabBar.tsx) — 垂直导航栏不变

---

## 实现顺序

1. **sessionStore + session.ts 类型** — 新增 actions 和 IRealtimeAIConfig（基础层）
2. **SessionList 三点菜单** — UI + 菜单逻辑
3. **WeChatShell 拖拽分隔条** — 侧边栏宽度调整
4. **App.tsx 背景订阅器 + 实时AI定时器** — 未读红点 + AI 主动消息
5. **PromptPanel 实时AI配置区** — 开关 UI
6. **global.css** — 所有新组件样式
7. **验证** — typecheck + build + dev

---

## 验证

```bash
pnpm -r typecheck   # 类型检查
pnpm build          # 构建
pnpm dev            # 运行 dev server
```

手动验证：
- 拖拽 TabBar 和侧边栏之间的边界线，侧边栏宽度随鼠标变化
- 鼠标悬停会话项右下角，出现三点按钮，点击弹出菜单
- 菜单中点击"置顶"，该会话移到列表顶部；点击"删除"，会话消失
- 切换到会话 A，开启实时 AI（间隔 60s），等待 60s 后 AI 主动发消息
- 切换到会话 B，会话 A 收到 AI 消息时，列表中会话 A 头像左上角出现红点
- 点击会话 A，红点消失，未读消息显示在聊天中
