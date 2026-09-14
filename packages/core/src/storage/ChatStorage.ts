/**
 * @file ChatStorage.ts
 * IndexedDB 抽象层（零外部依赖）。
 *
 * 提供简单的 key-value 存储接口，封装 IndexedDB 的异步操作。
 * 用于 zustand persist middleware 的底层存储。
 *
 * 设计：
 * - 单例 DB 连接，组件 unmount 不关闭（浏览器自动管理）
 * - 隐私模式（IDB 禁用）→ 所有操作静默失败，返回 null
 * - 异步 API，所有方法返回 Promise
 */

/** DB 名称。 */
const DB_NAME = "wechat-rp-chat";
/** Store 名称（key-value 模式）。 */
const STORE_NAME = "kv";
/** DB 版本。 */
const DB_VERSION = 1;

/** 单例 DB 连接。 */
let dbInstance: IDBDatabase | null = null;

/** 是否支持 IndexedDB。 */
function isIDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * 打开（或创建）IndexedDB 连接。
 * 隐私模式下会 reject，调用方应 catch。
 */
function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!isIDBAvailable()) {
    return Promise.reject(new Error("IndexedDB not available"));
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 读取一个值。
 * @param key 存储 key
 * @returns 值（不存在时返回 null）
 */
export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB();
    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IDB 不可用（隐私模式等），静默返回 null
    return null;
  }
}

/**
 * 写入一个值。
 * @param key 存储 key
 * @param value 要存储的值（必须可结构化克隆）
 */
export async function setItem<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IDB 不可用，静默失败
  }
}

/**
 * 删除一个值。
 */
export async function removeItem(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IDB 不可用，静默失败
  }
}

/**
 * 清空所有存储（用于调试/重置）。
 */
export async function clearAll(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IDB 不可用，静默失败
  }
}
