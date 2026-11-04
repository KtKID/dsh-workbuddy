/** 用私有凭据和独立 CLI 布局验证 Linux 运行路径，全程使用本地夹具。 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDesktopCredentials } from "../lib/credentials.js";
import { readWorkBuddyClientHeaders } from "../lib/client-info.js";
import { nativeCompletion } from "../lib/native.js";
import { ConfigSchema } from "../lib/schema.js";

const credentials = {
  accessToken: "portable-fixture-secret",
  userId: "portable-fixture-user",
  expiresAt: Date.now() + 600_000,
};

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "wb-portable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cliPath = join(dir, "runtime/dist/codebuddy-lite-wb.mjs");
  const credentialsFile = join(dir, "credentials.json");
  await mkdir(join(dir, "runtime/dist"), { recursive: true });
  await writeFile(credentialsFile, JSON.stringify(credentials), {
    mode: 0o600,
  });
  await writeFile(
    join(dir, "runtime/product.json"),
    JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.9.3" }),
  );
  await writeFile(
    join(dir, "runtime/package.json"),
    JSON.stringify({ version: "2.165.0" }),
  );
  return {
    root: dir,
    cliPath,
    credentialsFile,
    config: ConfigSchema.parse({
      cliPath,
      credentialsFile,
      electronPath: "/missing/Electron",
    }),
  };
}

test("Linux 私有凭据文件可读取，客户端标识使用同一显式 CLI 的元数据", async (t) => {
  const { config } = await setup(t);
  assert.deepEqual(await readDesktopCredentials(config), credentials);
  assert.equal(
    (await readWorkBuddyClientHeaders(config))["X-IDE-Version"],
    "5.9.3",
  );
});

test("过期、宽权限、损坏和超大凭据统一拒绝，诊断隐藏文件内容", async (t) => {
  const { config, credentialsFile } = await setup(t);
  const reject = () =>
    assert.rejects(readDesktopCredentials(config), (error) => {
      assert.equal(error.code, "WORKBUDDY_AUTH_UNAVAILABLE");
      assert.equal(error.message.includes(credentials.accessToken), false);
      return true;
    });
  await chmod(credentialsFile, 0o644);
  await reject();
  await chmod(credentialsFile, 0o600);
  await writeFile(
    credentialsFile,
    JSON.stringify({ ...credentials, expiresAt: 1 }),
  );
  await reject();
  await writeFile(credentialsFile, credentials.accessToken);
  await reject();
  await writeFile(credentialsFile, " ".repeat(65_537));
  await reject();
});

test("显式 CLI 路径通过官方 ACP SDK 执行，沿用模型与令牌输入", async (t) => {
  const { config, cliPath, root } = await setup(t);
  await writeFile(
    cliPath,
    `import {serve} from ${JSON.stringify(new URL("./support/acp-agent.mjs", import.meta.url).href)};await serve(${JSON.stringify({ root, mode: "text", expectedAuth: credentials.accessToken, expectedModel: "fixture-model", expectedPrompt: "portable-request" })});`,
  );
  const chunks = [];
  for await (const chunk of nativeCompletion(
    {
      provider: "workbuddy",
      model: "fixture-model",
      messages: [
        { role: "user", content: [{ type: "text", text: "portable-request" }] },
      ],
    },
    config,
    credentials,
    () => {},
  ))
    chunks.push(chunk);
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join(""),
    "hello",
  );
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(chunks.at(-1).replayState.response.transport, "acp-v1");
});
