import { type Credentials, type WorkBuddyConfig } from "./schema.js";
/** 输入应用和登录文件路径；返回只读凭据，缺失或不可读时抛出 LlmError。 */
export declare function readDesktopCredentials(config: WorkBuddyConfig): Promise<Credentials>;
