import type { WorkBuddyConfig } from "./schema.js";
/** 返回 CLI 入口的绝对路径；文件可读性由实际读取或执行验证。 */
export declare function resolveWorkBuddyCli(config: WorkBuddyConfig): string;
