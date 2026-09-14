/**
 * @file useRafTypewriter.ts
 * rAF 时间轴打字机 hook。
 *
 * 解决旧 useTypewriterAnimation 每字符一个 setTimeout 的定时器爆炸问题。
 *
 * 策略：
 * - 预计算每字符 absolute timestamp = startTime + revealDelays[i]
 * - 单个 requestAnimationFrame 循环每帧检查 now - startTime，slice 已揭示字符数
 * - 多个 MessageBubble 共享全局 RafTimelineScheduler 单例
 *
 * 清理：unmount 时 cancelAnimationFrame + 从 scheduler 注销
 */

import { useEffect, useState } from "react";

export interface IRafTypewriterOptions {
  readonly fullText: string;
  readonly revealDelays?: ReadonlyArray<number>;
  readonly typoCorrectAtMs?: number;
  readonly onComplete?: () => void;
}

export interface IRafTypewriterResult {
  readonly displayedText: string;
  readonly isCorrected: boolean;
}

// ---------- 全局 rAF 调度器单例 ----------

interface SchedulerEntry {
  readonly startTime: number;
  readonly timestamps: Float64Array;
  readonly fullText: string;
  readonly typoCorrectAtMs?: number;
  onUpdate: (revealedCount: number, isCorrected: boolean) => void;
  onComplete: () => void;
  completed: boolean;
}

class RafTimelineScheduler {
  private entries: Set<SchedulerEntry> = new Set();
  private rafId: number | null = null;

  add(entry: SchedulerEntry): void {
    this.entries.add(entry);
    if (this.rafId === null) {
      this.tick();
    }
  }

  remove(entry: SchedulerEntry): void {
    this.entries.delete(entry);
    if (this.entries.size === 0 && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);
    const now = performance.now();

    for (const entry of this.entries) {
      if (entry.completed) continue;

      // 计算已揭示字符数
      let revealed = 0;
      for (let i = 0; i < entry.timestamps.length && i < entry.fullText.length; i++) {
        const ts = entry.timestamps[i];
        if (ts !== undefined && now >= ts) {
          revealed = i + 1;
        } else {
          break;
        }
      }

      // 检查纠错
      const isCorrected = entry.typoCorrectAtMs !== undefined &&
        now >= entry.startTime + entry.typoCorrectAtMs;

      entry.onUpdate(revealed, isCorrected);

      // 检查完成
      if (revealed >= entry.fullText.length && isCorrected === (entry.typoCorrectAtMs !== undefined)) {
        entry.completed = true;
        entry.onComplete();
        this.entries.delete(entry);
      } else if (revealed >= entry.fullText.length && entry.typoCorrectAtMs === undefined) {
        entry.completed = true;
        entry.onComplete();
        this.entries.delete(entry);
      }
    }

    if (this.entries.size === 0 && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  };
}

const scheduler = new RafTimelineScheduler();

// ---------- Hook ----------

/**
 * rAF 时间轴打字机。
 *
 * - 若 revealDelays 不存在（秒回模式），直接显示全文。
 * - 若存在，预计算 timestamps，注册到全局 scheduler。
 * - 单个 rAF 循环驱动所有活跃打字机，500 字 1 个 rAF vs 500 个 setTimeout。
 */
export function useRafTypewriter(opts: IRafTypewriterOptions): IRafTypewriterResult {
  const { fullText, revealDelays, typoCorrectAtMs, onComplete } = opts;
  const [revealedCount, setRevealedCount] = useState(
    revealDelays ? 0 : fullText.length,
  );
  const [isCorrected, setIsCorrected] = useState(false);

  useEffect(() => {
    if (!revealDelays || revealDelays.length === 0) {
      setRevealedCount(fullText.length);
      onComplete?.();
      return;
    }

    const startTime = performance.now();
    // 预计算每字符的 absolute timestamp
    const timestamps = new Float64Array(revealDelays.length);
    for (let i = 0; i < revealDelays.length && i < fullText.length; i++) {
      timestamps[i] = startTime + (revealDelays[i] ?? 0);
    }

    let lastRevealed = 0;
    let lastCorrected = false;

    const entry: SchedulerEntry = {
      startTime,
      timestamps,
      fullText,
      typoCorrectAtMs,
      onUpdate: (revealed, corrected) => {
        if (revealed !== lastRevealed) {
          lastRevealed = revealed;
          setRevealedCount(revealed);
        }
        if (corrected !== lastCorrected) {
          lastCorrected = corrected;
          setIsCorrected(corrected);
        }
      },
      onComplete: () => {
        onComplete?.();
      },
      completed: false,
    };

    scheduler.add(entry);
    return () => {
      scheduler.remove(entry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullText, revealDelays, typoCorrectAtMs]);

  const displayedText = fullText.slice(0, revealedCount);
  return { displayedText, isCorrected };
}
