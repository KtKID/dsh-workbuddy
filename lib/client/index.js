import { AccountCard } from "./AccountCard.js";
import { en, zh } from "./locales.js";
export const inject = ["slots", "locale"];
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register("workbuddy", { en, zh }));
    ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: "dsh-workbuddy",
        locale: "workbuddy",
    }, AccountCard));
}
