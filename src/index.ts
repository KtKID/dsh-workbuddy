/** 注册 WorkBuddy 模型、会话传输记录与账号详情路由。 */
import type { Context } from "@deepseek-ai/cordis";
import { WorkBuddyAdapter } from "./adapter.js";
import { WorkBuddyApi } from "./api.js";
import { mountWeb } from "./web.js";
import { appendTransportTrace } from "./transport-log.js";
import { ConfigSchema, type WorkBuddyConfig } from "./schema.js";
export { Config } from "./schema.js";
export const name = "dsh-workbuddy";
export const inject = ["llm", "sessions"];
declare module "@deepseek-ai/cordis" {
  interface Events {
    "workbuddy/credit"(credit: number): void;
  }
}
/** 助手 replayState 保存会话关联；传输诊断由本插件按会话单独落盘。 */
export function apply(ctx: Context, input: WorkBuddyConfig): void {
  const config = ConfigSchema.parse(input ?? {});
  const api = new WorkBuddyApi(config);
  ctx.llm.registerAdapter(
    ["workbuddy"],
    new WorkBuddyAdapter(config, {
      models: () => api.models(),
      onCredit: (credit) => ctx.emit("workbuddy/credit", credit),
      onTrace: (id, trace) => {
        if (id) appendTransportTrace(config.traceDir, id, trace);
      },
    }),
  );
  ctx.inject(["connection"], (scope) => mountWeb(scope, api));
}
