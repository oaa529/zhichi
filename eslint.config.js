/**
 * @file eslint.config.js
 * 全仓库 lint 配置（ESLint 9 flat config）。
 *
 * 设计取向：**专抓真问题，不做格式化工**。
 * - 格式/风格一律不配（不引入 prettier）：风格靠 review 与一致性，
 *   格式规则只会制造无意义 diff；
 * - 类型层面的正确性已经由 tsc --strict + 938 个测试把关，
 *   所以 typescript-eslint 用**非类型检查**的 recommended（快），
 *   只补两件 tsc 不管或管不动的：no-explicit-any（守住 README 的
 *   「零 any」宣称）与 React hooks 规则；
 * - react-hooks 只开 rules-of-hooks（error）与 exhaustive-deps（warn）：
 *   v7 推荐集里那批面向 React Compiler 的新规则（immutability/purity/
 *   set-state-in-effect…）对本项目是噪音，暂不启用。
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  // ---------- 不检查的目录 ----------
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "**/gen/**",
      "coverage/**",
      ".pw-profile/**",
      ".playwright-cli/**",
    ],
  },

  // ---------- JS 基础 ----------
  js.configs.recommended,

  // ---------- TypeScript（非类型检查版） ----------
  ...tseslint.configs.recommended,

  // ---------- 全局规则 ----------
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // 与 tsconfig 的 noUnusedLocals/noUnusedParameters 对齐：
      // tsc 管"声明未使用"，这里额外放过下划线前缀的入参惯用法
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // README 写着「全量 TypeScript strict，零 any」——这条就是守住它的
      "@typescript-eslint/no-explicit-any": "error",
      // 本项目刻意用 console 打带前缀的日志（[auto-backup]、[backup]…）
      "no-console": "off",
      // 全角空格（U+3000）在中文项目里是**合法排版字符**：导出的 Markdown、
      // 界面文案都刻意用它做视觉分隔。这条规则本是给拉丁代码抓"隐形字符"的，
      // 所以只保留对"真实代码位置"的检查，字符串/模板/注释里的一律放过
      "no-irregular-whitespace": [
        "error",
        {
          skipComments: true,
          skipStrings: true,
          skipTemplates: true,
          skipRegExps: true,
        },
      ],
    },
  },

  // ---------- React（组件库与组装层） ----------
  {
    files: [
      "packages/ui-wechat/**/*.{ts,tsx}",
      "apps/web/**/*.{ts,tsx}",
    ],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // 条件渲染 hooks / effect 依赖写漏是这批代码的主要风险面，
      // 但依赖数组很多时候是刻意的最小集——所以是 warn 不是 error，
      // 现有代码里 10 处 eslint-disable 注释继续有效
      "react-hooks/exhaustive-deps": "warn",
      // Vite 快速刷新要求组件文件只导出组件；纯函数/常量文件不受影响
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // ---------- 测试文件 ----------
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 测试里大量 as unknown as X 的替身（jsdom 的 File、Tauri 注入…），
      // 类型断言密度天然高；no-explicit-any 仍然生效（不许真 any）
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // ---------- work/ 真机探针脚本 ----------
  // 一次性探针：console 输出就是它们的产物，未使用变量是探针的常态
  // （留一组 ctx 常量方便手动替换），且文本载荷里刻意用全角空格做中文排版
  {
    files: ["work/**/*.{ts,mts,mjs,cjs,js}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-irregular-whitespace": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-undef": "off",
    },
  },
);
