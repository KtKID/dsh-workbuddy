/** 真实会话创建、模型事件、持久化与只读恢复；网络和登录采用隔离夹具。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRuntime } from "./support/session-runtime.mjs";
import { transportTracePath } from "../lib/transport-log.js";

test("正式 Session 保存用户、助手、用量和请求响应关联并可恢复", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wb-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "Contents/Resources/app.asar.unpacked/cli");
  const electronPath = join(root, "Contents/MacOS/Electron");
  await mkdir(cli, { recursive: true });
  await mkdir(join(root, "Contents/MacOS"), { recursive: true });
  await writeFile(
    join(cli, "product.json"),
    JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.8.3" }),
  );
  await writeFile(
    join(cli, "package.json"),
    JSON.stringify({ version: "2.161.0" }),
  );
  await writeFile(
    electronPath,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({accessToken:"fixture-secret",userId:"fixture-user",expiresAt:Date.now()+60000}));\n',
    { mode: 0o700 },
  );
  const native = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/v3/config"))
      return Response.json({
        code: 0,
        data: {
          models: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek",
              supportsToolCall: true,
            },
          ],
        },
      });
    if (url.endsWith("/get-user-resource-summary"))
      return Response.json({
        code: 0,
        data: {
          TotalCredits: "5",
          SubscriptionPackageName: "fixture",
          CreditGroups: [],
        },
      });
    assert.equal(url, "https://www.workbuddy.cn/v2/chat/completions");
    modelCalls++;
    assert.equal(
      new Headers(init.headers).get("x-conversation-id"),
      "persisted-hi",
    );
    return new Response(
      await readFile(
        new URL("./fixtures/workbuddy-hi.sse", import.meta.url),
        "utf8",
      ).then((raw) =>
        raw.replaceAll("data: {", 'data: {"id":"fixture-response",'),
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => {
    globalThis.fetch = native;
  });
  const runtime = await sessionRuntime(join(root, "sessions"), {
    electronPath,
    transport: "direct",
  });
  t.after(() => runtime.close());
  const agent = await runtime.send("persisted-hi");
  const events = agent.session.snapshotEvents();
  assert.equal(modelCalls, 1);
  assert.ok(events.some((e) => e.type === "user/message"));
  const answer = events.find((e) => e.type === "assistant/message");
  assert.ok(answer, JSON.stringify(events));
  const transportRaw = await readFile(
    transportTracePath(join(root, "workbuddy-transport"), "persisted-hi"),
    "utf8",
  );
  const transport = transportRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(transport[0].data.conversationId, "persisted-hi");
  const complete = transport.find((e) => e.data.phase === "complete");
  assert.equal(complete.data.responseId, "fixture-response");
  assert.ok(
    transport.every((e) => e.data.requestId === transport[0].data.requestId),
  );
  assert.match(JSON.stringify(answer), /fixture-response/);
  assert.doesNotMatch(JSON.stringify(events), /fixture-secret|fixture-user/);
  const files = (
    await readdir(join(root, "sessions"), { recursive: true })
  ).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length);
  const raw = (
    await Promise.all(
      files.map((f) => readFile(join(root, "sessions", f), "utf8")),
    )
  ).join("");
  assert.doesNotMatch(raw, /fixture-secret|fixture-user/);
  assert.match(transportRaw, /workbuddy\/transport/);
  assert.doesNotMatch(transportRaw, /fixture-secret|fixture-user/);
  assert.match(raw, /Hello!/);
  const handle = await runtime.ctx.sessionPersistence.open(
    agent.session.id,
    "read",
  );
  try {
    const snapshot = await handle.read();
    assert.equal(snapshot.events.length, events.length);
  } finally {
    await handle.close();
  }
});
