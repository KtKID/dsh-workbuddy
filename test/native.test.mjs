/** 官方 CLI 传输的隔离进程夹具：文本回复、工具转交和取消均保持 KMH 控制。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCompletion } from "../lib/native.js";
import { ConfigSchema } from "../lib/schema.js";
async function setup(t, source) {
  const root = await mkdtemp(join(tmpdir(), "wb-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "Contents/Resources/app.asar.unpacked/cli/dist");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "codebuddy-lite-wb.mjs"), source);
  return ConfigSchema.parse({
    electronPath: join(root, "Contents/MacOS/Electron"),
    timeoutMs: 3000,
  });
}
const credentials = {
  accessToken: "fake-secret",
  userId: "fake-user",
  expiresAt: Date.now() + 60000,
};
const request = {
  provider: "workbuddy",
  model: "a",
  sessionId: "kmh-session",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
async function collect(it) {
  const list = [];
  for await (const c of it) list.push(c);
  return list;
}
test("官方 CLI 结果携带回复、用量和 native session 关联，凭据排除于事件", async (t) => {
  const config = await setup(
    t,
    `process.stdout.write(JSON.stringify([{type:'message',role:'assistant',id:'response-1',content:[{type:'output_text',text:'hello'}]},{type:'result',is_error:false,session_id:'native-session',usage:{input_tokens:5,output_tokens:2}}]));`,
  );
  const trace = [];
  const chunks = await collect(
    nativeCompletion(request, config, credentials, (e) => trace.push(e)),
  );
  assert.equal(chunks.find((c) => c.type === "text-delta").text, "hello");
  assert.equal(
    chunks.at(-1).replayState.response.nativeSessionId,
    "native-session",
  );
  assert.equal(chunks.at(-1).replayState.response.responseId, "response-1");
  assert.equal(chunks.find((c) => c.type === "usage").usage.inputTokens, 5);
  assert.doesNotMatch(JSON.stringify(trace), /fake-secret|fake-user/);
});
test("官方 CLI 的 MCP 工具请求交回 KMH，原生工具保持关闭", async (t) => {
  const config = await setup(
    t,
    `const args=process.argv; if(args[args.indexOf('--tools')+1]!=='')throw Error('native tools enabled');const c=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.kmh;await fetch(c.url,{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'lookup',arguments:{q:'hi'}}})});process.stdout.write(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true})+'\\n');`,
  );
  const chunks = await collect(
    nativeCompletion(
      {
        ...request,
        tools: [
          {
            name: "lookup",
            description: "lookup",
            parameters: { type: "object" },
          },
        ],
      },
      config,
      credentials,
      () => {},
    ),
  );
  assert.deepEqual(chunks.find((c) => c.type === "block-end").block, {
    type: "tool-call",
    id: chunks.find((c) => c.type === "block-end").block.id,
    name: "lookup",
    arguments: '{"q":"hi"}',
  });
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});
test("官方 CLI 超时终止子进程并返回明确错误", async (t) => {
  const config = await setup(t, "setInterval(()=>{},1000)");
  config.timeoutMs = 100;
  await assert.rejects(
    collect(nativeCompletion(request, config, credentials, () => {})),
    /WORKBUDDY_CLI_TIMEOUT/,
  );
});

test("续聊把历史与本轮用户输入分开传给官方 CLI", async (t) => {
  const config = await setup(
    t,
    `let input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv;if(args.includes('--append-system-prompt')||!input.endsWith('CURRENT_USER_MESSAGE:\\nprevious?')||!input.includes('first greeting'))process.exit(2);process.stdout.write(JSON.stringify([{type:'message',role:'assistant',content:[{type:'output_text',text:'first greeting'}]},{type:'result',is_error:false}]));`,
  );
  const chunks = await collect(
    nativeCompletion(
      {
        ...request,
        messages: [
          { role: "user", content: [{ type: "text", text: "first greeting" }] },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: [{ type: "text", text: "previous?" }] },
        ],
      },
      config,
      credentials,
      () => {},
    ),
  );
  assert.equal(
    chunks.find((c) => c.type === "text-delta").text,
    "first greeting",
  );
});

test("历史完全匹配时续接官方 session，编辑历史后创建新会话", async (t) => {
  const config = await setup(
    t,
    `let input='';for await(const chunk of process.stdin)input+=chunk;const resumed=process.argv.includes('--resume');if(resumed&&input!=='continue')process.exit(2);process.stdout.write(JSON.stringify([{type:'message',role:'assistant',content:[{type:'output_text',text:resumed?'resumed':'fresh'}]},{type:'result',is_error:false,session_id:'native-session'}]));`,
  );
  const first = await collect(
    nativeCompletion(request, config, credentials, () => {}),
  );
  const answer = {
    role: "assistant",
    content: [{ type: "text", text: "fresh" }],
    source: {
      kind: "model",
      provider: "workbuddy",
      model: "a",
      replayState: first.at(-1).replayState,
    },
  };
  const next = {
    ...request,
    messages: [
      ...request.messages,
      answer,
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  };
  const second = await collect(
    nativeCompletion(next, config, credentials, () => {}),
  );
  assert.equal(second.find((c) => c.type === "text-delta").text, "resumed");
  next.messages[0] = {
    role: "user",
    content: [{ type: "text", text: "edited" }],
  };
  const edited = await collect(
    nativeCompletion(next, config, credentials, () => {}),
  );
  assert.equal(edited.find((c) => c.type === "text-delta").text, "fresh");
});

const dsml = (name, params) =>
  `<｜｜DSML｜｜ invoke name="${name}">\n${Object.entries(params)
    .map(
      ([key, value]) =>
        `<｜｜DSML｜｜ parameter name="${key}" string="${typeof value === "string"}">${typeof value === "string" ? value : JSON.stringify(value)}</｜｜DSML｜｜ parameter>`,
    )
    .join("\n")}\n</｜｜DSML｜｜ invoke>`;
const calls = (...items) =>
  `<｜｜DSML｜｜ calls>\n${items.join("\n")}\n</｜｜DSML｜｜ calls>`;
async function outputFixture(t, records) {
  return setup(
    t,
    `process.stdout.write(${JSON.stringify(JSON.stringify(records))});`,
  );
}
const assistant = (text, extra = {}) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
  ...extra,
});
const success = { type: "result", is_error: false };
const lookupTool = {
  name: "lookup",
  description: "lookup",
  parameters: { type: "object" },
};

test("续聊的完整 CLI 历史只输出本轮回复和本轮用量", async (t) => {
  const config = await outputFixture(t, [
    assistant(calls(dsml("undeclared", {})), { id: "old-answer" }),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "new question" }],
    },
    assistant("本轮回答", {
      id: "new-answer",
      providerData: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          inputTokensDetails: [{ cached_tokens: 4 }],
        },
      },
    }),
    {
      ...success,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 400,
      },
    },
  ]);
  const chunks = await collect(
    nativeCompletion(request, config, credentials, () => {}),
  );
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join(""),
    "本轮回答",
  );
  assert.deepEqual(chunks.find((c) => c.type === "usage").usage, {
    inputTokens: 8,
    outputTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 15,
  });
  assert.equal(chunks.at(-1).replayState.response.responseId, "new-answer");
});

test("DSML 多调用转换成 KMH 工具块并保留字符串和 JSON 参数", async (t) => {
  const config = await outputFixture(t, [
    assistant(
      "准备查询。\n" +
        calls(
          dsml("lookup", {
            q: 'a < b && c > d\n"x"',
            limit: 2,
            tags: ["one"],
            enabled: false,
          }),
          dsml("mcp__kmh__lookup", { q: "second" }),
        ),
    ),
    success,
  ]);
  const chunks = await collect(
    nativeCompletion(
      { ...request, tools: [lookupTool] },
      config,
      credentials,
      () => {},
    ),
  );
  const blocks = chunks
    .filter((c) => c.type === "block-end")
    .map((c) => c.block);
  assert.deepEqual(blocks[0], { type: "text", text: "准备查询。" });
  assert.deepEqual(
    blocks.slice(1).map((b) => [b.name, JSON.parse(b.arguments)]),
    [
      [
        "lookup",
        { q: 'a < b && c > d\n"x"', limit: 2, tags: ["one"], enabled: false },
      ],
      ["lookup", { q: "second" }],
    ],
  );
  assert.equal(new Set(blocks.slice(1).map((b) => b.id)).size, 2);
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
  assert.doesNotMatch(JSON.stringify(blocks), /DSML/);
});

test("未声明、损坏和重复参数的 DSML 返回明确错误，完整引用保留为文本", async (t) => {
  for (const text of [
    calls(dsml("unknown", {})),
    calls(dsml("lookup", { q: "a" })).slice(0, -5),
    calls(
      '<｜｜DSML｜｜ invoke name="lookup"><｜｜DSML｜｜ parameter name="q" string="true">a</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="q" string="true">b</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>',
    ),
  ]) {
    const config = await outputFixture(t, [assistant(text), success]);
    await assert.rejects(
      collect(
        nativeCompletion(
          { ...request, tools: [lookupTool] },
          config,
          credentials,
          () => {},
        ),
      ),
      /WORKBUDDY_TOOL_PROTOCOL/,
    );
  }
  const quoted =
    "示例：\n```xml\n" + calls(dsml("lookup", { q: "example" })) + "\n```";
  const config = await outputFixture(t, [assistant(quoted), success]);
  const chunks = await collect(
    nativeCompletion(
      { ...request, tools: [lookupTool] },
      config,
      credentials,
      () => {},
    ),
  );
  assert.equal(chunks.find((c) => c.type === "text-delta").text, quoted);
  assert.equal(chunks.at(-1).reason.kind, "stop");
});
