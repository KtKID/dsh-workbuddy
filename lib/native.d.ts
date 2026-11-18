import { type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Credentials, WorkBuddyConfig } from "./schema.js";
import type { LoginRegion, WorkBuddyTrace } from "./public-schema.js";
export type WorkBuddyPermissionMode = "default" | "bypassPermissions";
/** 输入 KMH 完整历史，输出有序流；SDK 管理协议与请求关联，本函数拥有子进程和临时工具桥。 */
export declare function nativeCompletion(options: GenerateOptions, config: WorkBuddyConfig, credentials: Credentials, onTrace: (trace: WorkBuddyTrace) => void, onPermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<boolean>, cwd?: string, onRejectedTurn?: () => void, webRegion?: LoginRegion, permissionMode?: WorkBuddyPermissionMode): AsyncIterable<StreamChunk>;
