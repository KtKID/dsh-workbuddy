/** 复用插件详情页控件发起 WorkBuddy 授权并选择当前登录方式。 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { z } from "zod";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  LOGIN_POLL_INTERVAL_MS,
  LoginPollResponse,
  LoginStartResponse,
  LoginViewSchema,
  type LoginRegion,
  type LoginSource,
  type LoginView,
} from "../public-schema.js";

export const loginZh = {
  accounts: "WorkBuddy 账号",
  accountUsage: "积分、模型和对话使用标有「使用中」的账号",
  activeAccount: "使用中",
  localLogin: "本地账号",
  localAvailable: "沿用 WorkBuddy 客户端的登录或已导入的凭据",
  localUnavailable: "请在 WorkBuddy 客户端登录，或导入登录凭据",
  useLocal: "使用本地账号",
  webLogin: "网页登录",
  webUnavailable: "选择地区，前往 WorkBuddy 官方页面登录",
  webExpired: "网页登录已过期，请重新登录",
  loginChina: "中国区",
  loginGlobal: "国际区",
  openChina: "登录中国区",
  openGlobal: "登录国际区",
  useWeb: "使用网页账号",
  signOut: "退出网页登录",
  signedOut: "已退出插件内的网页登录",
  signOutFailed: "无法退出网页登录，请重试",
  reopenLogin: "重新打开登录页",
  waitingLogin: "请在 WorkBuddy 登录页完成登录",
  loginComplete: "WorkBuddy 网页登录成功",
  loginFailed: "无法完成 WorkBuddy 登录操作，请重试",
};
type LoginLabel = keyof typeof loginZh;

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};
const accountCard: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 12,
  minWidth: 0,
  borderRadius: "var(--dsw-radius-md)",
  border: "1px solid var(--dsw-alias-border-l2)",
};
const hint: CSSProperties = { color: "var(--dsw-alias-label-secondary)" };
const greenButton: CSSProperties & Record<`--${string}`, string> = {
  "--dsw-alias-button-primary-fill": "var(--dsw-alias-state-success-tertiary)",
  "--dsw-alias-button-primary-hover":
    "color-mix(in srgb, var(--dsw-alias-state-success-tertiary), var(--dsw-alias-state-success-primary) 18%)",
  "--dsw-alias-label-primary-foreground": "var(--dsw-alias-label-primary)",
};

async function request<T>(
  action: string,
  body: object,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/workbuddy/login/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error("WorkBuddy login operation failed");
  return schema.parse(await response.json());
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = window.setTimeout(done, LOGIN_POLL_INTERVAL_MS);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** 显示两条登录方式。界面请求仅消费服务端提供的脱敏状态。 */
export function LoginControls({
  login,
  refresh,
  label,
}: {
  login: LoginView | undefined;
  refresh: () => Promise<void>;
  label: (key: LoginLabel) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<LoginLabel>();
  const [url, setUrl] = useState<string>();
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);

  async function run(
    operation: (signal: AbortSignal) => Promise<void>,
    failure: LoginLabel = "loginFailed",
  ) {
    if (action.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    action.current = controller;
    setBusy(true);
    setMessage(undefined);
    try {
      await operation(signal);
    } catch {
      if (!signal.aborted) setMessage(failure);
    } finally {
      action.current = null;
      if (!signal.aborted) {
        setBusy(false);
        setUrl(undefined);
      }
    }
  }

  function signIn(region: LoginRegion) {
    if (action.current) return;
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    run(async (signal) => {
      let navigated = false;
      try {
        const start = await request(
          "start",
          { region },
          LoginStartResponse,
          signal,
        );
        const deadline = Date.now() + start.expiresInMs;
        setUrl(start.url);
        setMessage("waitingLogin");
        if (popup && !popup.closed) {
          popup.location.href = start.url;
          navigated = true;
        }
        while (Date.now() < deadline) {
          await waitForPoll(signal);
          signal.throwIfAborted();
          const result = await request(
            "poll",
            { loginId: start.loginId },
            LoginPollResponse,
            signal,
          );
          if (result.status === "waiting") continue;
          if (result.status === "error") break;
          setMessage("loginComplete");
          await refresh();
          return;
        }
        throw new Error("WorkBuddy login not completed");
      } finally {
        if (popup && !navigated) popup.close();
      }
    }).catch(() => undefined);
  }

  function select(source: LoginSource) {
    run(async (signal) => {
      await request("select", { source }, LoginViewSchema, signal);
      await refresh();
    }).catch(() => undefined);
  }

  function signOut() {
    run(async (signal) => {
      await request("sign-out", {}, LoginViewSchema, signal);
      await refresh();
      setMessage("signedOut");
    }, "signOutFailed").catch(() => undefined);
  }

  const localActive = login?.localAvailable && login.source === "local";
  const webActive = login?.webAvailable && login.source === "web";
  const webRegion = login?.webRegion;
  const activeBadge = (
    <span
      style={{
        background: "var(--dsw-alias-state-success-tertiary)",
        borderRadius: "var(--dsw-radius-sm)",
        padding: "2px 8px",
      }}
    >
      {label("activeAccount")}
    </span>
  );
  return (
    <div
      role="group"
      aria-label={label("accounts")}
      style={{ display: "grid", gap: 8 }}
    >
      <div style={hint}>{label("accountUsage")}</div>
      <div role="group" aria-label={label("localLogin")} style={accountCard}>
        <div style={row}>
          <span style={{ fontWeight: 500 }}>{label("localLogin")}</span>
          {localActive && activeBadge}
        </div>
        {login && (
          <div style={hint}>
            {label(
              login.localAvailable ? "localAvailable" : "localUnavailable",
            )}
          </div>
        )}
        {login?.localAvailable && !localActive && (
          <div style={row}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => select("local")}
            >
              {label("useLocal")}
            </Button>
          </div>
        )}
      </div>
      <div role="group" aria-label={label("webLogin")} style={accountCard}>
        <div style={row}>
          <span style={{ fontWeight: 500 }}>{label("webLogin")}</span>
          {webActive && activeBadge}
        </div>
        <div style={{ ...hint, overflowWrap: "anywhere" }}>
          {login?.webAvailable && webRegion
            ? [
                login.webName,
                label(webRegion === "cn" ? "loginChina" : "loginGlobal"),
              ]
                .filter(Boolean)
                .join(" · ")
            : label(webRegion ? "webExpired" : "webUnavailable")}
        </div>
        <div style={row}>
          {login?.webAvailable ? (
            !webActive && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => select("web")}
              >
                {label("useWeb")}
              </Button>
            )
          ) : (
            <>
              <Button
                variant="primary"
                style={greenButton}
                disabled={busy}
                onClick={() => signIn("cn")}
              >
                {label("openChina")}
              </Button>
              <Button
                variant="primary"
                style={greenButton}
                disabled={busy}
                onClick={() => signIn("global")}
              >
                {label("openGlobal")}
              </Button>
            </>
          )}
          {webRegion && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>
              {label("signOut")}
            </Button>
          )}
        </div>
        {message && (
          <div
            role={
              message === "loginFailed" || message === "signOutFailed"
                ? "alert"
                : "status"
            }
          >
            {label(message)}
          </div>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener">
            {label("reopenLogin")}
          </a>
        )}
      </div>
    </div>
  );
}
