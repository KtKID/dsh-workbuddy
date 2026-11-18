import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 展示当前余额、积分分类和可用模型；手动刷新保留旧结果及错误提示。 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { StatusSchema } from "../public-schema.js";
import { LoginControls } from "./LoginControls.js";
export function AccountCard(props) {
    return props.view === "summary" ? (_jsx(_Fragment, { children: props.t("summary") })) : (_jsx(AccountPage, { t: props.t }));
}
function AccountPage({ t }) {
    const [state, setState] = useState();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const request = useRef(null);
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
            if (!response.ok)
                throw new Error("query failed");
            const value = StatusSchema.parse(await response.json());
            if (!signal.aborted)
                setState(value);
        }
        catch {
            if (!signal.aborted)
                setFailed(true);
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    useEffect(() => {
        refresh().catch(() => undefined);
        return () => request.current?.abort();
    }, []);
    return (_jsxs("div", { style: {
            display: "grid",
            gap: 16,
            fontSize: 13,
        }, children: [_jsx(LoginControls, { login: state?.login, refresh: refresh, label: t }), _jsxs("div", { children: [_jsx("span", { children: t("credits") }), _jsx("p", { style: { fontSize: 24, fontWeight: 500, margin: "8px 0" }, children: state?.balance
                            ? state.balance.total.toLocaleString(undefined, {
                                maximumFractionDigits: 8,
                            })
                            : "—" }), _jsx("span", { children: state?.balance?.plan ?? (busy ? t("loading") : t("pending")) })] }), state?.balance?.groups.map((group) => (_jsxs("div", { style: { display: "flex", justifyContent: "space-between" }, children: [_jsx("span", { children: group.name }), _jsx("span", { children: group.remaining.toLocaleString(undefined, {
                            maximumFractionDigits: 8,
                        }) })] }, group.name))), _jsxs("div", { children: [t("models"), state?.models.length ?? "—"] }), _jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [_jsx(Button, { variant: "outline", disabled: busy, onClick: () => {
                            refresh(true).catch(() => undefined);
                        }, children: busy ? t("refreshing") : t("refresh") }), state?.updatedAt && (_jsxs("span", { children: [t("updatedAt"), " ", new Date(state.updatedAt).toLocaleString()] }))] }), (failed || state?.error) && (_jsxs("p", { role: "alert", children: [t("queryFailed"), state?.error ? `（${state.error}）` : "", state?.balance ? t("previousResult") : ""] })), _jsxs("details", { children: [_jsx("summary", { children: t("modelList") }), _jsx("ul", { children: state?.models.map((model) => (_jsxs("li", { children: [model.name, " ", _jsx("code", { children: model.id }), model.credits ? ` · ${model.credits}` : ""] }, model.id))) })] })] }));
}
