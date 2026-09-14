/**
 * @file useViewportResize.ts
 * 移动端键盘自适应 hook。
 *
 * 职责：
 * - 监听 visualViewport resize 事件
 * - 计算键盘高度 = window.innerHeight - visualViewport.height
 * - 返回键盘高度供组件调整布局
 *
 * 清理：unmount 时 removeEventListener
 */

import { useEffect, useState } from "react";

export interface IViewportResizeResult {
  /** 键盘高度（px），0 表示无键盘。 */
  readonly keyboardHeight: number;
  /** 是否为移动端（visualViewport 可用）。 */
  readonly isMobile: boolean;
}

/**
 * 移动端键盘自适应 hook。
 */
export function useViewportResize(): IViewportResizeResult {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof visualViewport === "undefined") {
      setIsMobile(false);
      return;
    }

    setIsMobile(true);

    const vv = visualViewport; // 捕获到局部变量
    if (!vv) return;

    const handleResize = () => {
      const height = window.innerHeight - vv.height;
      setKeyboardHeight(Math.max(0, height));
    };

    handleResize(); // 初始调用
    vv.addEventListener("resize", handleResize);
    return () => {
      vv.removeEventListener("resize", handleResize);
    };
  }, []);

  return { keyboardHeight, isMobile };
}
