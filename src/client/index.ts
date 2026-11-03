/** 将账号余额和模型目录贡献到现有插件详情页。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { AccountCard } from "./AccountCard.js";
import { en, zh, type WorkBuddyLocaleKey } from "./locales.js";
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** WorkBuddy 详情页文案。 */
    workbuddy: WorkBuddyLocaleKey;
  }
}
export const inject = ["slots", "locale"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register("workbuddy", { en, zh }));
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: "dsh-workbuddy",
        locale: "workbuddy",
      },
      AccountCard,
    ),
  );
}
