/**
 * @file Icon.tsx
 * 应用图标入口。
 *
 * 内部改用 lucide-react（统一线形图标库），但**对外的 API 保持不变**：
 * 仍然是 `<Icon name="chat" size={20} />` 这一种用法，
 * 于是全仓库 200 多处调用点一行都不用改，以后想换图标库也只改这一个文件。
 *
 * 为什么用图标库而不是继续手画：手画的 20 个图标粗细/圆角/栅格各自微调过，
 * 整体看永远差一口气；lucide 全部同一套 24 栅格 + 2px 描边，
 * 天然整齐，且按名字引入（tree-shaking 后只打包用到的）。
 */

import { memo } from "react";
import type { FC } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Download,
  Heart,
  Link as LinkIcon,
  MessageCircle,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  Smile,
  Sparkles,
  Sun,
  Upload,
  Users,
  X,
  Check,
} from "lucide-react";

export type IconName =
  | "chat"
  | "contacts"
  | "settings"
  | "send"
  | "prompt"
  | "close"
  | "plus"
  | "check"
  | "sparkles"
  | "heart"
  | "link"
  | "moon"
  | "sun"
  | "back"
  | "search"
  | "more"
  | "memory"
  | "plot"
  | "download"
  | "upload"
  | "smile";

export interface IIconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  /** 描边宽度（lucide 默认 2；本项目原来手画的是 1.8，保持一致）。 */
  readonly strokeWidth?: number;
}

/** 应用图标名 → lucide 组件。 */
const ICONS: Record<IconName, LucideIcon> = {
  chat: MessageCircle,
  contacts: Users,
  settings: Settings,
  send: Send,
  prompt: MessageSquare,
  close: X,
  plus: Plus,
  check: Check,
  sparkles: Sparkles,
  heart: Heart,
  link: LinkIcon,
  moon: Moon,
  sun: Sun,
  back: ArrowLeft,
  search: Search,
  more: MoreHorizontal,
  memory: Brain,
  plot: BookOpen,
  download: Download,
  upload: Upload,
  smile: Smile,
};

export const Icon: FC<IIconProps> = memo(
  ({ name, size = 20, className, strokeWidth = 1.8 }) => {
    const LucideIcon = ICONS[name];
    return (
      <LucideIcon
        size={size}
        className={className}
        strokeWidth={strokeWidth}
        aria-hidden="true"
      />
    );
  },
);

Icon.displayName = "Icon";
