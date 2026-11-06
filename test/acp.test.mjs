/** 使用官方 SDK 的双端真实管道验证 ACP 行为与 KMH 流映射。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeCompletion } from "../lib/native.js";
import {
  fixture,
  credentials,
  request,
  collect,
} from "./support/acp-fixture.mjs";

test("官方 ACP：正文、思考、用量、会话和扩展通知完成往返", async (t) => {
  const { config, root } = await fixture(t);
  const traces = [];
  const chunks = await collect(
    nativeCompletion(
      request,
      config,
      credentials,
      (trace) => traces.push(trace),
      undefined,
      root,
    ),
  );
  assert.equal(chunks.find((c) => c.type === "text-delta").text, "hello");
  assert.equal(
    chunks.find((c) => c.type === "reasoning-delta").text,
    "fixture reasoning",
  );
  assert.equal(chunks.find((c) => c.type === "usage").usage.inputTokens, 15);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(chunks.at(-1).replayState.response.transport, "acp-v1");
  assert.match(chunks.at(-1).replayState.response.nativeSessionId, /^fixture-/);
  assert.match(JSON.stringify(traces), /_fixture\/progress/);
  assert.doesNotMatch(JSON.stringify(traces), /fixture-secret|fixture-user/);
});

for (const mode of ["slow", "large", "native-error"])
  test(`官方 ACP：${mode} 保留等待与完整输出`, async (t) => {
    const { config, root } = await fixture(t, { mode });
    const chunks = await collect(
      nativeCompletion(request, config, credentials, () => {}, undefined, root),
    );
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    assert.equal(
      text,
      mode === "large" ? "字".repeat(6 * 1024 * 1024) : "hello",
    );
    assert.equal(chunks.at(-1).reason.kind, "stop");
    if (mode === "native-error")
      assert.equal(
        chunks.at(-1).replayState.response.protocolMetadata[
          "nativeTool:unavailable"
        ].status,
        "failed",
      );
  });

for (const [stopReason, expected] of [
  ["max_tokens", "max-tokens"],
  ["max_turn_requests", "error"],
  ["refusal", "stop"],
  ["cancelled", "aborted"],
])
  test(`官方 ACP：结束原因 ${stopReason}`, async (t) => {
    const { config, root } = await fixture(t, { stopReason });
    const traces = [];
    const chunks = await collect(
      nativeCompletion(
        request,
        config,
        credentials,
        (trace) => traces.push(trace),
        undefined,
        root,
      ),
    );
    assert.equal(chunks.at(-1).reason.kind, expected);
    if (stopReason === "cancelled")
      assert.equal(
        traces.some((trace) => trace.phase === "error"),
        false,
      );
  });

for (const mode of ["mcp", "mcp-duplicate", "mcp-invalid"])
  test(`官方 MCP SDK：${mode} 前缀、次数与声明校验`, async (t) => {
    const { config, root } = await fixture(t, { mode });
    const name = mode === "mcp" ? "kmh-lookup" : "lookup";
    const chunks = await collect(
      nativeCompletion(
        {
          ...request,
          tools: [
            {
              name,
              description: "fixture",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
              },
            },
          ],
        },
        config,
        credentials,
        () => {},
        undefined,
        root,
      ),
    );
    const calls = chunks
      .filter((c) => c.type === "block-end" && c.block.type === "tool-call")
      .map((c) => c.block);
    assert.equal(calls.length, mode === "mcp-invalid" ? 0 : 2);
    assert.ok(calls.every((c) => c.name === name));
    assert.equal(new Set(calls.map((c) => c.id)).size, calls.length);
    if (mode === "mcp-duplicate")
      assert.deepEqual(
        calls.map((c) => JSON.parse(c.arguments)),
        [{ q: "one" }, { q: "one" }],
      );
    assert.equal(
      chunks.at(-1).reason.kind,
      calls.length ? "tool-calls" : "stop",
    );
  });

for (const settings of [
  {},
  { loadSession: false },
  { loadFails: true },
  { lowerPermissions: true },
])
  test(`官方 ACP：续聊与历史恢复 ${JSON.stringify(settings)}`, async (t) => {
    const { config, root } = await fixture(t, settings);
    const first = await collect(
      nativeCompletion(
        request,
        config,
        credentials,
        () => {},
        undefined,
        root,
        undefined,
        undefined,
        settings.lowerPermissions ? "bypassPermissions" : "default",
      ),
    );
    const content = first
      .filter((c) => c.type === "block-end")
      .map((c) => c.block);
    const source = {
      kind: "model",
      provider: "workbuddy",
      model: "fixture",
      replayState: first.at(-1).replayState,
    };
    const messages = [
      ...request.messages,
      { role: "assistant", content, source },
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ];
    const second = await collect(
      nativeCompletion(
        { ...request, messages },
        config,
        credentials,
        () => {},
        undefined,
        root,
      ),
    );
    assert.equal(
      second
        .filter((c) => c.type === "text-delta")
        .map((c) => c.text)
        .join(""),
      "hello",
    );
    const rows = (await readFile(join(root, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const prompts = rows.filter((row) => row.method === "prompt");
    assert.equal(
      rows.filter((r) => r.method === "load").length,
      settings.loadSession === false || settings.lowerPermissions ? 0 : 1,
    );
    assert.deepEqual(
      prompts.map((row) => row.permissionMode),
      [settings.lowerPermissions ? "bypassPermissions" : "default", "default"],
    );
    const prompt = prompts.at(-1).params.prompt[0].text;
    if (
      settings.loadSession === false ||
      settings.loadFails ||
      settings.lowerPermissions
    )
      assert.match(prompt, /fixture task/);
    else assert.equal(prompt, "next question");
  });

test("官方 ACP：尾随运行上下文与原任务共同传入，旧绑定从 KMH 历史恢复", async (t) => {
  const { config, root } = await fixture(t);
  await collect(
    nativeCompletion(
      {
        ...request,
        messages: [
          { role: "user", content: [{ type: "text", text: "original task" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
            source: {
              kind: "model",
              provider: "workbuddy",
              model: "fixture",
              replayState: {
                response: {
                  nativeSessionId: "legacy",
                  historyDigest: "legacy",
                },
              },
            },
          },
          { role: "user", content: [{ type: "text", text: "active task" }] },
          {
            role: "user",
            content: [{ type: "text", text: "runtime skill context" }],
          },
        ],
      },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  const rows = (await readFile(join(root, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.filter((r) => r.method === "load").length, 0);
  assert.match(
    rows.at(-1).params.prompt[0].text,
    /CURRENT_USER_MESSAGE:\nactive task\n\nruntime skill context/,
  );
});

for (const mode of ["failure", "crash"])
  test(`官方 ACP：${mode} 明确失败并回收子进程`, async (t) => {
    const { config, root } = await fixture(t, { mode });
    await assert.rejects(
      collect(
        nativeCompletion(
          request,
          config,
          credentials,
          () => {},
          undefined,
          root,
        ),
      ),
      /WORKBUDDY_ACP_FAILED/,
    );
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });

async function untilFile(root, name) {
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await access(join(root, name));
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("FIXTURE_READY_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
test("官方 ACP：用户取消通知 WB 并回收子进程", async (t) => {
  const { config, root } = await fixture(t, { mode: "wait" });
  const controller = new AbortController();
  const result = collect(
    nativeCompletion(
      { ...request, signal: controller.signal },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  const rejected = assert.rejects(result, { name: "AbortError" });
  await untilFile(root, "waiting");
  controller.abort();
  await rejected;
  assert.equal(await readFile(join(root, "cancelled"), "utf8"), "cancelled");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("官方 ACP：首段增量及时到达，读取者提前结束回收进程", async (t) => {
  const { config, root } = await fixture(t, { mode: "stream-wait" });
  const iterator = nativeCompletion(
    request,
    config,
    credentials,
    () => {},
    undefined,
    root,
  );
  let next;
  do {
    next = await iterator.next();
  } while (next.value?.type !== "text-delta");
  assert.equal(next.value.text, "first chunk");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  process.kill(pid, 0);
  await iterator.return();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("官方 ACP：撤回审批取消宿主等待，迟到批准保持无效", async (t) => {
  const { config, root } = await fixture(t, { mode: "cancel-permission" });
  let aborted = false;
  const chunks = await collect(
    nativeCompletion(
      request,
      config,
      credentials,
      () => {},
      async (_, signal) => {
        const withdrawn = new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
        await writeFile(join(root, "approval-started"), "ready");
        await withdrawn;
        aborted = true;
        return true;
      },
      root,
    ),
  );
  assert.equal(aborted, true);
  await assert.rejects(access(join(root, "executed")), { code: "ENOENT" });
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("官方 ACP：撤回审批可结束未响应取消的宿主回调", async (t) => {
  const { config, root } = await fixture(t, { mode: "cancel-permission" });
  const chunks = await collect(
    nativeCompletion(
      request,
      config,
      credentials,
      () => {},
      async () => {
        await writeFile(join(root, "approval-started"), "ready");
        return new Promise(() => {});
      },
      root,
    ),
  );
  assert.equal(chunks.at(-1).reason.kind, "stop");
  await assert.rejects(access(join(root, "executed")), { code: "ENOENT" });
});

test("官方 ACP：允许一次保持为单次授权，永久授权选项保持未选中", async (t) => {
  const { config, root } = await fixture(t, {
    mode: "native",
    permanentOnly: true,
  });
  const chunks = await collect(
    nativeCompletion(
      request,
      config,
      credentials,
      () => {},
      async () => true,
      root,
    ),
  );
  assert.equal(chunks.at(-1).reason.kind, "stop");
  await assert.rejects(access(join(root, "executed")), { code: "ENOENT" });
});

for (const mode of ["literal", "observed-kmh"])
  test(`官方 ACP：${mode} 保持为内容或观察记录`, async (t) => {
    const { config, root } = await fixture(t, { mode });
    const chunks = await collect(
      nativeCompletion(
        {
          ...request,
          tools: [
            {
              name: "lookup",
              description: "fixture",
              parameters: { type: "object" },
            },
          ],
        },
        config,
        credentials,
        () => {},
        undefined,
        root,
      ),
    );
    assert.equal(
      chunks.filter(
        (c) => c.type === "block-end" && c.block.type === "tool-call",
      ).length,
      0,
    );
    assert.equal(chunks.at(-1).reason.kind, "stop");
    if (mode === "literal")
      assert.match(chunks.find((c) => c.type === "text-delta").text, /DSML/);
  });

test("官方 ACP：KMH 结果回填同一会话，私有传输元数据保持在宿主", async (t) => {
  const { config, root } = await fixture(t, { mode: "mcp-session" });
  const tools = [
    { name: "lookup", description: "fixture", parameters: { type: "object" } },
  ];
  const first = await collect(
    nativeCompletion(
      { ...request, tools },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  const content = first
    .filter((chunk) => chunk.type === "block-end")
    .map((chunk) => chunk.block);
  const calls = content.filter((block) => block.type === "tool-call");
  const replayState = structuredClone(first.at(-1).replayState);
  replayState.response.protocolMetadata.privateMarker =
    "PRIVATE_TRANSPORT_ONLY";
  const messages = [
    ...request.messages,
    {
      role: "assistant",
      content,
      source: {
        kind: "model",
        provider: "workbuddy",
        model: "fixture",
        replayState,
      },
    },
    ...calls.map((call, index) => ({
      role: "tool",
      toolCallId: call.id,
      isError: false,
      content: [
        { type: "text", text: index === 0 ? "RESULT_one" : "RESULT_two" },
      ],
    })),
    { role: "user", content: [{ type: "text", text: "runtime context" }] },
  ];
  const second = await collect(
    nativeCompletion(
      { ...request, tools, messages },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  assert.equal(
    second.at(-1).replayState.response.nativeSessionId,
    first.at(-1).replayState.response.nativeSessionId,
  );
  let rows = (await readFile(join(root, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const prompt = rows.findLast((row) => row.method === "prompt").params
    .prompt[0].text;
  assert.match(prompt, /RESULT_two/);
  assert.match(prompt, /runtime context/);
  assert.ok(calls.every((call) => prompt.includes(call.id)));
  assert.doesNotMatch(prompt, /PRIVATE_TRANSPORT_ONLY|fixture task/);
  const edited = structuredClone(messages);
  edited[0].content[0].text = "edited original task";
  await collect(
    nativeCompletion(
      { ...request, tools, messages: edited },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  rows = (await readFile(join(root, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.filter((row) => row.method === "load").length, 1);
  assert.equal(rows.filter((row) => row.method === "new").length, 2);
  assert.doesNotMatch(
    rows.findLast((row) => row.method === "prompt").params.prompt[0].text,
    /PRIVATE_TRANSPORT_ONLY/,
  );
});
