/** 官方事件协议覆盖矩阵：输入校验、增量、工具批次、结束和互不重叠的用量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { CliEventSchema } from "../lib/native-schema.js";
const frame = (event) => ({
  type: "stream_event",
  _messageId: "gen-1",
  _requestId: "request-1",
  event,
});
const start = (index, content_block) =>
  frame({ type: "content_block_start", index, content_block });
const delta = (index, delta) =>
  frame({ type: "content_block_delta", index, delta });
const stop = (index) => frame({ type: "content_block_stop", index });
const result = (extra) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  ...extra,
});
async function processor(names = []) {
  const { NativeOutput } = await import("../lib/native-output.js");
  return new NativeOutput(new Set(names));
}
const texts = (chunks) =>
  chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => c.text)
    .join("");
test("T01 Zod 拒绝未知事件、未知分片和缺失正文，扩展元数据保留", () => {
  for (const v of [
    { type: "unknown" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text" }] },
    },
    frame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "future_delta" },
    }),
  ])
    assert.equal(CliEventSchema.safeParse(v).success, false);
  assert.equal(
    CliEventSchema.parse({ type: "system", subtype: "init", extra: "retained" })
      .extra,
    "retained",
  );
});
test("T02/T03 正文和思考在终止之前增量交付，完整快照去重", async () => {
  const p = await processor();
  const chunks = [];
  chunks.push(
    ...p.push(start(0, { type: "thinking", thinking: "", signature: "" })),
    ...p.push(delta(0, { type: "thinking_delta", thinking: "thinking" })),
  );
  assert.equal(
    chunks.find((c) => c.type === "reasoning-delta").text,
    "thinking",
  );
  p.push(delta(0, { type: "signature_delta", signature: "sig" }));
  chunks.push(
    ...p.push(stop(0)),
    ...p.push(start(1, { type: "text", text: "" })),
    ...p.push(delta(1, { type: "text_delta", text: "hello" })),
  );
  assert.equal(texts(chunks), "hello");
  chunks.push(
    ...p.push(stop(1)),
    ...p.push({
      type: "assistant",
      _messageId: "gen-1",
      message: {
        id: "gen-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking", signature: "sig" },
          { type: "text", text: "hello" },
        ],
      },
    }),
  );
  p.push(result());
  chunks.push(...p.finish(0));
  assert.equal(texts(chunks), "hello");
  assert.equal(p.content.length, 2);
  assert.equal(chunks.at(-1).reason.kind, "stop");
});
test("T04/T06 多个结构化工具保持原始 ID，分片和完整事件去重", async () => {
  const p = await processor(["lookup"]);
  const chunks = [];
  chunks.push(
    ...p.push(
      start(0, {
        type: "tool_use",
        id: "call-1",
        name: "mcp__kmh__lookup",
        input: {},
      }),
    ),
    ...p.push(delta(0, { type: "input_json_delta", partial_json: '{"q":' })),
    ...p.push(delta(0, { type: "input_json_delta", partial_json: '"one"}' })),
    ...p.push(stop(0)),
  );
  chunks.push(
    ...p.push({
      type: "assistant",
      _messageId: "gen-1",
      message: {
        id: "gen-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "mcp__kmh__lookup",
            input: { q: "one" },
          },
          {
            type: "tool_use",
            id: "call-2",
            name: "mcp__kmh__lookup",
            input: { q: "two" },
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    p.calls.map((c) => [c.id, c.name, JSON.parse(c.arguments)]),
    [
      ["call-1", "lookup", { q: "one" }],
      ["call-2", "lookup", { q: "two" }],
    ],
  );
  assert.equal(
    chunks
      .filter((c) => c.type === "tool-call-delta")
      .map((c) => c.argumentsDelta)
      .join(""),
    '{"q":"one"}',
  );
  p.push(result({ subtype: "error_max_turns", is_error: true }));
  chunks.push(...p.finish(0));
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});
test("T04 原生 function_call 与结果显式处理，未知调用及坏参数拒绝", async () => {
  const p = await processor(["lookup"]);
  p.push({
    type: "function_call",
    callId: "native-1",
    name: "lookup",
    arguments: '{"q":"a"}',
  });
  assert.equal(p.calls[0].id, "native-1");
  assert.throws(
    () =>
      p.push({
        type: "function_call",
        callId: "native-2",
        name: "unknown",
        arguments: "{}",
      }),
    /WORKBUDDY/,
  );
  const q = await processor(["lookup"]);
  assert.throws(
    () =>
      q.push({
        type: "function_call",
        callId: "bad",
        name: "lookup",
        arguments: "{",
      }),
    /WORKBUDDY/,
  );
  assert.throws(
    () =>
      q.push({ type: "function_call_result", callId: "orphan", output: "x" }),
    /WORKBUDDY/,
  );
});
test("T07 成功、截断、取消、拒绝、失败、非零退出、缺终止分别处理", async () => {
  for (const [extra, expected] of [
    [{}, "stop"],
    [{ terminal_reason: "max_tokens" }, "max-tokens"],
    [{ terminal_reason: "aborted_streaming" }, "aborted"],
    [
      { is_error: true, subtype: "error_during_execution", errors: ["failed"] },
      "error",
    ],
    [{ permission_denials: [{ tool_name: "lookup" }] }, "error"],
  ]) {
    const p = await processor();
    p.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
    });
    p.push(result(extra));
    assert.equal(p.finish(0).at(-1).reason.kind, expected);
  }
  const p = await processor();
  p.push(result());
  assert.throws(() => p.finish(2), /WORKBUDDY/);
  const q = await processor();
  assert.throws(() => q.finish(0), /WORKBUDDY/);
});
test("T08 用量缓存互不重叠，并保留总量、思考、积分；完整帧覆写分片快照", async () => {
  const p = await processor();
  p.push(
    frame({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
        total_tokens: 120,
        reasoning_tokens: 8,
        credit: 0.2,
      },
    }),
  );
  p.push(result({ usage: { input_tokens: 9999, output_tokens: 9999 } }));
  const u = p.finish(0).find((c) => c.type === "usage").usage;
  assert.deepEqual(u, {
    inputTokens: 50,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    totalTokens: 120,
    reasoningTokens: 8,
  });
  assert.equal(p.credit, 0.2);
});
test("T09 历史回放不会进入本轮消息，未知协议明确报错", async () => {
  const p = await processor();
  assert.deepEqual(
    p.push({
      type: "assistant",
      isReplay: true,
      message: { role: "assistant", content: [{ type: "text", text: "old" }] },
    }),
    [],
  );
  assert.throws(
    () => p.push({ type: "future-event", value: "x" }),
    /WORKBUDDY/,
  );
});

test("T06 相同参数的独立调用按次数保留，回调与原始 ID 一一对应", async () => {
  const p = await processor(["lookup"]);
  for (const id of ["original-1", "original-2"])
    p.push({
      type: "function_call",
      callId: id,
      name: "lookup",
      arguments: '{"q":"same"}',
    });
  assert.deepEqual(p.transfer("lookup", { q: "same" }, "rpc-1"), []);
  assert.deepEqual(p.transfer("lookup", { q: "same" }, "rpc-2"), []);
  assert.equal(
    p.transfer("lookup", { q: "same" }, "rpc-3").at(-1).block.id,
    "rpc-3",
  );
  assert.equal(p.calls.length, 3);
});
test("T02 官方仅思考后转工具的 message_stop 关闭思考块", async () => {
  const p = await processor(["lookup"]);
  p.push(start(0, { type: "thinking", thinking: "" }));
  p.push(delta(0, { type: "thinking_delta", thinking: "consider" }));
  p.push(start(2, { type: "tool_use", id: "t", name: "lookup", input: {} }));
  p.push(stop(2));
  const end = p.push(frame({ type: "message_stop" }));
  assert.equal(end.at(-1).block.text, "consider");
  p.push(result());
  assert.equal(p.finish(0).at(-1).reason.kind, "tool-calls");
});
test("T03 Markdown 代码正文持续流出，DSML 标记跨分片保持缓冲", async () => {
  const p = await processor(["lookup"]);
  p.push(start(0, { type: "text", text: "" }));
  assert.equal(
    texts(
      p.push(delta(0, { type: "text_delta", text: "正文 `code` 后继续\n" })),
    ),
    "正文 `code` 后继续",
  );
  assert.equal(
    texts(p.push(delta(0, { type: "text_delta", text: "<｜｜DS" }))),
    "",
  );
  const out = p.push(
    delta(0, {
      type: "text_delta",
      text: 'ML｜｜ calls><｜｜DSML｜｜ invoke name="lookup"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
    }),
  );
  assert.equal(texts(out), "");
  p.push(stop(0));
  assert.equal(p.calls.length, 1);
});
test("T07 中途取消和 token 截断保留对应结束语义；未知截断仍报错", async () => {
  for (const [terminal, kind] of [
    ["aborted_streaming", "aborted"],
    ["max_tokens", "max-tokens"],
  ]) {
    const p = await processor();
    p.push(start(0, { type: "text", text: "" }));
    p.push(delta(0, { type: "text_delta", text: "partial" }));
    p.push(result({ terminal_reason: terminal }));
    assert.equal(p.finish(0).at(-1).reason.kind, kind);
  }
  const p = await processor();
  p.push(start(0, { type: "text", text: "" }));
  p.push(result());
  assert.throws(() => p.finish(0), /truncated/);
});
test("T02/T04 rawContent、签名、脱敏思考和原生结果保留到协议元数据", async () => {
  const p = await processor(["lookup"]);
  p.push({
    type: "reasoning",
    content: [],
    rawContent: [{ type: "reasoning_text", text: "raw thought" }],
    providerData: { signature: "signed" },
  });
  assert.equal(p.content[0].text, "raw thought");
  assert.equal(p.metadata["signature:0"], "signed");
  p.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "opaque" }],
    },
  });
  assert.equal(p.metadata.redactedThinking, true);
  p.push({
    type: "function_call",
    callId: "call",
    name: "lookup",
    arguments: "{}",
  });
  p.push({ type: "function_call_result", callId: "call", output: "deferred" });
  assert.equal(p.metadata["nativeToolResult:call"], "deferred");
});
test("T08 续聊累计用量独立于本轮、缓存边界和损坏统计诊断", async () => {
  const { NativeOutput } = await import("../lib/native-output.js");
  const resumed = new NativeOutput(new Set(), true);
  resumed.push(result({ usage: { input_tokens: 10000, output_tokens: 1000 } }));
  assert.equal(resumed.finish(0).filter((c) => c.type === "usage").length, 0);
  for (const usage of [
    { input_tokens: 1, cache_read_input_tokens: 2 },
    { input_tokens: 2, output_tokens: 1, total_tokens: 5 },
  ]) {
    const p = await processor();
    p.push(result({ usage }));
    assert.throws(() => p.finish(0), /PROTOCOL/);
  }
});
test("T06 参数对象键顺序变化保持同一次调用", async () => {
  const p = await processor(["lookup"]);
  p.push({
    type: "function_call",
    callId: "same",
    name: "lookup",
    arguments: '{"a":1,"b":2}',
  });
  assert.deepEqual(
    p.push({
      type: "function_call",
      callId: "same",
      name: "lookup",
      arguments: '{"b":2,"a":1}',
    }),
    [],
  );
  assert.deepEqual(p.transfer("lookup", { b: 2, a: 1 }, "rpc"), []);
  assert.equal(p.calls.length, 1);
});
