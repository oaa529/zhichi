# 生产加固 & UX 打磨 · 4 阶段递进计划

## Context

WeChat-Realism RP 项目已完成初始开发和 Mock 验证（30/30 验证项全 PASS）。当前进入"生产加固 & UX 打磨"阶段：接入真实 LLM、实现状态持久化、打磨拟真体感、建立性能基线。

**核心问题**：
1. LLM 调用层无 AbortController/超时/重试/降级，API 报错会白屏
2. 零持久化，刷新即丢失全部消息
3. 无虚拟滚动，500+ 消息会帧率退化；滚动逻辑打断阅读
4. 每字符一个 setTimeout，大量消息同时揭示定时器爆炸
5. 无移动端键盘适配，无消息三态

**用户决策**：LLM 两者都支持（抽象 LLMAdapter）· 分 4 阶段递进 · react-virtuoso 虚拟滚动

---

## 阶段 1: LLM 安全兜底

### 新建文件
| 文件 | 职责 |
|---|---|
| `packages/core/src/llm/LLMAdapter.ts` | 适配器抽象接口 `ILLMAdapter` |
| `packages/core/src/llm/OpenAIAdapter.ts` | OpenAI 兼容实现（fetch + SSE 解析） |
| `packages/core/src/llm/ClaudeAdapter.ts` | Claude 适配器骨架（实现协议，预留 SDK） |
| `packages/core/src/llm/ContextTrimmer.ts` | 上下文截断 + 摘要 |
| `packages/core/src/llm/PromptBuilder.ts` | 动态 Prompt 构造（注入 Presence 状态） |
| `packages/core/src/llm/FallbackGenerator.ts` | 角色 fallback 拟真回复 |
| `packages/core/src/llm/types.ts` | LLM 请求/响应/配置类型 |
| `apps/web/src/llmRuntime.ts` | API key/endpoint/baseURL 配置入口 |

### 修改文件
- `shared/types/src/events.ts` — `ILlmStreamHandlers` 增加可选 `onAbort?(reason: string): void`
- `shared/types/src/simulation.ts` — 新增 `ILLMConfig` 接口（baseURL/model/timeoutMs/maxRetries/temperature）
- `packages/core/src/index.ts` — 导出 llm/* 模块
- `packages/core/src/RealismEngine.ts` — `startStream` 增加可选 `adapter?: ILLMAdapter` 参数；新增 `streamWithRetry`/`streamWithFallback` 私有方法；`abortController` 透传给 adapter
- `apps/web/src/App.tsx` — `mockLlmStream` 替换为 `adapter.stream(req, handlers, signal)`；保留 mock 路径作 dev fallback

### 关键接口
```ts
interface ILLMAdapter {
  stream(req: ILLMRequest, handlers: ILlmStreamHandlers, signal: AbortSignal): ILLMAbortHandle;
}
interface ILLMRequest {
  messages: ReadonlyArray<{ role: "system"|"user"|"assistant"; content: string }>;
  model: string; maxTokens: number; temperature: number;
}
interface ILLMAbortHandle { abort(reason?: string): void; }
```

**Migration Guide**：`ILlmStreamHandlers` 新增可选 `onAbort`，旧实现忽略即可，向后兼容。`ILLMConfig` 为新增独立接口，不破坏 `ISimulationConfig`。`RealismEngine.startStream` 增加可选参数 `adapter`，未传时回退到 handlers 注入模式（保留 mock 闭环测试通路）。

### 核心算法
- **重试策略**：仅对 5xx/网络错误重试，4xx 直接降级；指数退避 500/1000/2000ms，max 3 次；流式已开始接收 delta 后不再重试
- **超时控制**：`AbortSignal.any([userSignal, AbortSignal.timeout(timeoutMs)])`，30s 默认
- **Fallback**：重试耗尽或 onError 时，`FallbackGenerator` 依 `personalityTraits.archetype` + `presence.evaluate()` 生成 2-4 字短句，通过 `deliverInstantMessage` 走秒回路径
- **Prompt 注入**：`PromptBuilder.build(profile, history, userMessage)` 在 `startStream` 时调 `presence.evaluate()`，sleeping 时注入 system: "你刚被消息吵醒，半梦半醒，回复极短"
- **ContextTrimmer**：token 估算 = `chars × 1.3`；保留 system + 最近 8 轮 user/assistant；超 4k chars 触发摘要；永不超 context window 的 80%

### 清理逻辑
- `engine.abort()` 透传调用 `adapter.abortHandle.abort()` → SSE fetch 自动中断
- adapter 内部 `signal.addEventListener("abort", () => reader.cancel())` 一次性绑定
- `App.tsx` useEffect cleanup 调 `dispose()` → `engine.abort("unmount")` → 链式清理

### 验证方法
- mock adapter 抛 500 → 触发 3 次重试 → fallback 短句出现，无白屏
- mock adapter 30s 不响应 → 超时降级
- 强制睡眠模式发消息 → 验证 system prompt 含"半梦半醒"
- 流式中途点"中止当前回复" → Network 面板显示 fetch aborted
- `pnpm typecheck` 通过

---

## 阶段 2: 状态持久化

### 新建文件
| 文件 | 职责 |
|---|---|
| `packages/core/src/storage/ChatStorage.ts` | IndexedDB 抽象层（idb-keyval 封装） |
| `packages/core/src/storage/EngineSnapshot.ts` | 引擎可序列化状态快照 |
| `packages/core/src/storage/schema.ts` | DB schema 版本 + 迁移函数 |
| `packages/ui-wechat/src/store/persistMiddleware.ts` | zustand persist 包装 |
| `apps/web/src/hydrateEngine.ts` | 启动时从 IDB 重建 engine + store |

### 修改文件
- `shared/types/src/simulation.ts` — 新增 `IEngineSnapshot` 接口
- `packages/core/src/RealismEngine.ts` — 暴露 `serializeRunState()` 和 `hydrate(snapshot)`
- `packages/ui-wechat/src/store/chatStore.ts` — 包裹 `persist(store, { name, storage, partialize, version, migrate })`；新增 `hydrateFromSnapshot` action
- `apps/web/src/App.tsx` — 启动时 `await hydrateEngine()` → 创建 engine → `attachEngine` → `hydrateFromSnapshot`
- `apps/web/src/main.tsx` — 改为异步启动 + loading 占位

### 关键接口
```ts
interface IEngineSnapshot {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly characterId: string;
  readonly messages: ReadonlyArray<IMessage>;
  readonly messageRuntimes: ReadonlyArray<{ revealed: boolean; revealDelays?: number[] }>;
  readonly presence: CharacterPresence;
  readonly presenceText: string;
  readonly simulationConfig: ISimulationConfig;
  readonly lastPhase: EngineLifecyclePhase;
  readonly lastError: { code: string; message: string } | null;
  readonly deliveredChunkCount: number;
  readonly savedAt: number;
}
```

**Migration Guide**：新增独立 `IEngineSnapshot` 接口，不修改既有类型。`chatStore` state 增加可选 `hydrated: boolean` 标记，不破坏现有 selector。

### 核心算法
- **持久化范围**：messages / messageRuntimes / presence / simulationConfig / phase / lastError / deliveredChunkCount。**不持久化**：buffer/chunker/typer/presence 内部状态/pendingTimers（瞬态，无法还原定时器）
- **Hydration 策略**：messages 直接还原；`lastPhase === "streaming"` → 标记 `phase: "interrupted"`，显示"上次回复未完成"提示，不自动续传；engine 正常创建 + `updateConfig` + `subscribe`
- **写入时机**：debounce 1s；`phase` 转为 completed/aborted 时强制 flush；`dispose()` 时最后写一次
- **存储选型**：IndexedDB（idb-keyval），不走 localStorage

### 清理逻辑
- `persistMiddleware` 在 `dispose()` 时 `clearTimeout(debounceTimer)`
- `hydrateEngine` 失败 → catch → 返回 null → App 正常初始化空状态

### 验证方法
- 发到一半刷新 → messages 全在，phase="interrupted"
- 完成 50 条对话 → 关闭标签页 → 重开 → 完整恢复
- DevTools Application > IndexedDB 查看
- 隐私模式（IDB 禁用）→ warn 但不崩溃

---

## 阶段 3: UI 体验打磨

### 新建文件
| 文件 | 职责 |
|---|---|
| `packages/ui-wechat/src/hooks/useSmartScroll.ts` | 智能滚动 hook |
| `packages/ui-wechat/src/hooks/useRafTypewriter.ts` | rAF 时间轴打字机 |
| `packages/ui-wechat/src/hooks/useViewportResize.ts` | 移动端键盘自适应 |
| `packages/ui-wechat/src/components/MessageStatus.tsx` | 消息三态状态条 |
| `packages/ui-wechat/src/components/ErrorRetryBubble.tsx` | 错误重试气泡 |
| `packages/ui-wechat/src/components/NewMessagePill.tsx` | "新消息 N 条"提示 |

### 修改文件
- `packages/ui-wechat/src/components/ChatSessionView.tsx` — 接入 useSmartScroll；底部锚改为 ref state
- `packages/ui-wechat/src/components/MessageBubble.tsx` — `useTypewriterAnimation` 替换为 `useRafTypewriter`
- `packages/ui-wechat/src/components/InputBar.tsx` — 接入 useViewportResize
- `packages/ui-wechat/src/store/chatStore.ts` — `IMessageRuntime` 增加 `status` 字段；新增 `retryMessage` action
- `packages/core/src/RealismEngine.ts` — 推送 `chunk-status` 事件（loading/error）
- `apps/web/src/global.css` — 加 status pill / keyboard-adjusted / new-message-pill 样式

### 关键接口
```ts
type RuntimeStatus = "pending" | "loading" | "delivered" | "error" | "recalled";
```
**Migration Guide**：`IEngineEvent` 联合类型新增 `IChunkStatusEvent`（`kind: "chunk-status"`），旧版引擎不推此事件时 UI 默认 `status: "delivered"`，向后兼容。

### 核心算法
- **智能滚动**：监听 scroll（passive），`isAtBottom = scrollTop + clientHeight ≥ scrollHeight - 80`；true 时新消息自动滚，false 时显示 `<NewMessagePill />`
- **打字节奏优化**：`useRafTypewriter` 预计算每字符 absolute timestamp，单个 `requestAnimationFrame` 循环每帧 slice 已揭示字符数；多个 MessageBubble 共享全局 `RafTimelineScheduler` 单例
- **键盘自适应**：`visualViewport.addEventListener("resize")` 计算键盘高度，调整 `.wechat-app` height
- **三态消息**：chunk-scheduled → loading（骨架气泡）；chunk-delivered → delivered；error 且 recoverable → error（重试按钮）

### 清理逻辑
- `useSmartScroll`：removeEventListener + clearTimeout
- `useRafTypewriter`：cancelAnimationFrame + 从 scheduler 注销
- `useViewportResize`：removeEventListener
- `RafTimelineScheduler` 无订阅者时自动停止 rAF

### 验证方法
- 滚到历史中段 → 收到新消息 → 不强制滚，显示"新消息" pill
- 500 字单 chunk → Performance 录制帧率 ≥ 55fps
- iOS Safari 键盘弹出 → 输入框不被遮挡
- 模拟 LLM error → 气泡显示重试按钮 → 点击重新发起

---

## 阶段 4: 性能基线 + 测试套件

### 新建文件
| 文件 | 职责 |
|---|---|
| `packages/ui-wechat/src/components/VirtualizedMessageList.tsx` | react-virtuoso 包装 |
| `packages/core/src/__tests__/SemanticBuffer.test.ts` | 切分边界 |
| `packages/core/src/__tests__/TypingSimulator.test.ts` | gaussianSample/plan |
| `packages/core/src/__tests__/PresenceManager.test.ts` | 跨午夜睡眠窗口 |
| `packages/core/src/__tests__/Chunker.test.ts` | ID 生成/游标 |
| `packages/core/src/__tests__/RealismEngine.test.ts` | 引擎集成（mock adapter） |
| `packages/core/src/__tests__/ContextTrimmer.test.ts` | 截断/摘要 |
| `packages/ui-wechat/src/__tests__/chatStore.test.ts` | store 状态机 |
| `apps/web/src/perf/MessageStressTest.tsx` | 500 条 mock 消息压测入口 |
| `vitest.config.ts` | vitest 配置 |

### 修改文件
- `packages/ui-wechat/src/components/ChatSessionView.tsx` — `<VirtualizedMessageList />` 替换 `sorted.map`
- `packages/ui-wechat/src/store/chatStore.ts` — selector 拆细：`useMessagesCount` 返回数字；`useMessagesView` 用 shallow 比较
- `packages/core/src/TypingSimulator.ts` — `gaussianSample` 抽为可注入随机源
- `package.json` + 子 package.json — 加 `vitest`/`@testing-library/react`/`react-virtuoso`/`@vitest/coverage-v8`/`jsdom`

### 核心算法
- **react-virtuoso 集成**：`initialTopMostItemIndex={messages.length - 1}` 实现初始在底部；`followOutput` 与 useSmartScroll 联动；key 用 `message.id` 非 index
- **Zustand selector 优化**：`messages.length` 单独 selector（数字比较）；`messages` 用 `shallow` 比较；排序移到 `useMemo`
- **500 消息压测**：预生成 500 条 mock IMessage，一次性 set 进 store，测量首帧 + 滚动帧率
- **测试套件**：纯函数注入 seeded RNG 断言；引擎集成 mock adapter 断言事件序列；store 状态机 mock engine output；`vi.useFakeTimers()` 控制定时器

### 验证方法
- `pnpm vitest run` 全绿
- `pnpm vitest run --coverage` core ≥ 80%
- MessageStressTest 入口 → Performance 录制 → avg fps ≥ 55
- `pnpm typecheck` + `pnpm build` 通过

---

## 跨阶段不变量

1. **AbortController 链**：阶段 1 建立 engine → adapter signal 透传，阶段 3 rAF 调度器、阶段 4 Virtuoso 都接入同一 abort 信号
2. **类型契约**：仅 3 处 shared/types 修改（`ILLMConfig`/`IEngineSnapshot`/`IChunkStatusEvent`），各配 Migration Guide
3. **清理路径**：所有 hook 单向收敛到 `store.dispose()` → `engine.abort("unmount")` → adapter.abort + rAF cancel + IDB debounce clear

## 推进顺序

```
阶段 1 (LLM 兜底) → 阶段 2 (持久化) → 阶段 3 (UI 打磨) → 阶段 4 (性能+测试)
```
每阶段完成后确认再继续。
