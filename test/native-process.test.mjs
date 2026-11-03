/** 跨进程流式测试通过文件门闩控制结束时机，验证回收、分包和多工具转交。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCompletion } from "../lib/native.js";
import { NativeDecoder } from "../lib/native-decoder.js";
import { ConfigSchema } from "../lib/schema.js";
const creds = {
  accessToken: "fixture-secret",
  userId: "fixture-user",
  expiresAt: Date.now() + 600000,
};
const request = {
  provider: "workbuddy",
  model: "fixture",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
const frame = (event) => ({
  type: "stream_event",
  _messageId: "gen",
  _requestId: "provider-request",
  event,
});
const fixtures = [
  frame({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }),
  frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "分析" },
  }),
  frame({ type: "content_block_stop", index: 0 }),
  frame({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  }),
  frame({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "开始查询。" },
  }),
  frame({ type: "content_block_stop", index: 1 }),
];
async function setup(t, source) {
  const root = await mkdtemp(join(tmpdir(), "wb-stream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "Contents/Resources/app.asar.unpacked/cli/dist");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "codebuddy-lite-wb.mjs"), source(root));
  return {
    root,
    config: ConfigSchema.parse({
      electronPath: join(root, "Contents/MacOS/Electron"),
      timeoutMs: 10000,
    }),
  };
}
const collect = async (it) => {
  const a = [];
  for await (const c of it) a.push(c);
  return a;
};
test("T03 UTF-8 每字节分包、空行和尾行正确；截断 JSON 拒绝", () => {
  const events = [];
  const d = new NativeDecoder((e) => events.push(e));
  const bytes = Buffer.from(
    "\n" +
      JSON.stringify(fixtures[1]) +
      "\n" +
      JSON.stringify({ type: "result", is_error: false }),
  );
  for (const b of bytes) d.push(Buffer.from([b]));
  d.end();
  assert.equal(events[0].event.delta.thinking, "分析");
  assert.equal(events.length, 2);
  const broken = new NativeDecoder(() => {});
  broken.push(Buffer.from('{"type":'));
  assert.throws(() => broken.end(), /INVALID_OUTPUT/);
});
test("T03 首段文字在 CLI 退出前已到达；取消后子进程停止", async (t) => {
  const { root, config } = await setup(
    t,
    (root) =>
      `import {watch} from 'node:fs';import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(join(root, "pid"))},String(process.pid));const gate=new Promise(resolve=>{const w=watch(${JSON.stringify(root)},(_,name)=>{if(name==='release'){w.close();resolve();}})});const args=process.argv;if(args[args.indexOf('--output-format')+1]!=='stream-json'||!args.includes('--include-partial-messages'))throw Error('stream flags');for(const e of ${JSON.stringify(fixtures)})process.stdout.write(JSON.stringify(e)+'\\n');await gate;process.stdout.write(JSON.stringify({type:'result',is_error:false})+'\\n');`,
  );
  const iterator = nativeCompletion(request, config, creds, () => {})[
    Symbol.asyncIterator
  ]();
  let text = "";
  while (!text) {
    const n = await iterator.next();
    assert.equal(n.done, false);
    if (n.value.type === "text-delta") text += n.value.text;
  }
  assert.equal(text, "开始查询。");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0));
  await writeFile(join(root, "release"), "go");
  const rest = await collect({ [Symbol.asyncIterator]: () => iterator });
  assert.equal(rest.at(-1).reason.kind, "stop");
  assert.throws(() => process.kill(pid, 0));
});
test("T05/T06 MCP 同轮说明、思考、多个请求与关联完整保存", async (t) => {
  const { config } = await setup(
    t,
    () =>
      `const args=process.argv;const c=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.kmh;for(const e of ${JSON.stringify(fixtures)})process.stdout.write(JSON.stringify(e)+'\\n');process.stdout.write(JSON.stringify({type:'assistant',uuid:'response-id',_messageId:'gen',message:{id:'gen',role:'assistant',content:['one','two'].map((q,i)=>({type:'tool_use',id:'call-'+(i+1),name:'mcp__kmh__lookup',input:{q}})),usage:{input_tokens:20,output_tokens:2,cache_read_input_tokens:5}}})+'\\n');await Promise.all(['one','two'].map((q,i)=>fetch(c.url,{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name:'lookup',arguments:{q}}})}).then(r=>r.json()).then(r=>{if(!r.result.isError)throw Error('host deferred required')})));process.stdout.write(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true})+'\\n');`,
  );
  const chunks = await collect(
    nativeCompletion(
      {
        ...request,
        tools: [
          {
            name: "lookup",
            description: "test",
            parameters: { type: "object" },
          },
        ],
      },
      config,
      creds,
      () => {},
    ),
  );
  const blocks = chunks
    .filter((c) => c.type === "block-end")
    .map((c) => c.block);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["reasoning", "text", "tool-call", "tool-call"],
  );
  assert.equal(blocks[1].text, "开始查询。");
  assert.deepEqual(
    blocks.slice(2).map((b) => JSON.parse(b.arguments).q),
    ["one", "two"],
  );
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
  assert.deepEqual(
    blocks.slice(2).map((b) => b.id),
    ["call-1", "call-2"],
  );
  assert.equal(chunks.at(-1).replayState.response.responseId, "response-id");
  assert.equal(chunks.find((c) => c.type === "usage").usage.inputTokens, 15);
  assert.deepEqual(chunks.at(-1).replayState.response.providerRequestIds, [
    "provider-request",
  ]);
});
test("T07 流式中途取消及读取者提前退出都回收进程", async (t) => {
  for (const abort of [true, false]) {
    const { root, config } = await setup(
      t,
      (root) =>
        `import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(join(root, "pid"))},String(process.pid));process.stdout.write(${JSON.stringify(fixtures.map((e) => JSON.stringify(e)).join("\n") + "\n")});setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const iterator = nativeCompletion(
      { ...request, signal: controller.signal },
      config,
      creds,
      () => {},
    )[Symbol.asyncIterator]();
    await iterator.next();
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    if (abort) {
      controller.abort();
      await assert.rejects(() => iterator.next(), /abort/i);
    } else await iterator.return();
    assert.throws(() => process.kill(pid, 0));
  }
});
test("T07 输出上限触发诊断；原始半包保留到结束校验", () => {
  const d = new NativeDecoder(() => {});
  assert.throws(() => d.push(Buffer.alloc(16_000_001, 32)), /OUTPUT_LIMIT/);
  const x = new NativeDecoder(() => {});
  x.push(Buffer.from('{"type":'));
  assert.throws(() => x.end(), /INVALID_OUTPUT/);
});
