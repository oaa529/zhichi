import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    // React 必须全局唯一：packages/ui-wechat 的 node_modules 里也有一份 react，
    // 若不去重，vite 预构建会把 zustand/react/shallow 这类"自己调用 hooks"
    // 的依赖接到另一份 React 上，运行时报 "Invalid hook call"
    // （Cannot read properties of null (reading 'useRef')）。
    dedupe: ["react", "react-dom"],
    alias: {
      "@wechat-rp/shared-types": path.resolve(
        projectRoot,
        "shared/types/src/index.ts",
      ),
      "@wechat-rp/core": path.resolve(projectRoot, "packages/core/src/index.ts"),
      "@wechat-rp/ui-wechat": path.resolve(
        projectRoot,
        "packages/ui-wechat/src/index.ts",
      ),
    },
  },
  server: {
    port: 5174,
    host: true,
  },
});
