/** 组装真实 KMH Agent、Session 与 JSONL 持久化服务；外部传输由调用方选择。 */
import { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import Llm, { createUserMessage } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import * as Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as NativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import * as plugin from "../../lib/index.js";
export async function sessionRuntime(
  root,
  config = {},
  compression = "none",
  cwd = process.cwd(),
) {
  const ctx = new Context();
  for (const [entry, settings] of [
    [Llm, {}],
    [Sessions, {}],
    [Projection, {}],
    [Prompt, {}],
    [Tools, {}],
    [NativeExecutor, {}],
    [Agents, {}],
    [Persistence, { root, compression }],
    [Loop, { agents: [] }],
    [plugin, { traceDir: join(root, "..", "workbuddy-transport"), ...config }],
  ])
    await ctx.plugin(entry, settings);
  return {
    ctx,
    async send(id, text = "hi", model = "deepseek-v4-flash") {
      const agent = await ctx.agentLoop.create(
        SessionId(id),
        { provider: "workbuddy", model, maxTokens: 512 },
        { cwd },
      );
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
      const deadline = Date.now() + 65000;
      while (
        !agent.session.snapshotEvents().some((e) => e.type === "turn/end") ||
        agent.status !== "idle"
      ) {
        if (Date.now() > deadline) throw new Error("SESSION_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await ctx.sessions.flush(agent.session);
      return agent;
    },
    close: () => ctx.fiber.dispose(),
  };
}
