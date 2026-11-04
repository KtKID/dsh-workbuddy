/** 官方 ACP Agent 夹具；通过真实子进程连接测试插件，外部模型由确定性场景替代。 */
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { appendFile, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function serve({
  root,
  mode = "text",
  stopReason = "end_turn",
  loadSession = true,
  loadFails = false,
  expectedAuth,
  expectedModel,
  expectedPrompt,
  permanentOnly = false,
  stopAfterReject = false,
}) {
  const args = process.argv;
  assert.ok(args.includes("--acp"), "official ACP entry required");
  assert.equal(args[args.indexOf("--max-turns") + 1], "99");
  assert.equal(args[args.indexOf("--tools") + 1], "default");
  assert.ok(!args.includes("--output-format"));
  if (expectedAuth)
    assert.equal(process.env.CODEBUDDY_AUTH_TOKEN, expectedAuth);
  if (expectedModel)
    assert.equal(args[args.indexOf("--model") + 1], expectedModel);
  await writeFile(join(root, "pid"), String(process.pid));
  const record = (value) =>
    appendFile(join(root, "requests.jsonl"), JSON.stringify(value) + "\n");
  const sessions = new Map();
  const untilFile = async (name) => {
    while (true) {
      try {
        await access(join(root, name));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
  const app = agent({ name: "workbuddy-acp-fixture" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession, mcpCapabilities: { http: true } },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      await record({ method: "new", params });
      return { sessionId: `fixture-${randomUUID()}` };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      await record({ method: "load", params });
      if (loadFails) throw new Error("FIXTURE_SESSION_MISSING");
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OLD_REPLAY" },
        },
      });
      if (mode === "usage")
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 999999,
            size: 1000000,
            _meta: {
              "codebuddy.ai/messageId": "history-only",
              usage: {
                prompt_tokens: 999999,
                completion_tokens: 999999,
                total_tokens: 1999998,
              },
            },
          },
        });
      return {};
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.abort();
    })
    .onRequest(
      methods.agent.session.prompt,
      async ({ params, client, signal }) => {
        await record({ method: "prompt", params });
        if (expectedPrompt)
          assert.ok(
            params.prompt.some(
              (block) =>
                block.type === "text" && block.text.includes(expectedPrompt),
            ),
          );
        const local = new AbortController();
        sessions.set(params.sessionId, local);
        const stopped = AbortSignal.any([signal, local.signal]);
        const update = (update) =>
          client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update,
          });
        if (mode === "usage") {
          const values = JSON.parse(
            await readFile(
              new URL("../fixtures/acp-usage.json", import.meta.url),
              "utf8",
            ),
          );
          for (const value of values) await update(value);
          return { stopReason };
        }
        if (mode === "failure") throw new Error("FIXTURE_AGENT_FAILURE");
        if (mode === "crash") process.exit(7);
        if (mode === "wait" || mode === "stream-wait") {
          if (mode === "stream-wait")
            await update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "first chunk" },
            });
          await writeFile(join(root, "waiting"), "ready");
          if (!stopped.aborted)
            await new Promise((resolve) =>
              stopped.addEventListener("abort", resolve, { once: true }),
            );
          await writeFile(join(root, "cancelled"), "cancelled");
          return { stopReason: "cancelled" };
        }
        await client.notify("_fixture/progress", { future: true });
        await update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "fixture reasoning" },
        });
        if (mode === "native" || mode === "cancel-permission") {
          const toolCall = {
            toolCallId: "native-write",
            title: "Write fixture",
            name: "Write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: join(root, "executed"), content: "marker" },
            _meta: { "codebuddy.ai/toolName": "Write" },
          };
          await update({ sessionUpdate: "tool_call", ...toolCall });
          const cancel = new AbortController();
          const decision = client.request(
            methods.client.session.requestPermission,
            {
              sessionId: params.sessionId,
              toolCall,
              options: [
                {
                  optionId: "fixture-permit",
                  name: permanentOnly ? "Allow always" : "Allow once",
                  kind: permanentOnly ? "allow_always" : "allow_once",
                },
                {
                  optionId: "fixture-deny",
                  name: "Reject",
                  kind: "reject_once",
                },
              ],
            },
            { cancellationSignal: cancel.signal },
          );
          if (mode === "cancel-permission") {
            await untilFile("approval-started");
            cancel.abort();
          }
          const outcome = await decision;
          await record({ method: "permission", outcome });
          const allowed =
            outcome.outcome.outcome === "selected" &&
            outcome.outcome.optionId === "fixture-permit";
          if (allowed) await writeFile(join(root, "executed"), "marker");
          await update({
            sessionUpdate: "tool_call_update",
            toolCallId: "native-write",
            status: allowed ? "completed" : "failed",
            rawOutput: allowed ? "written" : "denied",
          });
          if (!allowed && stopAfterReject) return { stopReason: "cancelled" };
        }
        let text = "hello";
        if (mode.startsWith("mcp")) {
          const prompt = params.prompt
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
          const done =
            /RESULT_two|FIXTURE_DENIED|FIXTURE_MCP_UNAVAILABLE|the user rejected tool/.test(
              prompt,
            );
          if (!done) {
            const server = JSON.parse(args[args.indexOf("--mcp-config") + 1])
              .mcpServers.kmh;
            assert.equal(server.transparent_proxy, true);
            const mcp = new Client({
              name: "fixture-workbuddy",
              version: "1.0.0",
            });
            try {
              await mcp.connect(
                new StreamableHTTPClientTransport(new URL(server.url), {
                  requestInit: { headers: server.headers },
                }),
              );
              const { tools } = await mcp.listTools();
              assert.deepEqual(
                tools.map((t) => t.name),
                server.builtin_tools,
              );
              assert.ok(tools.every((t) => t.name.startsWith("kmh-")));
              for (const q of [
                "one",
                mode === "mcp-duplicate" ? "one" : "two",
              ]) {
                const name = mode === "mcp-invalid" ? "lookup" : tools[0].name;
                if (mode === "mcp-invalid") {
                  await assert.rejects(
                    mcp.callTool({ name, arguments: { q } }),
                    /Undeclared KMH tool/,
                  );
                  continue;
                }
                const receipt = await mcp.callTool({ name, arguments: { q } });
                assert.match(JSON.stringify(receipt), /KMH_TOOL_TRANSFERRED/);
                await update({
                  sessionUpdate: "tool_call",
                  toolCallId: `observed-${randomUUID()}`,
                  title: name,
                  name,
                  rawInput: { q },
                });
              }
            } finally {
              await mcp.close();
            }
            text = "queued";
          } else text = "验证完成";
        }
        if (mode === "slow")
          await new Promise((resolve) => setTimeout(resolve, 150));
        if (mode === "large") text = "字".repeat(6 * 1024 * 1024);
        if (mode === "native-error") {
          await update({
            sessionUpdate: "tool_call",
            toolCallId: "unavailable",
            title: "Offline service",
            name: "native_service",
            status: "pending",
          });
          await update({
            sessionUpdate: "tool_call_update",
            toolCallId: "unavailable",
            status: "failed",
            rawOutput: "ECONNREFUSED",
          });
          await update({
            sessionUpdate: "session_info_update",
            title: "background task completed",
            _meta: { futureProgress: "done" },
          });
        }
        if (mode === "observed-kmh")
          await update({
            sessionUpdate: "tool_call",
            toolCallId: "observed-only",
            title: "kmh-lookup",
            name: "kmh-lookup",
            rawInput: { q: "observation" },
          });
        if (mode === "literal")
          text =
            '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="lookup"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
        await update({
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-answer",
          content: { type: "text", text },
        });
        return {
          stopReason,
          usage: {
            inputTokens: 20,
            outputTokens: 3,
            totalTokens: 23,
            cachedReadTokens: 5,
            thoughtTokens: 1,
          },
        };
      },
    );
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
  await connection.closed;
}
