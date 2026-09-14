/**
 * @file SemanticBuffer.ts
 * 语义缓冲区：将 LLM 流式 token 增量按标点切分为稳定片段。
 *
 * 切分策略：
 * 1. 收到 token 后追加到内部 buffer。
 * 2. 检测 buffer 末尾是否出现"切分点"（句号/问号/感叹号/换行/中文逗号停顿）。
 * 3. 命中切分点时 flush 一个完整片段；流结束时 flush 残余 buffer。
 *
 * 切分粒度由 ISimulationConfig.fragmentationThresholdChars 控制上限：
 * 即便没有标点，超过阈值也强制切分（模拟"边想边打"的长句分段）。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";
import type { ISimulationConfig } from "@wechat-rp/shared-types";

import { Chunker } from "./Chunker";
import type { MessageChunk } from "./types";

/** 切分触发字符集合（中英文标点）。 */
const SPLIT_CHARS = new Set([
  "。",
  "？",
  "！",
  "，",
  "；",
  "…",
  "\n",
  ".",
  "?",
  "!",
  ",",
  ";",
]);

/** 切分回调签名：每产出一个 chunk 调用一次。 */
export type ChunkEmitCallback = (chunk: MessageChunk) => void;

/**
 * 仅由"结构性标点"与空白组成的片段（如单独一个 `.`、`。`、`,`）。
 *
 * 真实模型常输出列表符号、行尾句点等格式噪声，若照单全收会出现空气泡。
 * 注意：`…`、`？`、`！` 等有表达力的标点不在其中，单独成气泡时保留。
 */
const STRUCTURAL_PUNCT_ONLY = /^[\s.,;:、，。；：·\-—]*$/u;

/** 是否为无信息量的格式噪声片段。 */
function isStructuralNoise(text: string): boolean {
  return STRUCTURAL_PUNCT_ONLY.test(text);
}

export interface ISemanticBufferOptions {
  readonly sessionId: string;
  readonly characterId: string;
  readonly config: ISimulationConfig;
  readonly chunker?: Chunker;
}

export class SemanticBuffer {
  private buffer = "";
  private readonly chunker: Chunker;
  private readonly config: ISimulationConfig;
  /** 当前情绪（由外部 sentiment 模块更新）。 */
  private currentEmotion: CharacterEmotion = "neutral";
  private completed = false;

  constructor(opts: ISemanticBufferOptions) {
    this.chunker = opts.chunker ?? new Chunker({ sessionId: opts.sessionId, characterId: opts.characterId });
    this.config = opts.config;
  }

  /** 更新当前情绪快照（基于 LLM 输出的 sentiment 分析）。 */
  public setEmotion(emotion: CharacterEmotion): void {
    this.currentEmotion = emotion;
  }

  /**
   * 接收 LLM token 增量并尝试 flush chunk。
   * @returns 本次调用 flush 出的 chunk 数组（可能为空）。
   */
  public push(deltaText: string, onChunk: ChunkEmitCallback): MessageChunk[] {
    if (this.completed) {
      throw new Error("SemanticBuffer: push() called after complete()");
    }
    this.buffer += deltaText;
    return this.tryFlush(false, onChunk);
  }

  /**
   * 流结束调用。flush 残余 buffer 并标记末尾 chunk。
   */
  public complete(onChunk: ChunkEmitCallback): MessageChunk[] {
    if (this.completed) {
      throw new Error("SemanticBuffer: complete() called twice");
    }
    this.completed = true;
    const flushed = this.tryFlush(true, onChunk);
    // 重置游标供下次使用
    this.buffer = "";
    this.completed = false;
    this.chunker.reset();
    return flushed;
  }

  /**
   * 切分核心算法。
   *
   * 非末端模式：只在命中标点时切，且片段长度 >= 1。
   * 末端模式：直接 flush 全部残余 buffer 作为最后一片。
   * 长度保护：非末端模式下若 buffer 超 fragmentationThresholdChars，强制按标点最近的次近点切。
   */
  private tryFlush(isTerminal: boolean, onChunk: ChunkEmitCallback): MessageChunk[] {
    const out: MessageChunk[] = [];
    const threshold = this.config.fragmentationThresholdChars;

    if (isTerminal) {
      // 纯空白残余（真实模型常在句末带换行）不产生气泡，
      // 否则聊天里会出现空气泡；此时引擎的"无终止块"收尾逻辑仍会正常结束本轮流。
      if (!isStructuralNoise(this.buffer)) {
        const chunk = this.chunker.next(this.buffer, this.currentEmotion, true);
        onChunk(chunk);
        out.push(chunk);
      }
      return out;
    }

    // 扫描 buffer，寻找所有切分点
    let scanFrom = 0;
    while (scanFrom < this.buffer.length) {
      const splitIdx = this.findNextSplitIndex(this.buffer, scanFrom);
      if (splitIdx === -1) {
        // 没有切分点，检查是否超过阈值
        const pending = this.buffer.slice(scanFrom);
        if (pending.length >= threshold) {
          // 强制切分：在阈值附近最近的可断点切
          const forcedIdx = this.findSoftBreakIndex(pending, threshold);
          const segment = pending.slice(0, forcedIdx);
          // 纯空白片段直接丢弃（不分配 chunk 序号）
          if (!isStructuralNoise(segment)) {
            const chunk = this.chunker.next(segment, this.currentEmotion, false);
            onChunk(chunk);
            out.push(chunk);
          }
          scanFrom += forcedIdx;
        } else {
          break;
        }
      } else {
        // 切分点：包含标点本身
        const segmentEnd = splitIdx + 1;
        const segment = this.buffer.slice(scanFrom, segmentEnd);
        // 纯空白片段（如连续换行）不产生气泡
        if (!isStructuralNoise(segment)) {
          const chunk = this.chunker.next(segment, this.currentEmotion, false);
          onChunk(chunk);
          out.push(chunk);
        }
        scanFrom = segmentEnd;
      }
    }

    // 收回未切分部分
    this.buffer = this.buffer.slice(scanFrom);
    return out;
  }

  /** 从 from 开始查找下一个切分字符索引，找不到返回 -1。 */
  private findNextSplitIndex(text: string, from: number): number {
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (ch !== undefined && SPLIT_CHARS.has(ch)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 软断点查找：在 hardCap 附近寻找最近的空格或逗号，
   * 都找不到就直接按 hardCap 切。
   */
  private findSoftBreakIndex(text: string, hardCap: number): number {
    const window = 12; // 阈值前后容忍窗口
    const start = Math.max(0, hardCap - window);
    const end = Math.min(text.length, hardCap + window);
    for (let i = end - 1; i >= start; i -= 1) {
      const ch = text[i];
      if (ch !== undefined && (ch === " " || ch === "，" || ch === ",")) {
        return i + 1;
      }
    }
    return Math.min(hardCap, text.length);
  }

  /** 当前 buffer 长度（用于诊断）。 */
  public get pendingLength(): number {
    return this.buffer.length;
  }
}
