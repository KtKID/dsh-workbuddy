import { type WorkBuddyTrace } from "./public-schema.js";
/** 返回会话诊断路径；会话标识经哈希编码，任意标识都保持在指定目录内。 */
export declare function transportTracePath(directory: string, sessionId: string): string;
/** 同步追加一条完整诊断；载荷校验和文件错误向请求传播。 */
export declare function appendTransportTrace(directory: string, sessionId: string, trace: WorkBuddyTrace): void;
