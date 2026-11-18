import type { WorkBuddyConfig } from "./schema.js";
/** 输入 Electron 路径，返回桌面和内嵌 CLI 标识；失败给固定错误且保持凭据未读取。 */
export declare function readWorkBuddyClientHeaders(config: WorkBuddyConfig): Promise<Record<string, string>>;
