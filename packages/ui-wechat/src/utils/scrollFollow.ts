/**
 * @file scrollFollow.ts
 * "新消息到达时是否跟随到底部"的判定逻辑。
 *
 * 抽成纯函数以便单测：这段判定曾出错导致两种相反的 bug——
 * 该跟随时不跟随（新消息被"往上挤"）、不该跟随时强行拉回（打断翻阅历史）。
 */

/** 判定入参。 */
export interface IShouldFollowBottomParams {
  /** 变化前的消息条数。 */
  readonly prevCount: number;
  /** 变化后的消息条数。 */
  readonly messageCount: number;
  /** 最后一条消息的发送者 ID。 */
  readonly lastSenderId: string | undefined;
  /** 用户当前是否贴底（由滚动事件维护的黏性标志）。 */
  readonly stickyBottom: boolean;
}

/**
 * 是否需要把列表滚动到底部。
 *
 * 三种跟随时机：
 * 1. 首次填充（prevCount = 0）：列表恢复/首条消息，必须定位到最新
 * 2. 自己发出的消息：发送后应立刻看到自己的消息
 * 3. 本来就贴底：新气泡到达时保持贴底
 *
 * 其余情况（用户在翻阅历史）不跟随，改为累计未读提示。
 */
export function shouldFollowBottom(
  params: IShouldFollowBottomParams,
): boolean {
  const { prevCount, messageCount, lastSenderId, stickyBottom } = params;
  const delta = messageCount - prevCount;
  if (delta <= 0) return false;
  if (prevCount === 0) return true;
  if (lastSenderId === "user") return true;
  return stickyBottom;
}
