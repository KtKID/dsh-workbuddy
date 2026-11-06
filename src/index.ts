/** 注册 WorkBuddy 模型、会话传输记录与账号详情路由。 */
import type { Context } from "@deepseek-ai/cordis";
import { WorkBuddyAdapter } from "./adapter.js";
import { WorkBuddyApi } from "./api.js";
import { WorkBuddyLogin } from "./web-login.js";
import { mountWeb } from "./web.js";
import { appendTransportTrace } from "./transport-log.js";
import { ConfigSchema, type WorkBuddyConfig } from "./schema.js";
import type {} from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-user-approval";
import { z } from "zod";
export { Config } from "./schema.js";
export const name = "dsh-workbuddy";
export const inject = ["llm", "sessions"];
declare module "@deepseek-ai/cordis" {
  interface Events {
    "workbuddy/credit"(credit: number): void;
  }
}

const SandboxPolicyService = z.custom<{
  resolve(request: { session: Session }): unknown;
}>(
  (service) =>
    typeof service === "object" &&
    service !== null &&
    "resolve" in service &&
    typeof service.resolve === "function",
);
const FullAccessPolicy = z.object({ mode: z.literal("danger-full-access") });

/** 助手 replayState 保存会话关联；传输诊断由本插件按会话单独落盘。 */
export function apply(ctx: Context, input: WorkBuddyConfig): void {
  const config = ConfigSchema.parse(input ?? {});
  const login = new WorkBuddyLogin(config, {
    onChange: () => {
      api.invalidate();
      try {
        registration.replace(["workbuddy"]);
      } catch {
        ctx.logger.warn("WorkBuddy 模型目录更新通知未发出");
      }
    },
  });
  const account = () => login.resolveAccount();
  const api = new WorkBuddyApi(config, { account });
  const registration = ctx.llm.registerAdapter(
    ["workbuddy"],
    new WorkBuddyAdapter(config, {
      account,
      models: (selection) => api.models(selection),
      onCredit: (credit) => ctx.emit("workbuddy/credit", credit),
      onTrace: (id, trace) => {
        if (id) appendTransportTrace(config.traceDir, id, trace);
      },
      cwd: (options) =>
        options.sessionId
          ? ctx.get("agents")?.get(options.sessionId)?.session.header.cwd
          : undefined,
      permissionMode: ({ sessionId }) => {
        const session = sessionId && ctx.sessions.get(sessionId);
        if (!session) return "default";
        const approval = ctx.get("approval");
        if (!approval) return "default";
        const policy = approval.overrideOf(session) ?? approval.config.policy;
        if (policy !== "never") return "default";
        // 通过 Cordis 读取可选服务，兼容未挂载沙箱策略的宿主。
        const sandbox = SandboxPolicyService.safeParse(
          ctx.get("sandboxPolicy"),
        );
        return sandbox.success &&
          FullAccessPolicy.safeParse(sandbox.data.resolve({ session })).success
          ? "bypassPermissions"
          : "default";
      },
      onRejectedTurn: (options) => {
        if (options.sessionId)
          ctx
            .get("agents")
            ?.get(options.sessionId)
            ?.cancel(
              { kind: "hook", reason: "WorkBuddy 在审批拒绝后取消本轮" },
              { keepInbox: true },
            );
      },
      onPermission: async (options, request, signal) => {
        const agent = options.sessionId
          ? ctx.get("agents")?.get(options.sessionId)
          : undefined;
        const approval = ctx.get("approval");
        if (!agent || !approval) return false;
        // WB 的 codebuddy.ai/toolName 扩展由已安装 CLI 的 ACP 审批发送端提供。
        const nativeName = z
          .string()
          .safeParse(request.toolCall._meta?.["codebuddy.ai/toolName"]);
        const toolName =
          request.toolCall.name ??
          (nativeName.success
            ? nativeName.data
            : (request.toolCall.kind ?? "tool"));
        const reason = [
          `WorkBuddy 原生工具 ${toolName} 请求执行`,
          request.toolCall.title,
          JSON.stringify(request.toolCall.rawInput),
          JSON.stringify(request.toolCall.locations),
          JSON.stringify(request.toolCall._meta),
        ]
          .filter(Boolean)
          .join("\n");
        return (
          (await approval.request({
            agent,
            toolName: `workbuddy:${toolName}`,
            reason,
            signal,
          })) === "allowed-once"
        );
      },
    }),
  );
  ctx.inject(["connection"], (scope) => mountWeb(scope, api, login));
}
