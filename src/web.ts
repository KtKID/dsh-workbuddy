/** 经现有宿主通道提供账号快照与网页登录操作。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { z } from "zod";
import type { WorkBuddyApi } from "./api.js";
import type { WorkBuddyLogin } from "./web-login.js";
import {
  LoginPollRequest,
  LoginPollResponse,
  LoginSelectRequest,
  LoginSignOutRequest,
  LoginStartRequest,
  LoginStartResponse,
  LoginViewSchema,
  StatusSchema,
} from "./public-schema.js";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function loginRoute<T>(
  ctx: Context,
  action: string,
  schema: z.ZodType<T>,
  run: (input: T) => Promise<unknown>,
): void {
  ctx.connection.fetch.register({
    path: `/api/workbuddy/login/${action}`,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const body: unknown = await request.json().catch(() => undefined);
      const input = schema.safeParse(body);
      if (!input.success)
        return json({ error: "WORKBUDDY_LOGIN_INVALID_REQUEST" }, 400);
      try {
        return json(await run(input.data));
      } catch {
        return json({ error: "WORKBUDDY_LOGIN_UNAVAILABLE" }, 409);
      }
    },
  });
}

/** 绑定账号快照与网页登录路由，输出只包含界面可用字段。 */
export function mountWeb(
  ctx: Context,
  api: WorkBuddyApi,
  login: WorkBuddyLogin,
): void {
  ctx.connection.fetch.register({
    path: "/api/workbuddy/status",
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const snapshot = await login.snapshot().catch(() => undefined);
      const status = await api.status(
        request.method === "POST",
        snapshot?.account ?? null,
      );
      return json(
        StatusSchema.parse({
          ...status,
          ...(snapshot
            ? {
                login: snapshot.view,
                error: snapshot.account ? status.error : null,
              }
            : {}),
        }),
      );
    },
  });
  loginRoute(ctx, "start", LoginStartRequest, async ({ region }) =>
    LoginStartResponse.parse(await login.start(region)),
  );
  loginRoute(ctx, "poll", LoginPollRequest, async ({ loginId }) =>
    LoginPollResponse.parse(await login.poll(loginId)),
  );
  loginRoute(ctx, "select", LoginSelectRequest, async ({ source }) =>
    LoginViewSchema.parse(await login.select(source)),
  );
  loginRoute(ctx, "sign-out", LoginSignOutRequest, async () =>
    LoginViewSchema.parse(await login.signOut()),
  );
}
