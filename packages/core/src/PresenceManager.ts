/**
 * @file PresenceManager.ts
 * 在线/作息状态管理器。
 *
 * 职责：
 * - 根据 ICharacterSchedule 判断当前角色是否处于睡眠时段
 * - 计算"睡眠时段收到消息"的回复策略与延迟
 * - 对外暴露当前在场状态 CharacterPresence
 *
 * 不依赖定时器：状态查询是无副作用的纯函数式判断，
 * 引擎在需要时调用 `evaluatePresence()` 主动获取。
 */

import type {
  CharacterPresence,
  CharacterEmotion,
  ICharacterProfile,
  ICharacterBusyPeriod,
  ISimulationConfig,
} from "@wechat-rp/shared-types";
import { minutesOfDayInZone, nextTimeOfDayInZone } from "./time/Clock";

/** 把 "HH:MM" 转为当日分钟数。 */
function parseToMinutes(hhmm: string): number {
  const parts = hhmm.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`PresenceManager: invalid time format "${hhmm}"`);
  }
  return h * 60 + m;
}

/**
 * 判断当前时刻是否落在 [start, end) 的时间窗口里。
 * 跨午夜场景：start=23:30, end=07:30。
 */
function isWithinWindow(
  nowMinutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes <= endMinutes) {
    // 不跨午夜：如 13:00 开始, 14:00 结束
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // 跨午夜：start > end
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * 在场状态判定结果。
 *
 * 名字不再叫 `ISleepReplyDecision`：它早就不只管睡眠了——
 * 睡眠、忙碌、在线三种情况都由这里给出，引擎据此决定
 * 要不要回、Prompt 里怎么描述"此刻的你"、界面显示什么状态。
 */
export interface IPresenceDecision {
  /** 是否处于睡眠时段。 */
  readonly isSleeping: boolean;
  /** 距离自然醒来的毫秒数（仅在 sleeping 时有意义）。 */
  readonly msUntilWake: number;
  /** 应采用何种回复策略。 */
  readonly policy: "next-day-queue" | "drowsy-burst" | "silent";
  /** UI 应显示的在场文案。 */
  readonly displayText: string;
  /** 该时段建议的在场状态。 */
  readonly presence: CharacterPresence;
  /** 是否处于忙碌时段（上课 / 上班…）。睡眠优先，睡着时这里为 false。 */
  readonly isBusy: boolean;
  /** 忙碌时命中的那一段（展示文案如"在上课"）。 */
  readonly busyLabel: string | null;
}

export class PresenceManager {
  constructor(
    private readonly profile: ICharacterProfile,
    private readonly config: ISimulationConfig,
  ) {}

  /**
   * 评估某时刻角色的在场状态（睡眠 / 忙碌 / 在线）。
   *
   * 优先级：**睡眠 > 忙碌 > 在线**。睡着了就是睡着了，
   * 不会"边睡边上课"；作息感知总开关关闭时两者都不判定。
   *
   * @param at 测试时刻（ms 时间戳），默认 now
   */
  public evaluate(at: number = Date.now()): IPresenceDecision {
    const schedule = this.profile.schedule;
    const enabled =
      this.config.scheduleAwarenessEnabled && schedule.scheduleEnabled;
    // 作息按**角色所在时区**的钟点判定，而不是宿主机器的钟点：
    // 角色卡里的 timezone 此前写进去从没被读过，跨时区角色会按错钟点睡觉。
    const zone = schedule.timezone;
    const nowMinutes = minutesOfDayInZone(at, zone);

    if (!enabled) {
      return this.onlineDecision();
    }

    const sleep = parseToMinutes(schedule.sleepTime);
    const wake = parseToMinutes(schedule.wakeTime);
    const sleeping = isWithinWindow(nowMinutes, sleep, wake);

    if (!sleeping) {
      // 醒着：再看看是不是在忙（上课 / 上班 / 通勤）
      const busy = this.findBusyPeriod(nowMinutes);
      if (busy) {
        return {
          isSleeping: false,
          msUntilWake: 0,
          policy: "next-day-queue",
          // 展示的是角色自己在干什么，比一个干巴巴的"忙碌中"有信息量
          displayText: busy.label,
          presence: "away",
          isBusy: true,
          busyLabel: busy.label,
        };
      }
      return this.onlineDecision();
    }

    // 距离醒来的 ms：同样按角色时区算（跨午夜时自动落到明天）
    const wakeHour = Number(schedule.wakeTime.split(":")[0]);
    const wakeMinute = Number(schedule.wakeTime.split(":")[1]);
    const wakeMinutes =
      (Number.isFinite(wakeHour) ? wakeHour : 0) * 60 +
      (Number.isFinite(wakeMinute) ? wakeMinute : 0);
    const msUntilWake = nextTimeOfDayInZone(wakeMinutes, at, zone) - at;

    return {
      isSleeping: true,
      msUntilWake,
      policy: schedule.sleepReplyPolicy,
      displayText: "已就寝",
      presence: "sleeping",
      isBusy: false,
      busyLabel: null,
    };
  }

  /** 在线（不睡也不忙）。 */
  private onlineDecision(): IPresenceDecision {
    return {
      isSleeping: false,
      msUntilWake: 0,
      policy: "next-day-queue",
      displayText: "在线",
      presence: "online",
      isBusy: false,
      busyLabel: null,
    };
  }

  /**
   * 找出命中的忙碌时段。
   *
   * 时段可以跨午夜；“没配”与“配了但时间写坏了”都当没有——
   * 一个角色卡里写错的时段不该让整个引擎抛错（旧存档更该容错）。
   */
  private findBusyPeriod(nowMinutes: number): ICharacterBusyPeriod | null {
    const periods = this.profile.schedule.busyPeriods ?? [];
    for (const period of periods) {
      let start: number;
      let end: number;
      try {
        start = parseToMinutes(period.start);
        end = parseToMinutes(period.end);
      } catch {
        continue;
      }
      if (isWithinWindow(nowMinutes, start, end)) return period;
    }
    return null;
  }

  /** 是否处于忙碌时段（睡眠时恒为 false）。 */
  public isBusy(at: number = Date.now()): boolean {
    return this.evaluate(at).isBusy;
  }

  /**
   * 生成在场状态变化事件所需的 emotion。
   * 睡眠时强制 sleepy，否则取传入值。
   */
  public resolveEmotion(proposed: CharacterEmotion, at: number = Date.now()): CharacterEmotion {
    const decision = this.evaluate(at);
    if (decision.isSleeping) {
      return "sleepy";
    }
    return proposed;
  }
}
