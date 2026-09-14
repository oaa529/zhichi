/**
 * @file relativeTime.ts
 * 相对时间文案（"刚刚 / N 分钟前 / 昨天 / N 天前"）。
 *
 * 记忆面板用它展示"这条记忆是什么时候更新的"，
 * 让用户能判断记忆是否还新鲜。纯函数，便于单测。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 格式化相对时间。
 *
 * - 1 分钟内：`刚刚`
 * - 1 小时内：`N 分钟前`
 * - 24 小时内：`N 小时前`
 * - 昨天（24~48 小时内）：`昨天`
 * - 30 天内：`N 天前`
 * - 更早：`YYYY-MM-DD`
 *
 * @param timestamp 目标时间戳（ms）
 * @param now 当前时间（测试可注入）
 */
export function formatRelativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const diff = now - timestamp;

  // 未来时间（时钟漂移等）按"刚刚"处理
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return "昨天";
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;

  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
