/** WorkBuddy 网页授权与插件私有凭据，桌面登录仅经只读入口读取。 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import { readDesktopCredentials } from "./credentials.js";
import {
  LoginRegionSchema,
  LoginSourceSchema,
  type LoginPoll,
  type LoginRegion,
  type LoginSource,
  type LoginView,
} from "./public-schema.js";
import {
  CredentialsSchema,
  workBuddyDataDir,
  type Credentials,
  type WorkBuddyAccount,
  type WorkBuddyConfig,
} from "./schema.js";

const LOGIN_TTL_MS = 600_000;
const LOGIN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECORD_BYTES = 64 * 1024;
const loginOrigins = {
  cn: "https://www.codebuddy.cn",
  global: "https://www.workbuddy.ai",
} as const;
const domainRoots = {
  cn: ["codebuddy.cn", "workbuddy.cn", "copilot.tencent.com"],
  global: ["workbuddy.ai"],
} as const;

const StoredLogin = z.strictObject({
  source: LoginSourceSchema,
  web: z.strictObject({
    region: LoginRegionSchema,
    credentials: CredentialsSchema,
    name: z.string().max(160).optional(),
  }),
});
type StoredLogin = z.infer<typeof StoredLogin>;
type WebCredentials = StoredLogin["web"];
const Envelope = z.object({ code: z.number().optional(), data: z.unknown() });
const text = z.union([z.string(), z.number()]).optional();
const StartData = z.object({
  state: text,
  State: text,
  authUrl: text,
  auth_url: text,
  url: text,
  Url: text,
});
const TokenData = z.object({
  accessToken: text,
  access_token: text,
  AccessToken: text,
  domain: text,
  Domain: text,
  expiresAt: text,
  expires_at: text,
  expiresIn: z.number().optional(),
  expires_in: z.number().optional(),
});
const AccountData = z.object({
  uid: text,
  Uid: text,
  userId: text,
  UserID: text,
  nickname: text,
  NickName: text,
  ScreenName: text,
  enterpriseId: text,
  EnterpriseId: text,
  domain: text,
  Domain: text,
});

type Attempt = {
  id: string;
  region: LoginRegion;
  deadline: number;
  state?: string;
  pending?: Promise<LoginPoll>;
  result?: LoginPoll;
};

function firstText(
  ...values: (string | number | undefined)[]
): string | undefined {
  return values.map((value) => String(value ?? "").trim()).find(Boolean);
}

function matchesRegion(domain: string, region: LoginRegion): boolean {
  const host = domain.toLowerCase();
  return domainRoots[region].some(
    (root) => host === root || host.endsWith(`.${root}`),
  );
}

function expiry(token: z.infer<typeof TokenData>, receivedAt: number): number {
  const timestamp = Number(firstText(token.expiresAt, token.expires_at));
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
  }
  const seconds = token.expiresIn ?? token.expires_in;
  return seconds && seconds > 0 ? receivedAt + seconds * 1000 : 0;
}

function unavailable(): LlmError {
  return new LlmError(
    "WORKBUDDY_AUTH_UNAVAILABLE",
    "WORKBUDDY_AUTH_UNAVAILABLE",
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    return parent === path
      ? path
      : join(await canonicalPath(parent), basename(path));
  }
}

/** 维护单次网页授权、已选账号与磁盘提交边界。 */
export class WorkBuddyLogin {
  private readonly file: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private attempt: Attempt | undefined;
  private committing: Promise<void> | undefined;
  private readonly onChange: (() => void) | undefined;

  constructor(
    private readonly config: WorkBuddyConfig,
    dependencies: {
      dataDir?: string;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      onChange?: () => void;
    } = {},
  ) {
    this.file = resolve(
      dependencies.dataDir ?? workBuddyDataDir(),
      "web-login.json",
    );
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.onChange = dependencies.onChange;
  }

  private async read(): Promise<StoredLogin | undefined> {
    try {
      await lstat(this.file);
      await this.privateDirectory();
      const file = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > MAX_RECORD_BYTES ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw unavailable();
        return StoredLogin.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw unavailable();
    }
  }

  private async privateDirectory(): Promise<void> {
    const stat = await lstat(dirname(this.file));
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw unavailable();
  }

  private async mutate(
    update: (
      current: StoredLogin | undefined,
    ) =>
      | StoredLogin
      | null
      | undefined
      | Promise<StoredLogin | null | undefined>,
  ): Promise<void> {
    const target = await canonicalPath(this.file);
    const lock = await canonicalPath(`${this.file}.lock`);
    for (const local of [this.config.authFile, this.config.credentialsFile]) {
      if (!local) continue;
      const path = await canonicalPath(resolve(local));
      if (path === target || path === lock) throw unavailable();
    }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await this.privateDirectory();
    await withFileLock(this.file, async () => {
      const next = await update(await this.read());
      if (next === null) await unlink(this.file);
      else if (next)
        await writeFileAtomic(
          this.file,
          JSON.stringify(StoredLogin.parse(next)),
          { mode: 0o600 },
        );
    });
  }

  private local(): Promise<Credentials | undefined> {
    return readDesktopCredentials(this.config).catch(() => undefined);
  }

  private web(record: StoredLogin | undefined): WebCredentials | undefined {
    return record &&
      this.config.transport === "cli" &&
      record.web.credentials.expiresAt > this.now() &&
      record.web.credentials.domain &&
      matchesRegion(record.web.credentials.domain, record.web.region)
      ? record.web
      : undefined;
  }

  /** 返回选用方式的凭据，选定方式不可用时抛出固定认证错误。 */
  async resolveAccount(): Promise<WorkBuddyAccount> {
    const record = await this.read();
    if (record?.source !== "web")
      return {
        source: "local",
        credentials: await readDesktopCredentials(this.config),
      };
    const web = this.web(record);
    if (!web) throw unavailable();
    return { source: "web", region: web.region, credentials: web.credentials };
  }

  /** 从同一份选用记录生成详情视图与请求凭据。 */
  async snapshot(): Promise<{
    view: LoginView;
    account: WorkBuddyAccount | null;
  }> {
    const record = await this.read();
    const local = await this.local();
    const web = this.web(record);
    const source = record?.source ?? "local";
    return {
      view: {
        source,
        localAvailable: Boolean(local),
        webAvailable: Boolean(web),
        ...(record
          ? {
              webRegion: record.web.region,
              ...(web?.name ? { webName: web.name } : {}),
            }
          : {}),
      },
      account:
        source === "local"
          ? local
            ? { source, credentials: local }
            : null
          : web
            ? { source, region: web.region, credentials: web.credentials }
            : null,
    };
  }

  /** 选择可用方式并提交，返回新的详情视图。 */
  async select(source: LoginSource): Promise<LoginView> {
    let changed = false;
    await this.mutate(async (current) => {
      if (source === "local" ? !(await this.local()) : !this.web(current))
        throw unavailable();
      if (!current || current.source === source) return undefined;
      changed = true;
      return { ...current, source };
    });
    if (changed) this.onChange?.();
    return (await this.snapshot()).view;
  }

  /** 清除插件保存的网页登录凭据，返回本地登录视图。 */
  async signOut(): Promise<LoginView> {
    this.attempt = undefined;
    let activeWeb = false;
    await this.mutate((current) => {
      activeWeb = current?.source === "web";
      return current ? null : undefined;
    });
    if (activeWeb) this.onChange?.();
    return (await this.snapshot()).view;
  }

  private async request(
    region: LoginRegion,
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    return this.fetch(`${loginOrigins[region]}/v2/plugin${path}`, {
      ...options,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
    });
  }

  /** 向选定地区申请 state，只返回校验过的官方地址和本地尝试编号。 */
  async start(
    region: LoginRegion,
  ): Promise<{ loginId: string; url: string; expiresInMs: number }> {
    if (this.config.transport !== "cli") throw unavailable();
    if (this.committing) await this.committing.catch(() => undefined);
    const attempt = {
      id: randomUUID(),
      region,
      deadline: this.now() + LOGIN_TTL_MS,
    } satisfies Attempt;
    this.attempt = attempt;
    const response = await this.request(
      region,
      "/auth/state?platform=workbuddy",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!response.ok) throw unavailable();
    const data = StartData.parse(Envelope.parse(await response.json()).data);
    const state = firstText(data.state, data.State);
    if (!state || this.attempt !== attempt || attempt.deadline <= this.now())
      throw unavailable();
    const url = new URL(
      firstText(data.authUrl, data.auth_url, data.url, data.Url) ??
        `/login?state=${encodeURIComponent(state)}`,
      loginOrigins[region],
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !matchesRegion(url.hostname, region)
    )
      throw unavailable();
    this.attempt = { ...attempt, state };
    return {
      loginId: attempt.id,
      url: url.href,
      expiresInMs: attempt.deadline - this.now(),
    };
  }

  /** 查询一次授权结果，并合并同一个编号的在途请求。 */
  async poll(id: string): Promise<LoginPoll> {
    const attempt = this.attempt;
    if (
      !attempt ||
      attempt.id !== id ||
      attempt.deadline <= this.now() ||
      !attempt.state
    ) {
      return { status: "error" };
    }
    if (attempt.result) return attempt.result;
    if (attempt.pending) return attempt.pending;
    const pending = this.exchange(attempt, attempt.state).finally(() => {
      delete attempt.pending;
    });
    attempt.pending = pending;
    return pending;
  }

  private async exchange(attempt: Attempt, state: string): Promise<LoginPoll> {
    let envelope: z.infer<typeof Envelope>;
    let receivedAt: number;
    try {
      const response = await this.request(
        attempt.region,
        `/auth/token?state=${encodeURIComponent(state)}`,
      );
      if (!response.ok) return { status: "waiting" };
      receivedAt = this.now();
      envelope = Envelope.parse(await response.json());
    } catch {
      return { status: "waiting" };
    }
    if (envelope.code !== 0 && envelope.code !== 200)
      return { status: "waiting" };
    try {
      const token = TokenData.parse(envelope.data);
      const accessToken = firstText(
        token.accessToken,
        token.access_token,
        token.AccessToken,
      );
      if (!accessToken) return { status: "waiting" };
      const expiresAt = expiry(token, receivedAt);
      const tokenDomain = firstText(token.domain, token.Domain);
      if (
        expiresAt <= this.now() ||
        (tokenDomain && !matchesRegion(tokenDomain, attempt.region))
      )
        throw unavailable();
      const response = await this.request(attempt.region, "/login/account", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(tokenDomain ? { "X-Domain": tokenDomain } : {}),
        },
      });
      if (!response.ok) throw unavailable();
      const profile = AccountData.parse(
        Envelope.parse(await response.json()).data,
      );
      const domain = tokenDomain ?? firstText(profile.domain, profile.Domain);
      const userId = firstText(
        profile.uid,
        profile.Uid,
        profile.userId,
        profile.UserID,
      );
      const name = firstText(
        profile.nickname,
        profile.NickName,
        profile.ScreenName,
      )?.slice(0, 160);
      const enterpriseId = firstText(
        profile.enterpriseId,
        profile.EnterpriseId,
      );
      if (!userId || !domain || !matchesRegion(domain, attempt.region))
        throw unavailable();
      if (this.attempt !== attempt || attempt.deadline <= this.now())
        throw unavailable();
      const credentials = {
        accessToken,
        expiresAt,
        userId,
        domain,
        ...(enterpriseId ? { enterpriseId } : {}),
      };
      let activeWeb = false;
      const commit = this.mutate(async (current) => {
        const source =
          current?.source ?? ((await this.local()) ? "local" : "web");
        if (
          this.attempt !== attempt ||
          Math.min(attempt.deadline, expiresAt) <= this.now()
        )
          throw unavailable();
        activeWeb = source === "web";
        return {
          source,
          web: {
            region: attempt.region,
            credentials,
            ...(name ? { name } : {}),
          },
        };
      });
      this.committing = commit;
      try {
        await commit;
      } finally {
        if (this.committing === commit) this.committing = undefined;
      }
      if (activeWeb) this.onChange?.();
      if (this.attempt !== attempt) return { status: "error" };
      return (attempt.result = {
        status: "success",
        region: attempt.region,
        ...(name ? { name } : {}),
      });
    } catch {
      return (attempt.result = { status: "error" });
    }
  }
}
