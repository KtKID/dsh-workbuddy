/** 读取官方账号余额和模型目录；按账号缓存并合并并发刷新。 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import { readDesktopCredentials } from "./credentials.js";
import { readWorkBuddyClientHeaders } from "./client-info.js";
import { ModelSchema, BalanceSchema, } from "./public-schema.js";
const Capacity = z
    .union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number()])
    .pipe(z.coerce.number().finite().nonnegative());
const CreditsResponse = z.object({
    code: z.literal(0),
    data: z.object({
        TotalCredits: Capacity,
        SubscriptionPackageName: z.string(),
        CreditGroups: z.array(z.object({ Name: z.string(), CycleRemainCapacity: Capacity })),
    }),
});
const CatalogResponse = z.object({
    code: z.literal(0),
    data: z.object({
        models: z.array(ModelSchema.extend({
            disabled: z.boolean().optional(),
            supportsToolCall: z.boolean().optional(),
            tags: z.array(z.string()).optional(),
        })),
        agents: z
            .array(z.object({ name: z.string(), models: z.array(z.string()).optional() }))
            .optional(),
    }),
});
const CACHE_MS = 300_000;
/** 一个插件实例持有一份按当前账号隔离的快照。 */
export class WorkBuddyApi {
    config;
    dependencies;
    key = "";
    generation = 0;
    expiresAt = 0;
    pending;
    value = {
        models: [],
        balance: null,
        updatedAt: null,
        error: null,
    };
    constructor(config, dependencies = {}) {
        this.config = config;
        this.dependencies = dependencies;
    }
    /** 账号变化时使当前快照与在途查询失效。 */
    invalidate() {
        this.generation++;
        this.reset("");
    }
    reset(key) {
        this.key = key;
        this.pending = undefined;
        this.expiresAt = 0;
        this.value = { models: [], balance: null, updatedAt: null, error: null };
    }
    /** 输入可选的同请求账号快照，返回积分及模型，失败保留同账号上次成功值。 */
    async status(force = false, selection) {
        const generation = this.generation;
        try {
            const account = selection !== undefined
                ? selection
                : this.dependencies.account
                    ? await this.dependencies.account()
                    : {
                        source: "local",
                        credentials: await (this.dependencies.credentials
                            ? this.dependencies.credentials()
                            : readDesktopCredentials(this.config)),
                    };
            if (!account || account.credentials.expiresAt <= Date.now())
                throw new Error("WORKBUDDY_AUTH_EXPIRED");
            const credentials = account.credentials;
            if (generation !== this.generation && selection === undefined)
                return this.status(force);
            const key = JSON.stringify([
                account.source,
                account.source === "web" ? account.region : "",
                credentials.userId,
                credentials.enterpriseId ?? "",
                credentials.domain ?? "",
            ]);
            if (key !== this.key)
                this.reset(key);
            if (this.pending)
                return this.pending;
            if (!force && Date.now() < this.expiresAt)
                return this.value;
            const pending = this.refresh(account)
                .then((value) => {
                if (this.pending === pending) {
                    this.value = value;
                    this.expiresAt = Date.now() + CACHE_MS;
                }
                return value;
            })
                .catch(() => {
                const current = this.pending === pending;
                const failed = {
                    ...(current
                        ? this.value
                        : { models: [], balance: null, updatedAt: null }),
                    error: "WORKBUDDY_ACCOUNT_QUERY_FAILED",
                };
                if (current) {
                    this.value = failed;
                    this.expiresAt = Date.now() + 30_000;
                }
                return failed;
            })
                .finally(() => {
                if (this.pending === pending)
                    this.pending = undefined;
            });
            this.pending = pending;
            return pending;
        }
        catch {
            if (generation === this.generation)
                this.reset("");
            return {
                models: [],
                balance: null,
                updatedAt: null,
                error: "WORKBUDDY_AUTH_UNAVAILABLE",
            };
        }
    }
    /** 返回可对话模型；无有效目录时传播固定错误。 */
    async models(account) {
        const state = await this.status(false, account);
        if (!state.models.length)
            throw new LlmError(state.error ?? "WORKBUDDY_MODELS_EMPTY", "WORKBUDDY_MODELS_UNAVAILABLE");
        return state.models.map((model) => ({
            provider: "workbuddy",
            id: model.id,
            name: model.credits?.trim()
                ? `${model.name} · ${model.credits.trim().replace(/^x/i, "×")}`
                : model.name,
            inputModalities: ["text"],
            ...(model.maxInputTokens ? { contextWindow: model.maxInputTokens } : {}),
        }));
    }
    /** 两项独立只读查询；只向固定官方来源发送凭据，统一校验响应。 */
    async refresh(account) {
        const { credentials } = account;
        const origin = account.source === "web" && account.region === "global"
            ? "https://www.workbuddy.ai"
            : "https://www.workbuddy.cn";
        const headers = {
            ...(await readWorkBuddyClientHeaders(this.config)),
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${credentials.accessToken}`,
            "X-User-Id": encodeURIComponent(credentials.userId),
            "X-Product": "SaaS",
            ...(credentials.domain ? { "X-Domain": credentials.domain } : {}),
            ...(credentials.enterpriseId
                ? {
                    "X-Enterprise-Id": credentials.enterpriseId,
                    "X-Tenant-Id": credentials.enterpriseId,
                }
                : {}),
        };
        const query = async (path, method) => {
            const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${origin}${path}`, {
                method,
                headers,
                redirect: "error",
                signal: AbortSignal.timeout(this.config.timeoutMs),
                ...(method === "POST" ? { body: "{}" } : {}),
            });
            if (!response.ok)
                throw new Error("WORKBUDDY_ACCOUNT_QUERY_FAILED");
            return response.json();
        };
        const [catalogRaw, balanceRaw] = await Promise.all([
            query("/v3/config", "GET"),
            query("/billing/meter/get-user-resource-summary", "POST"),
        ]);
        const catalog = CatalogResponse.parse(catalogRaw).data;
        const credits = CreditsResponse.parse(balanceRaw).data;
        const selectable = new Set(catalog.agents?.find((agent) => agent.name === "cli")?.models ?? []);
        const candidates = catalog.models
            .filter((model) => !model.disabled &&
            (model.supportsToolCall === true ||
                selectable.has(model.id) ||
                model.tags?.includes("craft")))
            .map((model) => ModelSchema.parse(model));
        const byName = new Map();
        for (const model of candidates) {
            const key = model.name.trim().toLocaleLowerCase("en-US");
            const previous = byName.get(key);
            if (!previous ||
                (!selectable.has(previous.id) && selectable.has(model.id)))
                byName.set(key, model);
        }
        const models = [...byName.values()];
        if (!models.length)
            throw new Error("WORKBUDDY_MODELS_EMPTY");
        return {
            models,
            balance: BalanceSchema.parse({
                total: credits.TotalCredits,
                plan: credits.SubscriptionPackageName,
                groups: credits.CreditGroups.map((group) => ({
                    name: group.Name,
                    remaining: group.CycleRemainCapacity,
                })),
            }),
            updatedAt: new Date().toISOString(),
            error: null,
        };
    }
}
