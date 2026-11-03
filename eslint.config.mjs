// ESLint Flat Config — TypeScript typed lint 高收益约束
// 用法：复制到项目根目录为 eslint.config.mjs，按项目调整 ignores / files。
// 依赖：typescript eslint @eslint/js typescript-eslint prettier
// 设计：recommendedTypeChecked + 显式高收益规则（不用 strictTypeChecked）

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "lib/**",
    ],
  },

  {
    files: ["**/*.{ts,tsx,mts,cts}"],

    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],

    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },

    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },

    rules: {
      // 禁止主动逃离类型系统
      "@typescript-eslint/no-explicit-any": "error",

      // 防止 any 从第三方库等位置渗透进业务代码
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // 禁止通过 as 强行缩窄类型
      "@typescript-eslint/no-unsafe-type-assertion": "error",

      // 禁止使用 value! 绕过 null / undefined 检查
      "@typescript-eslint/no-non-null-assertion": "error",

      // Promise 必须显式处理；void Promise 也不算已处理
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false,
        },
      ],

      // 禁止把 Promise 用在不接受 Promise 的逻辑位置
      "@typescript-eslint/no-misused-promises": "error",

      // Union / enum 的 switch 必须处理所有状态
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
        },
      ],

      // 纯类型依赖使用 import type
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
