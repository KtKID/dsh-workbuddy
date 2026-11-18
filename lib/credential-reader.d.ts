import { type Credentials } from "./schema.js";
/** 输入登录文件与应用保护材料，返回可用凭据；保护校验失败抛出错误。 */
export declare function decryptDesktopCredentials(login: unknown, build: unknown): Credentials;
