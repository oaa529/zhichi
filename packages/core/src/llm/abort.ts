/**
 * @file abort.ts
 * 把多个 AbortSignal 合并成一个（任一中止即中止）。
 *
 * 为什么不直接用 `AbortSignal.any`：它是较新的 API——jsdom（测试环境）里没有，
 * 一些内嵌 WebView 里也没有。适配器在"发消息"这条主链路上，一旦这里抛
 * TypeError，用户看到的就是"发出去没反应"。所以留一个纯事件监听的退化实现。
 */

/** `AbortSignal.any` 的类型（部分环境没有）。 */
type AnySignalFn = (signals: ReadonlyArray<AbortSignal>) => AbortSignal;

/**
 * 合并多个 signal：其中任意一个被中止，返回的 signal 也会中止。
 *
 * @param signals 待合并的 signal（至少一个；空数组返回一个永不中止的 signal）
 */
export function mergeAbortSignals(
  signals: ReadonlyArray<AbortSignal>,
): AbortSignal {
  if (signals.length === 1) return signals[0]!;

  const anyFn = (AbortSignal as unknown as { any?: AnySignalFn }).any;
  if (typeof anyFn === "function") return anyFn(signals);

  // 退化实现：谁先中止就把合成 signal 也中止
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
