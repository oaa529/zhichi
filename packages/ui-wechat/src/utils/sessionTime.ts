/**
 * @file sessionTime.ts
 * 会话列表的时间显示（微信式）。
 *
 * - 今天：`HH:mm`
 * - 昨天：`昨天`
 * - 一周内：`星期一` … `星期日`
 * - 更早：`M/D`（跨年补年份 `YYYY/M/D`）
 */

const WEEKDAYS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
] as const;

/** 是否同一天（本地时区）。 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 格式化会话列表中的时间。
 *
 * @param timestamp 最后一条消息时间戳（ms）
 * @param now 当前时间（测试可注入）
 */
export function formatSessionTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const nowDate = new Date(now);

  if (isSameDay(date, nowDate)) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return "昨天";

  // 一周内（2~6 天前）显示星期
  const dayDiff = Math.floor(
    (nowDate.setHours(0, 0, 0, 0) - new Date(timestamp).setHours(0, 0, 0, 0)) /
      (24 * 60 * 60 * 1000),
  );
  if (dayDiff >= 2 && dayDiff <= 6) {
    return WEEKDAYS[date.getDay()] ?? "";
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() !== nowDate.getFullYear()) {
    return `${date.getFullYear()}/${month}/${day}`;
  }
  return `${month}/${day}`;
}
