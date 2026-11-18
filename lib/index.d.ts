/** 注册 WorkBuddy 模型、会话传输记录与账号详情路由。 */
import type { Context } from "@deepseek-ai/cordis";
import { type WorkBuddyConfig } from "./schema.js";
export { Config } from "./schema.js";
export declare const name = "dsh-workbuddy";
export declare const inject: string[];
declare module "@deepseek-ai/cordis" {
    interface Events {
        "workbuddy/credit"(credit: number): void;
    }
}
/** 助手 replayState 保存会话关联；传输诊断由本插件按会话单独落盘。 */
export declare function apply(ctx: Context, input: WorkBuddyConfig): void;
