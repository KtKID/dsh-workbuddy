/** 按显式配置或 Mac 默认安装目录定位官方 CLI；元数据与执行共用此路径。 */
import { dirname, resolve } from "node:path";
import type { WorkBuddyConfig } from "./schema.js";

/** 返回 CLI 入口的绝对路径；文件可读性由实际读取或执行验证。 */
export function resolveWorkBuddyCli(config: WorkBuddyConfig): string {
  return (
    config.cliPath ??
    resolve(
      dirname(config.electronPath),
      "../Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs",
    )
  );
}
