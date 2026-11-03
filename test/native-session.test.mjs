/** 隔离官方输出，验证真实 KMH 工具审批、结果回传和会话持久化。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { sessionRuntime } from "./support/session-runtime.mjs";

for (const denied of [false, true]) {
  test(`DSML 经真实 Session ${denied ? "拒绝执行并回传原因" : "执行多个工具并保存结果"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "wb-native-session-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cli = join(root, "Contents/Resources/app.asar.unpacked/cli/dist");
    const electronPath = join(root, "Contents/MacOS/Electron");
    await mkdir(cli, { recursive: true });
    await writeFile(
      join(cli, "../product.json"),
      JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.8.3" }),
    );
    await writeFile(
      join(cli, "../package.json"),
      JSON.stringify({ version: "2.161.0" }),
    );
    await mkdir(join(root, "Contents/MacOS"), { recursive: true });
    await writeFile(
      electronPath,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({accessToken:"fake-secret",userId:"fake-user",expiresAt:Date.now()+60000}));',
      { mode: 0o700 },
    );
    const protocol =
      "<｜｜DSML｜｜ calls>\n" +
      ["one", "two"]
        .map(
          (q) =>
            `<｜｜DSML｜｜ invoke name="fixture_lookup"><｜｜DSML｜｜ parameter name="q" string="true">${q}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`,
        )
        .join("\n") +
      "\n</｜｜DSML｜｜ calls>";
    await writeFile(
      join(cli, "codebuddy-lite-wb.mjs"),
      `let input=''; for await (const chunk of process.stdin) input += chunk; const done = input.includes('${denied ? "FIXTURE_DENIED" : "RESULT_two"}');const text = done ? '验证完成' : ${JSON.stringify(protocol)};const id=done?'answer-2':'answer-1';const emit=event=>process.stdout.write(JSON.stringify({type:'stream_event',_messageId:id,_requestId:'fixture-request',event})+'\\n');
      emit({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});emit({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'fixture reasoning'}});emit({type:'content_block_stop',index:0});
      emit({type:'content_block_start',index:1,content_block:{type:'text',text:''}});emit({type:'content_block_delta',index:1,delta:{type:'text_delta',text}});emit({type:'content_block_stop',index:1});emit({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:20,output_tokens:3,cache_read_input_tokens:5}});emit({type:'message_stop'});
      process.stdout.write(JSON.stringify({type:'assistant',_messageId:id,message:{id,role:'assistant',content:[{type:'text',text}]}})+'\\n');process.stdout.write(JSON.stringify({type:'result',is_error:false})+'\\n');`,
    );
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v3/config"))
        return Response.json({
          code: 0,
          data: {
            models: [
              { id: "fixture-model", name: "Fixture", supportsToolCall: true },
            ],
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
    const runtime = await sessionRuntime(join(root, "sessions"), {
      electronPath,
      timeoutMs: 3000,
    });
    t.after(() => runtime.close());
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
          executed.push(args.q);
          return `RESULT_${args.q}`;
        },
      }),
    );
    if (denied) runtime.ctx.tools.guard(() => "FIXTURE_DENIED");
    const agent = await runtime.send(
      `native-tools-${denied}`,
      "验证两次工具调用",
      "fixture-model",
    );
    const events = agent.session.snapshotEvents();
    assert.deepEqual(
      executed.sort(),
      denied ? [] : ["one", "two"],
      JSON.stringify(events),
    );
    const answers = events.filter((e) => e.type === "assistant/message");
    assert.equal(answers.length, 2, JSON.stringify(events));
    assert.equal(
      answers[0].data.message.content.filter((b) => b.type === "tool-call")
        .length,
      2,
    );
    assert.equal(
      answers[1].data.message.content.find((b) => b.type === "text").text,
      "验证完成",
    );
    assert.equal(answers[0].data.message.content[0].type, "reasoning");
    assert.equal(answers[0].data.usage.inputTokens, 15);
    assert.deepEqual(
      answers[0].data.message.source.replayState.response.providerRequestIds,
      ["fixture-request"],
    );
    const handle = await runtime.ctx.sessionPersistence.open(
      agent.session.id,
      "read",
    );
    try {
      const stored = await handle.read();
      assert.equal(stored.events.length, events.length);
      assert.match(
        JSON.stringify(stored.events),
        denied ? /FIXTURE_DENIED/ : /RESULT_two/,
      );
    } finally {
      await handle.close();
    }
  });
}
