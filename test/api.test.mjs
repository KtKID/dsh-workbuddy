/** 合成账号与官方形态响应验证目录、积分、缓存和失败隔离。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkBuddyApi } from "../lib/api.js";
import { ConfigSchema } from "../lib/schema.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wb-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "Contents/Resources/app.asar.unpacked/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(
    join(cli, "product.json"),
    JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.8.3" }),
  );
  await writeFile(
    join(cli, "package.json"),
    JSON.stringify({ version: "2.161.0" }),
  );
  let uid = "user-a";
  let calls = 0;
  let fail = false;
  const api = new WorkBuddyApi(
    ConfigSchema.parse({ electronPath: join(root, "Contents/MacOS/Electron") }),
    {
      credentials: async () => ({
        accessToken: "synthetic-secret",
        userId: uid,
        expiresAt: Date.now() + 60000,
      }),
      fetch: async (url, init) => {
        calls++;
        assert.equal(new Headers(init.headers).get("x-ide-name"), "WorkBuddy");
        if (fail) return new Response("synthetic-secret", { status: 401 });
        return Response.json(
          url.endsWith("/v3/config")
            ? {
                code: 0,
                data: {
                  models: [
                    {
                      id: "a",
                      name: "A",
                      supportsToolCall: true,
                      credits: uid === "user-a" ? "x0.15" : "x0.00",
                    },
                    { id: "a-shadow", name: "A", supportsToolCall: true },
                    {
                      id: "a",
                      name: "A",
                      supportsToolCall: true,
                      credits: uid === "user-a" ? "x0.15" : "x0.00",
                    },
                    { id: "b", name: "B" },
                    {
                      id: "disabled",
                      name: "Disabled",
                      disabled: true,
                      supportsToolCall: true,
                    },
                    { id: "image", name: "Image", tags: ["text-to-image"] },
                  ],
                  agents: [{ name: "cli", models: ["a", "b"] }],
                },
              }
            : {
                code: 0,
                data: {
                  TotalCredits: uid === "user-a" ? "123.5" : "0",
                  SubscriptionPackageName: "Plan",
                  CreditGroups: [
                    { Name: "赠送", CycleRemainCapacity: "123.5" },
                  ],
                },
              },
        );
      },
    },
  );
  return {
    api,
    calls: () => calls,
    account: (value) => {
      uid = value;
    },
    fail: () => {
      fail = true;
    },
  };
}
test("目录采用真实返回并过滤停用和媒体项；余额可表示零，刷新合并", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.api.status(), f.api.status()]);
  assert.deepEqual(a, b);
  assert.equal(f.calls(), 2);
  assert.deepEqual(
    a.models.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(a.balance.total, 123.5);
  assert.deepEqual(
    (await f.api.models()).map((m) => ({ id: m.id, name: m.name })),
    [
      { id: "a", name: "A · ×0.15" },
      { id: "b", name: "B" },
    ],
  );
  assert.equal(f.calls(), 2);
  await f.api.status(true);
  assert.equal(f.calls(), 4);
  f.account("user-b");
  assert.equal((await f.api.status()).balance.total, 0);
  assert.equal(f.calls(), 6);
  assert.equal((await f.api.models())[0].name, "A · ×0.00");
});
test("失败保留同账号旧快照；换账号失败清空旧余额且脱敏", async (t) => {
  const f = await fixture(t);
  await f.api.status();
  f.fail();
  const old = await f.api.status(true);
  assert.equal(old.balance.total, 123.5);
  assert.equal(old.error, "WORKBUDDY_ACCOUNT_QUERY_FAILED");
  f.account("user-b");
  const next = await f.api.status();
  assert.equal(next.balance, null);
  assert.deepEqual(next.models, []);
  assert.doesNotMatch(JSON.stringify(next), /synthetic-secret/);
});
