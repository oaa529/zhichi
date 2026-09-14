/**
 * @file timeDivider.ts
 * 消息时间分隔线的判定与文案格式化（微信风格）。
 *
 * 纯函数，便于单测：日期/跨天/跨年边界容易出错，集中在此处验证。
 */

/** 相邻消息间隔超过该阈值才插入时间分隔线（微信约为 5 分钟）。 */
export const TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;

/** 判断两个日期是否为同一天（按本地时区）。 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 格式化时间分隔线文案。
 *
 * - 今天：`HH:mm`
 * - 昨天：`昨天 HH:mm`
 * - 今年内：`M月D日 HH:mm`
 * - 更早：`YYYY年M月D日 HH:mm`
 *
 * @param timestamp 消息时间戳（ms）
 * @param now 当前时间（测试可注入）
 */
export function formatDividerTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");

  if (isSameDay(date, nowDate)) {
    return `${hh}:${mm}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return `昨天 ${hh}:${mm}`;
  }

  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

/**
 * 判断当前消息之前是否需要插入时间分隔线。
 *
 * @param prevTimestamp 上一条消息时间戳（首条传 null）
 * @param currentTimestamp 当前消息时间戳
 */
export function shouldShowTimeDivider(
  prevTimestamp: number | null,
  currentTimestamp: number,
): boolean {
  // 会话第一条消息前总是显示时间（与微信一致）
  if (prevTimestamp === null) return true;
  return currentTimestamp - prevTimestamp >= TIME_DIVIDER_GAP_MS;
}
