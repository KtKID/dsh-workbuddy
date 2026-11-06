/** 展示当前余额、积分分类和可用模型；手动刷新保留旧结果及错误提示。 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { StatusSchema, type WorkBuddyStatus } from "../public-schema.js";
import { LoginControls } from "./LoginControls.js";
export function AccountCard(
  props: PropsRuntime<"plugins.bundle.config"> & PropsLocale<"workbuddy">,
) {
  return props.view === "summary" ? (
    <>{props.t("summary")}</>
  ) : (
    <AccountPage t={props.t} />
  );
}
function AccountPage({ t }: PropsLocale<"workbuddy">) {
  const [state, setState] = useState<WorkBuddyStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  async function refresh(force = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/workbuddy/status", {
        method: force ? "POST" : "GET",
        signal,
      });
      if (!response.ok) throw new Error("query failed");
      const value = StatusSchema.parse(await response.json());
      if (!signal.aborted) setState(value);
    } catch {
      if (!signal.aborted) setFailed(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    refresh().catch(() => undefined);
    return () => request.current?.abort();
  }, []);
  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        fontSize: 13,
      }}
    >
      <LoginControls login={state?.login} refresh={refresh} label={t} />
      <div>
        <span>{t("credits")}</span>
        <p style={{ fontSize: 24, fontWeight: 500, margin: "8px 0" }}>
          {state?.balance
            ? state.balance.total.toLocaleString(undefined, {
                maximumFractionDigits: 8,
              })
            : "—"}
        </p>
        <span>
          {state?.balance?.plan ?? (busy ? t("loading") : t("pending"))}
        </span>
      </div>
      {state?.balance?.groups.map((group) => (
        <div
          key={group.name}
          style={{ display: "flex", justifyContent: "space-between" }}
        >
          <span>{group.name}</span>
          <span>
            {group.remaining.toLocaleString(undefined, {
              maximumFractionDigits: 8,
            })}
          </span>
        </div>
      ))}
      <div>
        {t("models")}
        {state?.models.length ?? "—"}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            refresh(true).catch(() => undefined);
          }}
        >
          {busy ? t("refreshing") : t("refresh")}
        </Button>
        {state?.updatedAt && (
          <span>
            {t("updatedAt")} {new Date(state.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
      {(failed || state?.error) && (
        <p role="alert">
          {t("queryFailed")}
          {state?.error ? `（${state.error}）` : ""}
          {state?.balance ? t("previousResult") : ""}
        </p>
      )}
      <details>
        <summary>{t("modelList")}</summary>
        <ul>
          {state?.models.map((model) => (
            <li key={model.id}>
              {model.name} <code>{model.id}</code>
              {model.credits ? ` · ${model.credits}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
