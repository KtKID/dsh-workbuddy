/** 官方 ACP Agent 连接真实 KMH Session、工具执行器、审批与持久化服务。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import Approval from "@deepseek-ai/dsh-user-approval";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { sessionRuntime } from "./support/session-runtime.mjs";
import { fixture } from "./support/acp-fixture.mjs";

async function runtimeFixture(t, mode, settings = {}) {
  const { root, config, beforeRemove } = await fixture(t, {
    mode,
    ...settings,
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v3/config"))
      return Response.json({
        code: 0,
        data: {
          models: [{ id: "fixture", name: "Fixture", supportsToolCall: true }],
        },
      });
    if (String(url).endsWith("/get-user-resource-summary"))
      return Response.json({
        code: 0,
        data: {
          TotalCredits: "0",
          SubscriptionPackageName: "Fixture",
          CreditGroups: [],
        },
      });
    throw new Error("EXTERNAL_NETWORK_DISABLED");
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const runtime = await sessionRuntime(
    join(root, "sessions"),
    { ...config, traceDir: join(root, "workbuddy-transport") },
    "none",
    root,
  );
  beforeRemove(() => runtime.close());
  return { ...runtime, root };
}

test("WB ACP 通知用量进入真实 KMH Session 并沿用助手消息持久化", async (t) => {
  const runtime = await runtimeFixture(t, "usage");
  const agent = await runtime.send("wb-usage", "fixture", "fixture");
  const expected = {
    inputTokens: 14241,
    outputTokens: 116,
    totalTokens: 46485,
    cacheReadTokens: 32128,
    cacheWriteTokens: 0,
    reasoningTokens: 71,
  };
  const events = agent.session.snapshotEvents();
  assert.deepEqual(
    events.findLast((e) => e.type === "assistant/message").data.usage,
    expected,
  );
  const persisted = await runtime.ctx.sessionPersistence.open(
    agent.session.id,
    "read",
  );
  try {
    assert.deepEqual(
      (await persisted.read()).events.findLast(
        (e) => e.type === "assistant/message",
      ).data.usage,
      expected,
    );
  } finally {
    await persisted.close();
  }
});

test("ACP 拒绝审批后 WB 取消整轮，KMH 保存正式取消状态", async (t) => {
  const runtime = await runtimeFixture(t, "native", { stopAfterReject: true });
  await runtime.ctx.plugin(Approval, { policy: "ask" });
  runtime.ctx.on("approval/request", async () => "rejected");
  const agent = await runtime.send("native-denied-turn", "fixture", "fixture");
  const end = agent.session
    .snapshotEvents()
    .findLast((event) => event.type === "turn/end");
  assert.equal(
    end.data.reason.kind,
    "aborted",
    JSON.stringify(end.data.reason),
  );
  assert.deepEqual(end.data.reason.reason, {
    kind: "hook",
    reason: "WorkBuddy 在审批拒绝后取消本轮",
  });
  await assert.rejects(access(join(runtime.root, "executed")), {
    code: "ENOENT",
  });
});

test("ACP 从当前宿主会话透传有效权限组合", async (t) => {
  const runtime = await runtimeFixture(t, "text");
  await runtime.ctx.plugin(Approval, { policy: "ask" });
  const sandboxModes = new Map([
    ["full-access", "danger-full-access"],
    ["full-access-ask", "danger-full-access"],
    ["workspace-never", "workspace-write"],
  ]);
  runtime.ctx.provide("sandboxPolicy", {
    resolve: ({ session }) => ({ mode: sandboxModes.get(session.id) }),
  });
  runtime.ctx.on("agent/created", ({ agent: { session } }) => {
    if (session.id !== "full-access-ask")
      session.append("approval/policy", { policy: "never" });
  });
  for (const id of sandboxModes.keys()) {
    const agent = await runtime.send(id, id, "fixture");
    const end = agent.session
      .snapshotEvents()
      .findLast((event) => event.type === "turn/end");
    assert.equal(
      end.data.reason.kind,
      "completed",
      JSON.stringify(end.data.reason),
    );
  }
  const rows = (await readFile(join(runtime.root, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    rows
      .filter((row) => row.method === "prompt")
      .map((row) => row.permissionMode),
    ["bypassPermissions", "default", "default"],
  );
});

for (const mode of ["allow", "deny", "never", "unavailable", "throwing"])
  test(`ACP 原生审批 → 真实 KMH Session：${mode}`, async (t) => {
    const runtime = await runtimeFixture(t, "native");
    let asks = 0;
    if (mode !== "unavailable") {
      await runtime.ctx.plugin(Approval, {
        policy: mode === "never" ? "never" : "ask",
      });
      runtime.ctx.on("approval/request", async (request) => {
        asks++;
        assert.equal(request.toolName, "workbuddy:Write");
        assert.match(request.reason, /file_path/);
        if (mode === "throwing")
          throw new Error("FIXTURE_APPROVAL_UNAVAILABLE");
        return mode === "allow" ? "allowed-once" : "rejected";
      });
    }
    const agent = await runtime.send(`native-${mode}`, "fixture", "fixture");
    const events = agent.session.snapshotEvents();
    assert.equal(asks, ["never", "unavailable"].includes(mode) ? 0 : 1);
    assert.equal(events.filter((e) => e.type === "tool/call").length, 0);
    assert.equal(
      events.findLast((e) => e.type === "turn/end").data.reason.kind,
      "completed",
      JSON.stringify(events),
    );
    if (mode === "allow")
      assert.equal(
        await readFile(join(runtime.root, "executed"), "utf8"),
        "marker",
      );
    else
      await assert.rejects(access(join(runtime.root, "executed")), {
        code: "ENOENT",
      });
    const outcomes = events
      .filter((e) => e.type === "approval/decided")
      .map((e) => e.data.outcome);
    assert.deepEqual(
      outcomes,
      mode === "unavailable"
        ? []
        : [
            mode === "allow"
              ? "allowed-once"
              : mode === "throwing"
                ? "unavailable"
                : "rejected",
          ],
    );
  });

for (const mode of [
  "allow",
  "guard-deny",
  "approval-allow",
  "approval-deny",
  "mcp-offline",
])
  test(`ACP + MCP → KMH 工具 → 下一步续跑：${mode}`, async (t) => {
    const runtime = await runtimeFixture(t, "mcp-session");
    const denied = mode.endsWith("deny");
    const offline = mode === "mcp-offline";
    const executed = [];
    runtime.ctx.tools.register(
      defineTool({
        name: "fixture_lookup",
        description: "Return fixture data",
        parameters: { q: { type: "string", required: true } },
        output: {
          schema: { type: "string" },
          render: (_, value) => [{ type: "text", text: value }],
        },
        async execute(args) {
          if (offline) throw new Error("FIXTURE_MCP_UNAVAILABLE: ECONNREFUSED");
          executed.push(args.q);
          return `RESULT_${args.q}`;
        },
      }),
    );
    const approvalRequests = [];
    if (mode.startsWith("approval-")) {
      await runtime.ctx.plugin(Approval, { policy: "ask" });
      runtime.ctx.on("tools/pre-execute", async () => ({
        kind: "ask",
        reason: "FIXTURE_APPROVAL",
      }));
      runtime.ctx.on("approval/request", async (request) => {
        approvalRequests.push({
          name: request.toolName,
          callId: request.callId,
        });
        return denied ? "rejected" : "allowed-once";
      });
    } else if (denied) runtime.ctx.tools.guard(() => "FIXTURE_DENIED");
    const agent = await runtime.send(
      `host-${mode}`,
      "执行两次 fixture_lookup",
      "fixture",
    );
    const events = agent.session.snapshotEvents();
    const calls = events.filter((e) => e.type === "tool/call");
    const results = events.filter((e) => e.type === "tool/result");
    assert.equal(calls.length, 2, JSON.stringify(events));
    assert.ok(calls.every((e) => e.data.name === "fixture_lookup"));
    assert.equal(results.length, 2);
    assert.deepEqual(executed.sort(), denied || offline ? [] : ["one", "two"]);
    if (mode.startsWith("approval-")) {
      assert.equal(approvalRequests.length, 2);
      assert.ok(
        approvalRequests.every((r) => r.name === "fixture_lookup" && r.callId),
      );
    }
    if (offline) assert.ok(results.every((e) => e.data.message.isError));
    assert.equal(
      events.findLast((e) => e.type === "turn/end").data.reason.kind,
      "completed",
      JSON.stringify(events),
    );
    const answers = events.filter((e) => e.type === "assistant/message");
    assert.equal(answers.length, 2);
    assert.match(
      JSON.stringify(answers.at(-1).data.message.content),
      /验证完成/,
    );
    assert.equal(
      answers[0].data.message.source.replayState.response.transport,
      "acp-v1",
    );
    const requests = (
      await readFile(join(runtime.root, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      requests.filter((row) => row.method === "new").length,
      1,
      "KMH 工具切步应加载同一 WB 会话",
    );
    assert.equal(requests.filter((row) => row.method === "load").length, 1);
    const persisted = await runtime.ctx.sessionPersistence.open(
      agent.session.id,
      "read",
    );
    try {
      assert.equal((await persisted.read()).events.length, events.length);
    } finally {
      await persisted.close();
    }
  });
