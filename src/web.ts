/** 经宿主鉴权通道提供账号快照；POST 执行一次手动刷新。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { WorkBuddyApi } from "./api.js";
import { StatusSchema } from "./public-schema.js";
export function mountWeb(ctx: Context, api: WorkBuddyApi): void {
  ctx.connection.fetch.register({
    path: "/api/workbuddy/status",
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) =>
      Response.json(
        StatusSchema.parse(await api.status(request.method === "POST")),
        { headers: { "Cache-Control": "no-store" } },
      ),
  });
}
