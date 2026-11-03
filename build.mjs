/** 构建宿主 TypeScript 与浏览器详情卡片；失败保留编译诊断。 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
  { cwd: new URL(".", import.meta.url), stdio: "inherit" },
);
await build({
  absWorkingDir: new URL(".", import.meta.url).pathname,
  entryPoints: ["src/client/index.ts"],
  outfile: "lib/client.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  jsx: "automatic",
  external: [
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-slots",
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-workbuddy",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: "return module.exports;}});" },
});
