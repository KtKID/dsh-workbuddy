/** 经现有宿主通道提供账号快照与网页登录操作。 */
import type { Context } from "@deepseek-ai/cordis";
import type { WorkBuddyApi } from "./api.js";
import type { WorkBuddyLogin } from "./web-login.js";
/** 绑定账号快照与网页登录路由，输出只包含界面可用字段。 */
export declare function mountWeb(ctx: Context, api: WorkBuddyApi, login: WorkBuddyLogin): void;
