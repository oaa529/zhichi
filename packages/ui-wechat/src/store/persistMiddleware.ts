/**
 * @file persistMiddleware.ts
 * zustand persist 的 IndexedDB 存储适配器。
 *
 * 将 core 包的 ChatStorage（IndexedDB）适配为 zustand persist 所需的
 * StateStorage 接口（string-based）。
 *
 * 使用 createJSONStorage 包装，自动处理 JSON 序列化/反序列化。
 */

import type { StateStorage } from "zustand/middleware";
import { getItem, setItem, removeItem } from "@wechat-rp/core";

/** IndexedDB 存储适配器（zustand persist 用）。 */
export const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const value = await getItem<unknown>(name);
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      // 旧数据或损坏数据（非字符串），清除
      console.warn("[idbStorage] non-string value found, clearing");
      await removeItem(name);
      return null;
    }
    return value;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await setItem(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await removeItem(name);
  },
};

/** zustand persist 的 storage key。 */
export const STORAGE_KEY = "wechat-rp-session";
