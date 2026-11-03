/** 合成登录保护字段和模拟远端验证 MVP；真实账号调用由显式 smoke 执行。 */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Sessions from "@deepseek-ai/dsh-session";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { WorkBuddyAdapter } from "../lib/adapter.js";
import { decryptDesktopCredentials } from "../lib/credential-reader.js";
import { readDesktopCredentials } from "../lib/credentials.js";
import { ConfigSchema, ENDPOINT } from "../lib/schema.js";

// 每个夹具只有公开元数据；Electron 路径刻意留空，任何真实进程启动均会失败。
const fixtureRoots = [];
async function installation() {
  const root = await mkdtemp(join(tmpdir(), "kmh-workbuddy-test-"));
  fixtureRoots.push(root);
  const cli = join(
    root,
    "WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli",
  );
  await mkdir(cli, { recursive: true });
  const product = { productName: "WorkBuddy", genieVersion: "9.8.7" };
  const pkg = {
    version: "0.0.0",
    publishConfig: { customPackage: { version: "2.3.4" } },
  };
  const write = async () => {
    await writeFile(join(cli, "product.json"), JSON.stringify(product));
    await writeFile(join(cli, "package.json"), JSON.stringify(pkg));
  };
  await write();
  return {
    cli,
    product,
    pkg,
    write,
    config: ConfigSchema.parse({
      transport: "direct",
      electronPath: join(root, "WorkBuddy.app/Contents/MacOS/Electron"),
      authFile: join(root, "missing-auth.info"),
    }),
  };
}
const { config } = await installation();
mock.method(globalThis, "fetch", () => {
  throw new Error("测试禁止真实网络请求");
});
after(async () => {
  mock.restoreAll();
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true })));
});
const token = "synthetic-access-token";
const credentials = {
  accessToken: token,
  userId: "synthetic-user",
  expiresAt: Date.now() + 60_000,
};
const request = {
  provider: "workbuddy",
  model: config.model,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
const collect = async (stream) => Array.fromAsync(stream);
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const content =
  event({
    choices: [{ delta: { reasoning_content: "think" }, finish_reason: null }],
  }) +
  event({ choices: [{ delta: { content: "Hello!" }, finish_reason: null }] }) +
  event({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
  event({
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 4 },
      credit: 0.01,
    },
  }) +
  "data: [DONE]\n\n";
function response(text = content) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function adapter(fetch, extra = {}) {
  return new WorkBuddyAdapter(config, {
    credentials: async () => credentials,
    fetch,
    ...extra,
  });
}

// 独立按客户端格式构造 AES-GCM 夹具，避免用被测解码器生产预期。
function loginFixture() {
  const build = {
    version: 1,
    atRestSecretKey: Buffer.alloc(32, 9).toString("base64"),
  };
  const key = createHash("sha256")
    .update(build.atRestSecretKey, "utf8")
    .digest();
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const encode = (s) => {
    const bytes = Buffer.from(s);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const suite = Buffer.alloc(4);
  suite.writeUInt32BE(1);
  const aad = Buffer.concat([
    Buffer.from("WB-AAD\0"),
    Buffer.from([1]),
    encode("WBEV1"),
    encode("sym-v1"),
    suite,
    encode(keyId),
    Buffer.from([2, 0, 0]),
  ]);
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return {
    build,
    login: {
      account: { uid: credentials.userId },
      auth: {
        accessToken: {
          $wbEncrypted: 1,
          envelope: Buffer.from(JSON.stringify(envelope)).toString("base64"),
        },
        expiresAt: credentials.expiresAt,
      },
    },
  };
}

test("T1 解密受保护登录并保持原文件数据", () => {
  const { login, build } = loginFixture();
  const before = JSON.stringify(login);
  assert.deepEqual(decryptDesktopCredentials(login, build), credentials);
  assert.equal(JSON.stringify(login), before);
  assert.throws(
    () =>
      decryptDesktopCredentials(login, {
        ...build,
        atRestSecretKey: Buffer.alloc(32, 8).toString("base64"),
      }),
    /WORKBUDDY/,
  );
  const envelope = JSON.parse(
    Buffer.from(login.auth.accessToken.envelope, "base64").toString(),
  );
  envelope.authTag = Buffer.alloc(16).toString("base64");
  const tampered = structuredClone(login);
  tampered.auth.accessToken.envelope = Buffer.from(
    JSON.stringify(envelope),
  ).toString("base64");
  assert.throws(() => decryptDesktopCredentials(tampered, build), /WORKBUDDY/);
});

test("T2 过期或缺失的桌面登录给安全错误", async () => {
  const { login, build } = loginFixture();
  login.auth.expiresAt = 1;
  assert.throws(
    () => decryptDesktopCredentials(login, build),
    /WORKBUDDY_AUTH_EXPIRED/,
  );
  await assert.rejects(
    readDesktopCredentials({
      ...config,
    }),
    /WORKBUDDY_AUTH_UNAVAILABLE/,
  );
});

test("T3a 真实 Cordis 注册模型路由并回收", async () => {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(Sessions);
  try {
    const fiber = ctx.plugin(plugin, {});
    await fiber;
    assert.ok(ctx.llm.listProviders().some((p) => p.id === "workbuddy"));

    await fiber.dispose();
    assert.ok(ctx.llm.listProviders().every((p) => p.id !== "workbuddy"));
  } finally {
    await ctx.fiber.dispose();
  }
});

test("T3b 单次 HTTP 携带登录凭据和完整文本历史", async () => {
  let calls = 0;
  const stream = adapter(async (url, options) => {
    calls += 1;
    assert.equal(url, ENDPOINT);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("x-user-id"), credentials.userId);
    assert.equal(
      headers.get("user-agent"),
      "WorkBuddy/9.8.7 WorkBuddy/9.8.7 CLI/2.3.4",
    );
    assert.equal(headers.get("x-ide-type"), "WorkBuddy");
    assert.equal(headers.get("x-ide-name"), "WorkBuddy");
    assert.equal(headers.get("x-ide-version"), "9.8.7");
    assert.doesNotMatch(
      JSON.stringify([...headers]),
      /kongming|deepseek-harness/i,
    );
    assert.ok(headers.get("x-conversation-id"));
    assert.deepEqual(JSON.parse(options.body).messages, [
      { role: "system", content: "text-only MVP" },
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "hello" },
    ]);
    assert.equal(JSON.parse(options.body).stream, true);
    return response();
  });
  const chunks = await collect(
    stream.stream({
      ...request,
      system: "text-only MVP",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "previous question" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
        },
        ...request.messages,
      ],
    }),
  );
  assert.equal(calls, 1);
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join(""),
    "Hello!",
  );
});

test("T4 分段 SSE 保留文本、推理、缓存用量和 credit", async () => {
  const credits = [];
  const chunks = await collect(
    adapter(async () => response(), {
      onCredit: (value) => credits.push(value),
    }).stream(request),
  );
  assert.equal(chunks.find((c) => c.type === "reasoning-delta")?.text, "think");
  assert.deepEqual(chunks.find((c) => c.type === "usage")?.usage, {
    inputTokens: 8,
    outputTokens: 5,
    totalTokens: 17,
    cacheReadTokens: 4,
  });
  assert.deepEqual(credits, [0.01]);
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("T5 401、非法和截断 SSE 分别返回失败", async () => {
  await assert.rejects(
    collect(
      adapter(async () => new Response(token, { status: 401 })).stream(request),
    ),
    (error) =>
      error.code === "WORKBUDDY_HTTP_401" && !error.message.includes(token),
  );
  for (const text of [
    "data: {bad}\n\n",
    event({ choices: [{ delta: { content: "partial" } }] }),
  ]) {
    await assert.rejects(
      collect(adapter(async () => response(text)).stream(request)),
      /WORKBUDDY_PROTOCOL/,
    );
  }
});

test("T6a 调用前取消与超时传播到 fetch", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    collect(
      adapter(async () => {
        calls += 1;
        return response();
      }).stream({ ...request, signal: abort.signal }),
    ),
    /abort/i,
  );
  assert.equal(calls, 0);
  const slow = new WorkBuddyAdapter(
    { ...config, timeoutMs: 10 },
    {
      credentials: async () => credentials,
      fetch: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  await assert.rejects(collect(slow.stream(request)), /timeout/i);
});

test("T5b 渠道校验拒绝保留独立错误码并脱敏", async () => {
  await assert.rejects(
    collect(
      adapter(async () =>
        Response.json(
          { code: 11128, msg: `channel rejected ${token}` },
          { status: 400 },
        ),
      ).stream(request),
    ),
    (error) =>
      error.code === "WORKBUDDY_CHANNEL_REJECTED" &&
      error.message.includes("[redacted]") &&
      !error.message.includes(token),
  );
});

test("T6c 流中取消释放远端读取器", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const instance = adapter(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                event({ choices: [{ delta: { content: "partial" } }] }),
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(
    (async () => {
      for await (const chunk of instance.stream({
        ...request,
        signal: abort.signal,
      }))
        if (chunk.type === "text-delta") abort.abort();
    })(),
    /abort/i,
  );
  assert.equal(cancelled, true);
});

test("T6b 多媒体输入明确报范围错误", async () => {
  let calls = 0;
  const instance = adapter(async () => {
    calls += 1;
    return response();
  });
  await assert.rejects(
    collect(
      instance.stream({
        ...request,
        messages: [{ role: "user", content: [{ type: "image" }] }],
      }),
    ),
    /WORKBUDDY_MVP_TEXT_ONLY/,
  );
  assert.equal(calls, 0);
});

test("T8 安装版本变化随下次请求生效并遵循 CLI 版本回退", async () => {
  const fixture = await installation();
  const captured = [];
  const instance = new WorkBuddyAdapter(fixture.config, {
    credentials: async () => credentials,
    fetch: async (_url, options) => {
      captured.push(new Headers(options.headers));
      return response();
    },
  });
  await collect(instance.stream(request));
  fixture.product.genieVersion = "10.0.1";
  fixture.pkg.version = "3.0.0-beta.1";
  await fixture.write();
  await collect(instance.stream(request));
  delete fixture.pkg.version;
  await fixture.write();
  await collect(instance.stream(request));
  assert.deepEqual(
    captured.map((headers) => headers.get("user-agent")),
    [
      "WorkBuddy/9.8.7 WorkBuddy/9.8.7 CLI/2.3.4",
      "WorkBuddy/10.0.1 WorkBuddy/10.0.1 CLI/3.0.0-beta.1",
      "WorkBuddy/10.0.1 WorkBuddy/10.0.1 CLI/2.3.4",
    ],
  );
  assert.deepEqual(
    captured.map((headers) => headers.get("x-ide-version")),
    ["9.8.7", "10.0.1", "10.0.1"],
  );
});

test("T9 安装元数据异常在凭据读取与请求前结束", async () => {
  const invalidMetadata = [
    ["product.json", null],
    ["product.json", "{bad"],
    [
      "product.json",
      JSON.stringify({ productName: "AnotherApp", genieVersion: "1.0.0" }),
    ],
    [
      "product.json",
      JSON.stringify({
        productName: "WorkBuddy",
        genieVersion: "1.0.0\r\nX-Injected: yes",
      }),
    ],
    ["product.json", JSON.stringify({ productName: "WorkBuddy" })],
    ["package.json", null],
    ["package.json", JSON.stringify({ version: "0.0.0" })],
    ["package.json", JSON.stringify({ version: "invalid" })],
  ];
  for (const [file, data] of invalidMetadata) {
    const fixture = await installation();
    if (data === null) await rm(join(fixture.cli, file));
    else await writeFile(join(fixture.cli, file), data);
    let credentialReads = 0;
    let fetchCalls = 0;
    const instance = new WorkBuddyAdapter(fixture.config, {
      credentials: async () => {
        credentialReads += 1;
        return credentials;
      },
      fetch: async () => {
        fetchCalls += 1;
        return response();
      },
    });
    await assert.rejects(
      collect(instance.stream(request)),
      (error) => error.code === "WORKBUDDY_CLIENT_INFO_UNAVAILABLE",
      `${file}: ${data}`,
    );
    assert.equal(credentialReads, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("T10 HTTP 或渠道拒绝均只发起一次请求", async () => {
  for (const [status, code, expected] of [
    [400, undefined, "WORKBUDDY_HTTP_400"],
    [401, undefined, "WORKBUDDY_HTTP_401"],
    [403, undefined, "WORKBUDDY_HTTP_403"],
    [400, 11128, "WORKBUDDY_CHANNEL_REJECTED"],
    [400, 12403, "WORKBUDDY_HTTP_400"],
  ]) {
    let calls = 0;
    await assert.rejects(
      collect(
        adapter(async () => {
          calls += 1;
          return Response.json({ code, msg: "rejected" }, { status });
        }).stream(request),
      ),
      (error) => error.code === expected,
    );
    assert.equal(calls, 1);
  }
});

test("T11 真实 hi 响应的空结束原因持续输出直到 stop", async () => {
  const raw = await readFile(
    new URL("./fixtures/workbuddy-hi.sse", import.meta.url),
    "utf8",
  );
  const credits = [];
  const chunks = await collect(
    adapter(async () => response(raw), {
      onCredit: (value) => credits.push(value),
    }).stream(request),
  );
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join(""),
    "Hello! How can I help you today?",
  );
  assert.equal(chunks.find((c) => c.type === "usage").usage.totalTokens, 14);
  assert.deepEqual(credits, [0]);
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("T12 未知结束原因与缺失最终结束事件继续报错", async () => {
  for (const finish_reason of ["", "unexpected"]) {
    await assert.rejects(
      collect(
        adapter(async () =>
          response(
            event({
              choices: [{ delta: { content: "partial" }, finish_reason }],
            }) + "data: [DONE]\n\n",
          ),
        ).stream(request),
      ),
      /WORKBUDDY_PROTOCOL/,
    );
  }
});

test("T13 远端目录决定可选模型并解析第二个模型", async () => {
  const instance = adapter(async () => response(), {
    models: async () => [
      {
        provider: "workbuddy",
        id: config.model,
        name: "DeepSeek",
        inputModalities: ["text"],
      },
      {
        provider: "workbuddy",
        id: "glm-5.3",
        name: "GLM",
        inputModalities: ["text"],
      },
    ],
  });
  assert.equal((await instance.listModels("workbuddy")).length, 2);
  assert.equal(
    (await instance.resolveModel("workbuddy", "glm-5.3")).id,
    "glm-5.3",
  );
});

test("T14 请求与 SSE 响应关联到调用者 session 并排除凭据", async () => {
  const traces = [];
  const chunks = await collect(
    adapter(
      async (_url, init) => {
        assert.equal(
          new Headers(init.headers).get("x-conversation-id"),
          "fixture-session",
        );
        return response(
          event({
            id: "remote-response",
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          }) + "data: [DONE]\n\n",
        );
      },
      { onTrace: (sessionId, data) => traces.push({ sessionId, ...data }) },
    ).stream({ ...request, sessionId: "fixture-session" }),
  );
  assert.equal(traces[0].phase, "request");
  assert.equal(traces[0].conversationId, "fixture-session");
  assert.ok(traces.some((t) => t.responseId === "remote-response"));
  assert.equal(
    chunks.at(-1).replayState.response.responseId,
    "remote-response",
  );
  assert.doesNotMatch(JSON.stringify(traces), new RegExp(token));
  assert.ok(traces.every((t) => t.requestId === traces[0].requestId));
});

test("T15 工具声明和结果历史保持关联，分片工具调用交给 KMH", async () => {
  const stream =
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "lookup", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: "",
        },
      ],
    }) +
    event({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    "data: [DONE]\n\n";
  const chunks = await collect(
    adapter(async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tools[0].function.name, "lookup");
      assert.equal(body.messages[1].tool_calls[0].id, "older-call");
      assert.equal(body.messages[2].tool_call_id, "older-call");
      return response(stream);
    }).stream({
      ...request,
      tools: [
        {
          name: "lookup",
          description: "lookup",
          parameters: { type: "object" },
        },
      ],
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: "older-call",
              name: "lookup",
              arguments: "{}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "older-call",
          content: [{ type: "text", text: "result" }],
        },
      ],
    }),
  );
  assert.deepEqual(chunks.find((c) => c.type === "block-end").block, {
    type: "tool-call",
    id: "call-1",
    name: "lookup",
    arguments: '{"q":"x"}',
  });
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});

test("T16 HTTP 错误体与请求关联保存，脱敏后保留业务码", async () => {
  const traces = [];
  await assert.rejects(
    collect(
      adapter(
        async () =>
          new Response(
            JSON.stringify({
              code: 11128,
              message: `rejected ${token}`,
              id: "rejection-id",
            }),
            { status: 400 },
          ),
        { onTrace: (_id, event) => traces.push(event) },
      ).stream({ ...request, sessionId: "failed-session" }),
    ),
    /WORKBUDDY_CHANNEL_REJECTED/,
  );
  const raw = traces.find((t) => t.phase === "event")?.raw;
  assert.match(raw ?? "", /11128/);
  assert.doesNotMatch(raw ?? "", new RegExp(token));
  assert.equal(traces.at(-1).responseId, "rejection-id");
});
