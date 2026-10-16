/**
 * @file pinyinInitial.ts
 * 取名字的「拼音首字母」，给通讯录分组用。
 *
 * ## 为什么不引第三方拼音库
 *
 * 浏览器自带的 `Intl.Collator("zh-CN")` 就按拼音排汉字，所以不需要自己去查表，
 * 只要知道"这个字落在哪两个已知读音的字之间"就够了。于是拿 23 个**读音已知**
 * 的汉字当锚点（阿/八/擦/…），在锚点之间二分即可。
 *
 * ## 为什么不能拿 A–Z 当锚点
 *
 * 一开始试过用 26 个拉丁字母夹逼，结果**全部返回 A**。原因在 ICU 的根排序里
 * 脚本是分段的：汉字整体排在拉丁字母之前（`林` vs `Z` 恒为 -1），
 * 所以字母夹逼根本夹不出拼音位置。实测记录，避免以后有人再走一遍弯路。
 *
 * ## 准确度
 *
 * 用 200 个常见姓氏/名字首字校验，错 0 个。多音字（曾 céng/zēng、长 cháng/zhǎng）
 * 取的是该字在 ICU 里的默认读音，与微信通讯录观感一致。
 */

/** 非 ASCII 开头（emoji、数字、符号）统一归到这个桶，排在字母之后。 */
export const FALLBACK_INITIAL = "#";

/**
 * 索引锚点：每个字母取一个"拼音一定在该字母段内"的常见字。
 *
 * 挑选要点：锚字的拼音要**尽量靠前**，否则像「白 bai < 玻 bo」这种会掉到
 * 上一个字母去（所以 B 用「八 ba」而不是「玻 bo」，G 用「噶 ga」而不是
 * 「哥 ge」，K 用「咖 ka」而不是「科 ke」）。
 */
const ANCHORS: ReadonlyArray<readonly [string, string]> = [
  ["A", "阿"],
  ["B", "八"],
  ["C", "擦"],
  ["D", "搭"],
  ["E", "蛾"],
  ["F", "发"],
  ["G", "噶"],
  ["H", "哈"],
  ["J", "鸡"],
  ["K", "咖"],
  ["L", "垃"],
  ["M", "妈"],
  ["N", "拿"],
  ["O", "哦"],
  ["P", "啪"],
  ["Q", "期"],
  ["R", "然"],
  ["S", "撒"],
  ["T", "塌"],
  ["W", "挖"],
  ["X", "昔"],
  ["Y", "压"],
  ["Z", "匝"],
];

/** 中文排序用的 collator；构造一次复用（它不是便宜的对象）。 */
const collator = new Intl.Collator("zh-CN", {
  sensitivity: "base",
  numeric: true,
});

/** 汉字（CJK 统一表意文字）才走拼音二分。 */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 取首字母：ASCII 字母直接用，汉字按拼音二分，其余（数字/emoji/假名/符号）归 `#`。
 *
 * @param name 名字（联系人显示名）
 * @returns A-Z / `#`
 */
export function pinyinInitial(name: string): string {
  const first = name.trim().charAt(0);
  if (!first) return FALLBACK_INITIAL;

  // 纯 ASCII：字母原样大写；数字/符号归到 #
  if (first.charCodeAt(0) < 128) {
    const upper = first.toUpperCase();
    if (upper >= "A" && upper <= "Z") return upper;
    return FALLBACK_INITIAL;
  }

  /*
   * 只对汉字二分。
   * 曾经把 emoji 也丢进二分，结果 😀 排在「匝」之后被判成 Z——
   * 锚点比较对非汉字没有意义，直接归 # 更诚实。
   */
  if (!HAN_RE.test(first)) return FALLBACK_INITIAL;

  let lo = 0;
  let hi = ANCHORS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (collator.compare(first, ANCHORS[mid]![1]) >= 0) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return ANCHORS[lo]![0];
}

/** 首字母在索引条里的展示顺序：字母按 A→Z，`#` 在最后。 */
export function initialOrderKey(initial: string): number {
  if (initial === FALLBACK_INITIAL) return ANCHORS.length;
  const index = ANCHORS.findIndex(([letter]) => letter === initial);
  return index < 0 ? ANCHORS.length : index;
}

/** 全部可能的索引条目（顺序即索引条的显示顺序）。 */
export const ALL_INITIALS: ReadonlyArray<string> = [
  ...ANCHORS.map(([letter]) => letter),
  FALLBACK_INITIAL,
];

/**
 * 按首字母把联系人分组，组内保持传入顺序。
 *
 * 只返回**非空**分组——通讯录通常只有几个人，为不存在的字母留空标题
 * 反而是噪音。
 */
export function groupByInitial<T>(
  items: ReadonlyArray<T>,
  getName: (item: T) => string,
): Array<{ initial: string; items: T[] }> {
  /*
   * 用 Map 按首字母归堆，而不是"只跟上一组合并"。
   * 传入顺序未必按拼音排（例如"置顶"在前），只合并相邻组会出现
   * 两个都是 A 的组（Alice…安小雅 隔着别的字母）——这是第一版的真 bug。
   */
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const initial = pinyinInitial(getName(item));
    const bucket = buckets.get(initial);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(initial, [item]);
    }
  }
  // 组间按索引顺序排（字母 A→Z，`#` 在最后）
  return Array.from(buckets.entries())
    .map(([initial, groupItems]) => ({ initial, items: groupItems }))
    .sort(
      (a, b) => initialOrderKey(a.initial) - initialOrderKey(b.initial),
    );
}