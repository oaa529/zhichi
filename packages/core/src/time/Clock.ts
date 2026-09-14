/**
 * @file Clock.ts
 * 时区感知的"现在"——给 Prompt 用的一组纯函数。
 *
 * 由来：整套拟真引擎里时间只被用来**判定**（该不该睡、忙不忙、延迟多久回），
 * 却从没告诉过模型"现在几点"。后果都见过：
 * - 晚上八点角色回一句"早上好"；
 * - 被问"现在几点了"只能瞎猜；
 * - 隔了三天没聊，接话像上一句刚说完；
 * - 角色卡里的 `schedule.timezone` 写进去之后**从没被读过**。
 *
 * 所以这里提供三件事：
 * 1. `wallClockInZone` / `minutesOfDayInZone`：某时刻在指定时区的**墙上时间**；
 * 2. `nextTimeOfDayInZone`：某时区的下一个"HH:MM"对应的真实时间戳（作息用）；
 * 3. `describeElapsed` / `renderTimeContext`：给模型的"现在"与"上一句隔了多久"。
 *
 * 全部为纯函数，时区无效或缺失时**退回宿主本地时间**，绝不抛错：
 * 一个写错的时区不该让整个会话打不开。
 */

/** 某时区下的墙上时间。 */
export interface IWallClock {
  /** 年（如 2026）。 */
  readonly year: number;
  /** 月（1-12）。 */
  readonly month: number;
  /** 日（1-31）。 */
  readonly day: number;
  /** 小时（0-23）。 */
  readonly hour: number;
  /** 分钟（0-59）。 */
  readonly minute: number;
  /** 星期（0=周日 … 6=周六）。 */
  readonly weekday: number;
}

/** 星期的中文单字，按 `weekday` 索引。 */
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * `Intl.DateTimeFormat` 实例缓存。
 *
 * 每轮对话都要取一次墙上时间，而构造 formatter 是这里最贵的一步
 * （比格式化本身贵得多），所以按"时区"缓存住复用。
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** 取（并缓存）某时区的 formatter；时区无效时返回 null（由调用方退回本地）。 */
function formatterFor(locale: string, timeZone: string): Intl.DateTimeFormat | null {
  const key = `${locale}\u0000${timeZone}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatterCache.set(key, formatter);
    return formatter;
  } catch {
    // RangeError：不是合法 IANA 时区（旧存档、手改过的角色卡都可能有）
    return null;
  }
}

/**
 * 某时刻在指定时区下的墙上时间。
 *
 * @param now 时间戳（ms）
 * @param timeZone IANA 时区（如 "Asia/Shanghai"）；缺省或非法时用宿主本地时间
 */
export function wallClockInZone(
  now: number,
  timeZone?: string | null,
): IWallClock {
  const zone = timeZone?.trim();
  // 本地时间不需要 formatter：直接用 Date 的本地取值，也避免依赖 ICU 数据
  if (!zone) return wallClockFromDate(new Date(now));

  const formatter = formatterFor("en-US", zone);
  if (!formatter) return wallClockFromDate(new Date(now));

  const parts = formatter.formatToParts(new Date(now));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  // 少数实现在 hourCycle 缺失时会给到 "24"，取模收敛回 0 点
  const hour = pick("hour") % 24;
  const minute = pick("minute");
  return {
    year,
    month,
    day,
    hour,
    minute,
    // 星期由"年月日"本身决定，跟时区无关，自己算比依赖 locale 稳
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** 从 Date 取本地墙上时间。 */
function wallClockFromDate(date: Date): IWallClock {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: date.getDay(),
  };
}

/**
 * 某时刻在指定时区下的"当日第几分钟"（0-1439）。
 *
 * 作息判定（睡眠 / 忙碌时段）用它，于是角色卡里的时区才真正生效：
 * 写 `America/New_York` 的角色按纽约的钟点睡觉，而不是按你机器的钟点。
 */
export function minutesOfDayInZone(
  now: number,
  timeZone?: string | null,
): number {
  const wall = wallClockInZone(now, timeZone);
  return wall.hour * 60 + wall.minute;
}

/**
 * 该时区与 UTC 的偏移（毫秒）。
 *
 * 只精确到分钟（作息判定不需要秒），且取的是**当前时刻**的偏移：
 * 夏令时切换当天会有最多一小时的误差，可接受。
 */
function zoneOffsetMs(now: number, timeZone?: string | null): number {
  const wall = wallClockInZone(now, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const minuteAligned = Math.floor(now / 60_000) * 60_000;
  return asUtc - minuteAligned;
}

/**
 * 指定时区里"下一个 HH:MM"对应的真实时间戳。
 *
 * @param minutesOfDay 目标钟点（当日第几分钟，0-1439）
 * @param now 当前时间戳（ms）
 * @param timeZone IANA 时区；缺省或非法时按宿主本地时间
 * @returns 时间戳（ms）；若今天该钟点已过则取明天
 */
export function nextTimeOfDayInZone(
  minutesOfDay: number,
  now: number,
  timeZone?: string | null,
): number {
  const wall = wallClockInZone(now, timeZone);
  const offset = zoneOffsetMs(now, timeZone);
  const nowInZone = now + offset;
  // 先把"当地日期 + 目标钟点"表达成 UTC 语义的毫秒数，再减回偏移
  let target = Date.UTC(wall.year, wall.month - 1, wall.day) + minutesOfDay * 60_000;
  if (target <= nowInZone) target += 86_400_000;
  return target - offset;
}

/**
 * 把一段时长说成人话（不带"前/后"的方位词）。
 *
 * 主动消息提示词要的是"距离上次聊天 3 小时"，这里给的就是那个"3 小时"。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "不到 1 分钟";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return `${Math.floor(days / 30)} 个月`;
}

/**
 * 把"过了多久"说成人话。
 *
 * 只给模型看，所以用中文口语量级，不做精确到秒的表述。
 * 时钟往回跳（存档时间比现在还晚）时按"刚刚"处理。
 */
export function describeElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
  return `${formatDuration(ms)}前`;
}

/** `renderTimeContext` 的输入。 */
export interface ITimeContextOptions {
  /** 现在的时间戳（ms）。 */
  readonly now: number;
  /** 角色所在时区；缺省或非法时用宿主本地时间。 */
  readonly timeZone?: string | null;
  /** 对方上一条消息的时间戳（ms）；没有历史时不传。 */
  readonly lastMessageAt?: number | null;
}

/** 间隔超过它才会提"上一句隔了多久"：一小时内的来回属于连续对话，不必点破。 */
const ELAPSED_HINT_THRESHOLD_MS = 60 * 60 * 1000;

/** 把墙上时间说成"9月13日 20:41"这样的短句。 */
function formatWallShort(wall: IWallClock): string {
  const hh = String(wall.hour).padStart(2, "0");
  const mm = String(wall.minute).padStart(2, "0");
  return `${wall.month}月${wall.day}日 ${hh}:${mm}`;
}

/**
 * 渲染"现在"这一段 system 注入。
 *
 * 每轮都注入：时间是最基本的场景事实，缺了它角色就会说出
 * "早上好"（晚上八点）这种一眼假的台词。隔了很久没聊时再补一句
 * 【上一句】，让角色能自然地提"好久没聊"。
 *
 * @returns 多行文本；永远非空（至少含【现在】一行）
 */
export function renderTimeContext(options: ITimeContextOptions): string {
  const { now, timeZone, lastMessageAt } = options;
  const wall = wallClockInZone(now, timeZone);
  const lines: string[] = [
    `【现在】${wall.year}年${wall.month}月${wall.day}日 星期${
      WEEKDAY_NAMES[wall.weekday] ?? "日"
    } ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}。`,
    "这是你手机上的时间：按它说话（该道晚安就道晚安，别把晚上说成早上）；" +
      "对方问时间就照实答，不用客气地反问。",
  ];

  if (typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt)) {
    const gap = now - lastMessageAt;
    if (gap >= ELAPSED_HINT_THRESHOLD_MS) {
      lines.push(
        `【上一句】你们上一次说话是 ${describeElapsed(gap)}（${formatWallShort(
          wallClockInZone(lastMessageAt, timeZone),
        )}）。`,
        "这段空档要当回事：开口时自然而然地带上它——提一句隔了多久、" +
          "说说你这几天在忙什么，或者问一句对方这段时间怎么样；" +
          "别装作刚刚才聊过，也不用郑重道歉。",
      );
    }
  }

  return lines.join("\n");
}
