import { type LoginPoll, type LoginRegion, type LoginSource, type LoginView } from "./public-schema.js";
import { type WorkBuddyAccount, type WorkBuddyConfig } from "./schema.js";
/** 维护单次网页授权、已选账号与磁盘提交边界。 */
export declare class WorkBuddyLogin {
    private readonly config;
    private readonly file;
    private readonly fetch;
    private readonly now;
    private attempt;
    private committing;
    private readonly onChange;
    constructor(config: WorkBuddyConfig, dependencies?: {
        dataDir?: string;
        fetch?: typeof globalThis.fetch;
        now?: () => number;
        onChange?: () => void;
    });
    private read;
    private privateDirectory;
    private mutate;
    private local;
    private web;
    /** 返回选用方式的凭据，选定方式不可用时抛出固定认证错误。 */
    resolveAccount(): Promise<WorkBuddyAccount>;
    /** 从同一份选用记录生成详情视图与请求凭据。 */
    snapshot(): Promise<{
        view: LoginView;
        account: WorkBuddyAccount | null;
    }>;
    /** 选择可用方式并提交，返回新的详情视图。 */
    select(source: LoginSource): Promise<LoginView>;
    /** 清除插件保存的网页登录凭据，返回本地登录视图。 */
    signOut(): Promise<LoginView>;
    private request;
    /** 向选定地区申请 state，只返回校验过的官方地址和本地尝试编号。 */
    start(region: LoginRegion): Promise<{
        loginId: string;
        url: string;
        expiresInMs: number;
    }>;
    /** 查询一次授权结果，并合并同一个编号的在途请求。 */
    poll(id: string): Promise<LoginPoll>;
    private exchange;
}
