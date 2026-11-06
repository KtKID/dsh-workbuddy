/** 经详情页宿主路由验证 WorkBuddy 网页授权及独立凭据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mountWeb } from "../lib/web.js";

const routes = () => {
  const handlers = new Map();
  return {
    handlers,
    context: {
      connection: {
        fetch: { register: (route) => handlers.set(route.path, route.fetch) },
      },
    },
  };
};

test("详情页有网页登录、结果查询和当前方式选择的后端入口", () => {
  const { handlers, context } = routes();
  mountWeb(context, {}, {});
  assert.ok(handlers.has("/api/workbuddy/login/start"), "缺少网页登录入口");
  assert.ok(handlers.has("/api/workbuddy/login/poll"));
  assert.ok(handlers.has("/api/workbuddy/login/select"));
  assert.ok(handlers.has("/api/workbuddy/login/sign-out"));
});

import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../lib/schema.js";
import { WorkBuddyLogin } from "../lib/web-login.js";

const origins = {
  cn: "https://www.codebuddy.cn",
  global: "https://www.workbuddy.ai",
};
const webSecret = "synthetic-web-secret";
const localSecret = "synthetic-local-secret";
const clockStart = Date.now();

async function fixture(
  t,
  {
    local = false,
    region = "cn",
    authUrl,
    tokenDomain,
    profile = { uid: "web-uid", nickname: "Web" },
    conflict = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wb-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "workbuddy");
  const webFile = join(dataDir, "web-login.json");
  const credentialsFile = conflict ? webFile : join(root, "local.json");
  const localJson = JSON.stringify({
    accessToken: localSecret,
    userId: "local-uid",
    expiresAt: Date.now() + 600_000,
  });
  if (local) {
    if (conflict) await mkdir(dataDir, { mode: 0o700 });
    await writeFile(credentialsFile, localJson, { mode: 0o600 });
  }
  let authorized = false;
  let now = clockStart;
  let tokenReads = 0;
  let beforeProfile = async () => {};
  const domain = tokenDomain ?? new URL(origins[region]).hostname;
  const cliPath = join(root, "cli", "dist", "workbuddy.mjs");
  const config = ConfigSchema.parse({ credentialsFile, cliPath });
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origins[region]);
    assert.equal(init.redirect, "error");
    if (parsed.pathname.endsWith("/auth/state")) {
      assert.equal(init.method, "POST");
      assert.equal(parsed.searchParams.get("platform"), "workbuddy");
      return Response.json({
        code: 0,
        data: { state: "state-value", ...(authUrl ? { authUrl } : {}) },
      });
    }
    if (parsed.pathname.endsWith("/auth/token")) {
      tokenReads++;
      assert.equal(parsed.searchParams.get("state"), "state-value");
      return Response.json(
        authorized
          ? {
              code: 0,
              data: { accessToken: webSecret, domain, expiresIn: 600 },
            }
          : { code: 401, data: {} },
      );
    }
    assert.ok(parsed.pathname.endsWith("/login/account"));
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${webSecret}`,
    );
    await beforeProfile();
    return Response.json({ code: 0, data: profile });
  };
  const login = new WorkBuddyLogin(config, {
    dataDir,
    fetch,
    now: () => now,
  });
  const { handlers, context } = routes();
  mountWeb(
    context,
    {
      status: async () => ({
        models: [],
        balance: null,
        updatedAt: null,
        error: null,
      }),
    },
    login,
  );
  const call = (action, body) =>
    handlers.get(`/api/workbuddy/login/${action}`)(
      new Request("http://localhost/api/workbuddy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const start = async () => {
    const response = await call("start", { region });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(new URL(result.url).origin, origins[region]);
    assert.equal(result.expiresInMs, 600_000);
    return result.loginId;
  };
  return {
    login,
    authFetch: fetch,
    root,
    config,
    dataDir,
    webFile,
    credentialsFile,
    localJson,
    call,
    start,
    authorize: () => {
      authorized = true;
    },
    advance: (ms) => {
      now += ms;
    },
    tokenReads: () => tokenReads,
    beforeProfile: (hook) => {
      beforeProfile = hook;
    },
  };
}

test("尚未保存网页登录时，已有的数据目录不影响本地凭据读取", async (t) => {
  const f = await fixture(t, { local: true });
  await mkdir(f.dataDir, { mode: 0o755 });
  assert.equal(
    (await f.login.resolveAccount()).credentials.accessToken,
    localSecret,
  );
  await assert.rejects(stat(f.webFile), { code: "ENOENT" });
});

for (const region of ["cn", "global"]) {
  test(`${region} 网页授权走固定站点并独立保存，重复轮询只提交一次`, async (t) => {
    const f = await fixture(t, { region });
    const loginId = await f.start();
    assert.deepEqual(await (await f.call("poll", { loginId })).json(), {
      status: "waiting",
    });
    f.authorize();
    const results = await Promise.all([
      f.call("poll", { loginId }),
      f.call("poll", { loginId }),
    ]);
    for (const response of results) {
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        status: "success",
        region,
        name: "Web",
      });
    }
    assert.deepEqual(await (await f.call("poll", { loginId })).json(), {
      status: "success",
      region,
      name: "Web",
    });
    assert.equal(f.tokenReads(), 2);
    assert.equal((await stat(f.webFile)).mode & 0o777, 0o600);
    assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
    const stored = JSON.parse(await readFile(f.webFile, "utf8"));
    assert.deepEqual(Object.keys(stored), ["source", "web"]);
    assert.equal(stored.web.credentials.expiresAt, clockStart + 600_000);
    assert.equal(
      (await f.login.resolveAccount()).credentials.accessToken,
      webSecret,
    );
    await assert.rejects(stat(f.credentialsFile), { code: "ENOENT" });
  });
}

test("已有本地登录时网页授权独立保存，选择可来回切换且本地文件保持只读", async (t) => {
  const f = await fixture(t, { local: true });
  assert.equal(
    (await f.login.resolveAccount()).credentials.accessToken,
    localSecret,
  );
  await assert.rejects(stat(f.webFile), { code: "ENOENT" });
  const loginId = await f.start();
  f.authorize();
  assert.equal(
    (await (await f.call("poll", { loginId })).json()).status,
    "success",
  );
  assert.equal(
    (await f.login.resolveAccount()).credentials.accessToken,
    localSecret,
  );
  assert.equal(
    (await (await f.call("select", { source: "web" })).json()).source,
    "web",
  );
  assert.equal(
    (await f.login.resolveAccount()).credentials.accessToken,
    webSecret,
  );
  assert.equal(
    (await (await f.call("select", { source: "local" })).json()).source,
    "local",
  );
  assert.equal(
    (await f.login.resolveAccount()).credentials.accessToken,
    localSecret,
  );
  assert.equal(await readFile(f.credentialsFile, "utf8"), f.localJson);
  assert.equal((await stat(f.credentialsFile)).mode & 0o777, 0o600);
});

for (const local of [true, false]) {
  test(`退出网页登录移除私有凭据，${local ? "恢复本地账号" : "清空当前账号"}`, async (t) => {
    const f = await fixture(t, { local, region: "global" });
    const id = await f.start();
    f.authorize();
    assert.equal(
      (await (await f.call("poll", { loginId: id })).json()).status,
      "success",
    );
    assert.equal((await f.call("select", { source: "web" })).status, 200);
    f.advance(600_001);
    assert.equal((await f.login.snapshot()).view.webRegion, "global");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.call("sign-out", {});
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        source: "local",
        localAvailable: local,
        webAvailable: false,
      });
    }
    await assert.rejects(stat(f.webFile), { code: "ENOENT" });
    if (local) {
      assert.equal(
        (await f.login.resolveAccount()).credentials.accessToken,
        localSecret,
      );
      assert.equal(await readFile(f.credentialsFile, "utf8"), f.localJson);
    } else {
      assert.equal((await f.login.snapshot()).account, null);
    }
    const next = await f.start();
    assert.equal(
      (await (await f.call("poll", { loginId: next })).json()).status,
      "success",
    );
    assert.equal(
      (await f.login.snapshot()).view.source,
      local ? "local" : "web",
    );
  });
}

test("退出网页登录使已在途的授权结果失效", async (t) => {
  const f = await fixture(t);
  const loginId = await f.start();
  f.authorize();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  f.beforeProfile(() => {
    entered.resolve();
    return released.promise;
  });
  const pending = f.call("poll", { loginId });
  await entered.promise;
  assert.equal((await f.call("sign-out", {})).status, 200);
  released.resolve();
  assert.deepEqual(await (await pending).json(), { status: "error" });
  await assert.rejects(stat(f.webFile), { code: "ENOENT" });
});

test("过期尝试与迟到的旧授权不能写入插件凭据", async (t) => {
  const f = await fixture(t);
  const expired = await f.start();
  f.advance(600_000);
  assert.deepEqual(await (await f.call("poll", { loginId: expired })).json(), {
    status: "error",
  });
  assert.equal(f.tokenReads(), 0);
  const old = await f.start();
  f.authorize();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  f.beforeProfile(() => {
    entered.resolve();
    return released.promise;
  });
  const pending = f.call("poll", { loginId: old });
  await entered.promise;
  const current = await f.start();
  released.resolve();
  assert.deepEqual(await (await pending).json(), { status: "error" });
  await assert.rejects(stat(f.webFile), { code: "ENOENT" });
  assert.equal(
    (await (await f.call("poll", { loginId: current })).json()).status,
    "success",
  );
});

test("错误地区、未知 UID、不安全链接与无效输入返回脱敏失败", async (t) => {
  const badUrl = await fixture(t, {
    authUrl: "https://www.workbuddy.ai.attacker.invalid/login",
  });
  assert.equal((await badUrl.call("start", { region: "cn" })).status, 409);
  assert.equal((await badUrl.call("start", { region: "invalid" })).status, 400);
  for (const options of [
    { tokenDomain: "www.workbuddy.ai" },
    { profile: {} },
  ]) {
    const f = await fixture(t, options);
    const loginId = await f.start();
    f.authorize();
    assert.deepEqual(await (await f.call("poll", { loginId })).json(), {
      status: "error",
    });
    await assert.rejects(stat(f.webFile), { code: "ENOENT" });
  }
});

test("本地凭据路径冲突或插件目录被替换时，授权提交保留原文件", async (t) => {
  const conflict = await fixture(t, { local: true, conflict: true });
  const first = await conflict.start();
  conflict.authorize();
  assert.deepEqual(
    await (await conflict.call("poll", { loginId: first })).json(),
    { status: "error" },
  );
  assert.equal(
    await readFile(conflict.credentialsFile, "utf8"),
    conflict.localJson,
  );
  const linked = await fixture(t, { local: true });
  await symlink(linked.root, linked.dataDir);
  const second = await linked.start();
  linked.authorize();
  assert.deepEqual(
    await (await linked.call("poll", { loginId: second })).json(),
    { status: "error" },
  );
  assert.equal(
    await readFile(linked.credentialsFile, "utf8"),
    linked.localJson,
  );
});

import { apply } from "../lib/index.js";

async function attachCli(f) {
  const cliDir = join(f.root, "cli");
  await mkdir(join(cliDir, "dist"), { recursive: true });
  await writeFile(
    join(cliDir, "product.json"),
    JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.9.3" }),
  );
  await writeFile(
    join(cliDir, "package.json"),
    JSON.stringify({ version: "2.165.0" }),
  );
  const records = join(f.root, "account-requests.jsonl");
  await writeFile(
    f.config.cliPath,
    `import { appendFile } from "node:fs/promises";
import { serve } from ${JSON.stringify(new URL("./support/acp-agent.mjs", import.meta.url).href)};
await appendFile(${JSON.stringify(records)}, JSON.stringify({user: process.env.ACC_USER_ID, token: process.env.CODEBUDDY_AUTH_TOKEN, product: process.env.ACC_PRODUCT_CONFIG_V3 ? JSON.parse(process.env.ACC_PRODUCT_CONFIG_V3) : null}) + "\\n");
await serve({ root: ${JSON.stringify(f.root)} });\n`,
  );
  return async () =>
    (await readFile(records, "utf8")).trim().split("\n").map(JSON.parse);
}

test(
  "积分、模型和 ACP 对话共用所选账号，国际区使用国际服务",
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t, { local: true, region: "global" });
    const readCli = await attachCli(f);
    const seen = [];
    let holdLocal;
    const previousRoot = process.env.DSH_HOME;
    process.env.DSH_HOME = f.root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousRoot;
    });
    t.mock.method(globalThis, "fetch", async (url, init) => {
      if (new URL(url).pathname.startsWith("/v2/plugin/"))
        return f.authFetch(url, init);
      const host = new URL(url).hostname;
      const authorization = new Headers(init.headers).get("authorization");
      const user = new Headers(init.headers).get("x-user-id");
      seen.push({ host, authorization, user });
      const web = authorization === `Bearer ${webSecret}`;
      if (!web && holdLocal) await holdLocal();
      assert.equal(host, web ? "www.workbuddy.ai" : "www.workbuddy.cn");
      return Response.json(
        url.endsWith("/v3/config")
          ? {
              code: 0,
              data: {
                models: [
                  {
                    id: "fixture-model",
                    name: web ? "Web" : "Local",
                    supportsToolCall: true,
                  },
                ],
              },
            }
          : {
              code: 0,
              data: {
                TotalCredits: web ? 20 : 10,
                SubscriptionPackageName: "Fixture",
                CreditGroups: [],
              },
            },
      );
    });
    const { context, handlers } = routes();
    let adapter;
    let updates = 0;
    apply(
      {
        ...context,
        inject: (_, load) => load(context),
        llm: {
          registerAdapter: (_, instance) => {
            adapter = instance;
            return {
              replace: (names) => {
                assert.deepEqual(names, ["workbuddy"]);
                updates++;
              },
            };
          },
        },
      },
      f.config,
    );
    assert.ok(adapter);
    const call = (action, body) =>
      handlers.get(`/api/workbuddy/login/${action}`)(
        new Request("http://localhost/api/workbuddy", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const details = async (method = "GET") =>
      (
        await handlers.get("/api/workbuddy/status")(
          new Request("http://localhost/api/workbuddy/status", { method }),
        )
      ).json();
    const chat = async () => {
      const chunks = await Array.fromAsync(
        adapter.stream({
          provider: "workbuddy",
          model: "fixture-model",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      );
      assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
    };
    const { loginId } = await (
      await call("start", { region: "global" })
    ).json();
    f.authorize();
    assert.equal(
      (await (await call("poll", { loginId })).json()).status,
      "success",
    );
    assert.equal((await details()).balance.total, 10);
    assert.equal((await adapter.listModels("workbuddy"))[0].name, "Local");
    await chat();
    const old = Promise.withResolvers();
    const entered = Promise.withResolvers();
    holdLocal = () => {
      entered.resolve();
      return old.promise;
    };
    const prior = details("POST");
    await entered.promise;
    try {
      assert.equal(
        (await (await call("select", { source: "web" })).json()).source,
        "web",
      );
      assert.equal((await details()).balance.total, 20);
    } finally {
      old.resolve();
      holdLocal = undefined;
      await prior;
    }
    assert.equal((await details()).balance.total, 20);
    assert.equal((await adapter.listModels("workbuddy"))[0].name, "Web");
    await chat();
    const sent = await readCli();
    assert.deepEqual(
      sent.map(({ user, token }) => [user, token]),
      [
        ["local-uid", localSecret],
        ["web-uid", webSecret],
      ],
    );
    assert.equal(sent[0].product, null);
    assert.equal(sent[1].product.endpoint, "https://www.workbuddy.ai");
    assert.ok(
      seen.some(
        ({ host, user }) => host === "www.workbuddy.ai" && user === "web-uid",
      ),
    );
    assert.equal(
      (await (await call("select", { source: "local" })).json()).source,
      "local",
    );
    assert.equal((await details()).balance.total, 10);
    assert.equal(updates, 2);
    assert.equal(await readFile(f.credentialsFile, "utf8"), f.localJson);
  },
);
