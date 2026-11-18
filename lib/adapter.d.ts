/** 将 KMH 的单轮文本模型调用接到 WorkBuddy 远程推理。 */
import { type WorkBuddyPermissionMode } from "./native.js";
import { LlmAdapter, type GenerateOptions, type StreamChunk, type LlmModelInfo, type LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import type { WorkBuddyTrace } from "./public-schema.js";
import { type Credentials, type WorkBuddyAccount, type WorkBuddyConfig } from "./schema.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
export interface TransportDependencies {
    credentials?: () => Promise<Credentials>;
    account?: () => Promise<WorkBuddyAccount>;
    fetch?: typeof globalThis.fetch;
    onCredit?: (credit: number) => void;
    models?: (account?: WorkBuddyAccount) => Promise<readonly LlmModelInfo[]>;
    onTrace?: (sessionId: string | undefined, trace: WorkBuddyTrace) => void;
    onPermission?: (options: GenerateOptions, request: RequestPermissionRequest, signal: AbortSignal) => Promise<boolean>;
    cwd?: (options: GenerateOptions) => string | undefined;
    permissionMode?: (options: GenerateOptions) => WorkBuddyPermissionMode;
    onRejectedTurn?: (options: GenerateOptions) => void;
}
/** 持有一次实例的配置；每轮读取当前登录凭据并执行一次请求。 */
export declare class WorkBuddyAdapter extends LlmAdapter {
    readonly config: WorkBuddyConfig;
    readonly dependencies: TransportDependencies;
    constructor(config: WorkBuddyConfig, dependencies?: TransportDependencies);
    /** 读取远端对话模型目录；独立夹具可使用配置中的单模型。 */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** 校验当前 provider/model，返回文本模型能力；路由失配抛出 LlmError。 */
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    private resolveSelectedModel;
    /** 输入完整文本请求，返回模型流；协议或范围错误向 LLM 服务传播。 */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
