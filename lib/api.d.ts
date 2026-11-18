/** 读取官方账号余额和模型目录；按账号缓存并合并并发刷新。 */
import { type LlmModelContext, type LlmModelInfo } from "@deepseek-ai/dsh-llm";
import type { WorkBuddyAccount, Credentials, WorkBuddyConfig } from "./schema.js";
import { type WorkBuddyStatus } from "./public-schema.js";
export interface WorkBuddyModelInfo extends LlmModelInfo {
    context?: LlmModelContext;
    maxOutputTokens?: number;
}
export interface ApiDependencies {
    credentials?: () => Promise<Credentials>;
    account?: () => Promise<WorkBuddyAccount>;
    fetch?: typeof globalThis.fetch;
}
/** 一个插件实例持有一份按当前账号隔离的快照。 */
export declare class WorkBuddyApi {
    readonly config: WorkBuddyConfig;
    readonly dependencies: ApiDependencies;
    private key;
    private generation;
    private expiresAt;
    private pending;
    private value;
    constructor(config: WorkBuddyConfig, dependencies?: ApiDependencies);
    /** 账号变化时使当前快照与在途查询失效。 */
    invalidate(): void;
    private reset;
    /** 输入可选的同请求账号快照，返回积分及模型，失败保留同账号上次成功值。 */
    status(force?: boolean, selection?: WorkBuddyAccount | null): Promise<WorkBuddyStatus>;
    /** 返回可对话模型；无有效目录时传播固定错误。 */
    models(account?: WorkBuddyAccount): Promise<WorkBuddyModelInfo[]>;
    /** 两项独立只读查询；只向固定官方来源发送凭据，统一校验响应。 */
    private refresh;
}
