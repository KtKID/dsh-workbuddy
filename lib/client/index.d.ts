/** 将账号余额和模型目录贡献到现有插件详情页。 */
import type { Context } from "@deepseek-ai/cordis";
import { type WorkBuddyLocaleKey } from "./locales.js";
declare module "@deepseek-ai/dsh-client-ui-slots" {
    interface LocaleNamespaceMap {
        /** WorkBuddy 详情页文案。 */
        workbuddy: WorkBuddyLocaleKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: Context): void;
