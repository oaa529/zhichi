/**
 * @file MessageStressTest.tsx
 * 500 条 mock 消息压测入口。
 *
 * 验证项：
 * - 一次性注入 500 条消息，首帧不卡顿
 * - 滚动帧率 ≥ 55fps
 * - 虚拟滚动只渲染可视区域 DOM 节点
 *
 * 使用：在 App.tsx 中条件渲染 <MessageStressTest />（dev 模式下）
 */

import { useCallback, useMemo, useState } from "react";
import type { FC } from "react";
import type { ITextMessage, IMessage } from "@wechat-rp/shared-types";
import { ChatSessionView } from "@wechat-rp/ui-wechat";
import { useChatStore } from "@wechat-rp/ui-wechat";
import type { IMessageRuntime } from "@wechat-rp/ui-wechat";

/** 生成 N 条 mock 消息。交替 self/other，模拟真实对话。 */
function generateMockMessages(count: number): ReadonlyArray<IMessageRuntime> {
  const runtimes: IMessageRuntime[] = [];
  const baseTime = Date.now() - count * 60_000;

  for (let i = 0; i < count; i += 1) {
    const isSelf = i % 2 === 0;
    const msg: ITextMessage = {
      id: `stress-msg-${i}`,
      type: "text",
      senderId: isSelf ? "user-1" : "char-1",
      recipientId: isSelf ? "char-1" : "user-1",
      sessionId: "stress-test",
      timestamp: baseTime + i * 60_000,
      chunkSequence: i,
      emotion: "neutral",
      text: generateMessageText(i),
      sourceOffset: 0,
    };
    runtimes.push({
      message: msg as IMessage,
      revealed: true,
      pending: false,
    });
  }
  return runtimes;
}

/** 生成多样化的消息文本。 */
function generateMessageText(index: number): string {
  const templates = [
    "嗯，今天天气不错，想出去走走。",
    "你吃饭了吗？我刚点了一份外卖，等会儿就到。",
    "对了，昨天那个电影你看了吗？我觉得结局有点出乎意料。",
    "哈哈，你说的那个笑话真好笑，我笑了好久。",
    "我在想周末要不要去那个新开的咖啡馆，听说还不错。",
    "最近工作有点忙，但和你聊天总是很放松。",
    "你知道吗，我今天在路边看到一只很可爱的猫。",
    "这个嘛，让我想想……其实我也说不太准。",
  ];
  return templates[index % templates.length]!;
}

export const MessageStressTest: FC = () => {
  const [loaded, setLoaded] = useState(false);
  const [msgCount, setMsgCount] = useState(0);

  // 获取 store actions
  const appendDebugMessage = useChatStore((s) => s.appendDebugMessage);
  const resetSession = useChatStore((s) => s.resetSession);

  const mockMessages = useMemo(() => generateMockMessages(500), []);

  const handleLoad500 = useCallback(() => {
    resetSession();
    for (const rt of mockMessages) {
      appendDebugMessage(rt.message);
    }
    setMsgCount(mockMessages.length);
    setLoaded(true);
  }, [mockMessages, appendDebugMessage, resetSession]);

  const handleClear = useCallback(() => {
    resetSession();
    setMsgCount(0);
    setLoaded(false);
  }, [resetSession]);

  return (
    <div className="wechat-app" style={{ maxWidth: 420 }}>
      <header className="wechat-app__titlebar">
        <span className="wechat-app__title">压测面板</span>
      </header>
      <div style={{ padding: 12, display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={handleLoad500}
          className="wechat-input-bar__send"
          style={{ flex: 1 }}
        >
          注入 500 条
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="wechat-input-bar__icon-btn"
          style={{ flex: 1 }}
        >
          清空
        </button>
      </div>
      {loaded && (
        <div style={{ padding: "0 12px 8px", color: "#888", fontSize: 12 }}>
          已加载 {msgCount} 条消息。打开 DevTools Performance 面板录制滚动帧率。
        </div>
      )}
      <div className="wechat-app__chat">
        <ChatSessionView
          characterDisplayName="压测角色"
          characterAvatarUrl=""
        />
      </div>
    </div>
  );
};

MessageStressTest.displayName = "MessageStressTest";
