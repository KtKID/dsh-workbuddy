/** 将 KMH 的单轮文本模型调用接到 WorkBuddy 远程推理。 */
import { nativeCompletion } from "./native.js";
import { randomUUID } from "node:crypto";
import {
  LlmAdapter,
  projectToolUpdates,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import type { WorkBuddyTrace } from "./public-schema.js";
import { readWorkBuddyClientHeaders } from "./client-info.js";
import { readDesktopCredentials } from "./credentials.js";
import { parseResponse } from "./protocol.js";
import { ENDPOINT, type Credentials, type WorkBuddyConfig } from "./schema.js";

export interface TransportDependencies {
  credentials?: () => Promise<Credentials>;
  fetch?: typeof globalThis.fetch;
  onCredit?: (credit: number) => void;
  models?: () => Promise<readonly LlmModelInfo[]>;
  onTrace?: (sessionId: string | undefined, trace: WorkBuddyTrace) => void;
}

/** 持有一次实例的配置；每轮读取当前登录凭据并执行一次请求。 */
export class WorkBuddyAdapter extends LlmAdapter {
  constructor(
    readonly config: WorkBuddyConfig,
    readonly dependencies: TransportDependencies = {},
  ) {
    super();
  }

  /** 读取远端对话模型目录；独立夹具可使用配置中的单模型。 */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.dependencies.models) return this.dependencies.models();
    return Promise.resolve([
      {
        provider,
        id: this.config.model,
        name: this.config.model,
        inputModalities: ["text"],
      },
    ]);
  }

  /** 校验当前 provider/model，返回文本模型能力；路由失配抛出 LlmError。 */
  override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== "workbuddy")
      throw new LlmError("WORKBUDDY_INVALID_MODEL", "WORKBUDDY_INVALID_MODEL");
    const entry = (await this.listModels(provider)).find(
      (entry) => entry.id === model,
    );
    if (!entry)
      throw new LlmError("WORKBUDDY_INVALID_MODEL", "WORKBUDDY_INVALID_MODEL");
    return { ...entry, defaultMaxTokens: this.config.maxTokens };
  }

  /** 输入完整文本请求，返回模型流；协议或范围错误向 LLM 服务传播。 */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    await this.resolveModel(options.provider, options.model);
    if (this.config.transport === "cli") {
      const credentials = this.dependencies.credentials
        ? await this.dependencies.credentials()
        : await readDesktopCredentials(this.config);
      yield* nativeCompletion(options, this.config, credentials, (trace) => {
        this.dependencies.onTrace?.(options.sessionId, trace);
        if (trace.credit !== undefined)
          this.dependencies.onCredit?.(trace.credit);
      });
      return;
    }
    const projected = projectToolUpdates(
      options.messages,
      options.tools,
      undefined,
      options.toolHistory,
    );
    const messages = projected.messages.map((message) => {
      if (
        message.content.some(
          (block) => !["text", "reasoning", "tool-call"].includes(block.type),
        )
      )
        throw new LlmError(
          "WORKBUDDY_MVP_TEXT_ONLY",
          "WORKBUDDY_MVP_TEXT_ONLY",
        );
      const calls = message.content.flatMap((block) =>
        block.type === "tool-call"
          ? [
              {
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: block.arguments },
              },
            ]
          : [],
      );
      return {
        role: message.role,
        content: message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
        ...(message.role === "tool"
          ? { tool_call_id: message.toolCallId }
          : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      };
    });
    if (options.system)
      messages.unshift({ role: "system", content: options.system });
    const clientHeaders = await readWorkBuddyClientHeaders(this.config);
    const credentials = this.dependencies.credentials
      ? await this.dependencies.credentials()
      : await readDesktopCredentials(this.config);
    if (credentials.expiresAt <= Date.now())
      throw new LlmError("WORKBUDDY_AUTH_EXPIRED", "WORKBUDDY_AUTH_EXPIRED");
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(this.config.timeoutMs),
        ])
      : AbortSignal.timeout(this.config.timeoutMs);
    signal.throwIfAborted();
    const requestId = randomUUID();
    const conversationId = options.sessionId ?? randomUUID();
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      ...(projected.tools?.length
        ? {
            tools: projected.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: options.reasoningEffort }),
    });
    const trace = (
      data: Omit<WorkBuddyTrace, "requestId" | "conversationId" | "model">,
    ): void => {
      this.dependencies.onTrace?.(options.sessionId, {
        requestId,
        conversationId,
        model: options.model,
        ...data,
      });
    };
    trace({ phase: "request", body });
    let responseId: string | undefined;
    let credit: number | undefined;
    try {
      const response = await (this.dependencies.fetch ?? globalThis.fetch)(
        ENDPOINT,
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            ...clientHeaders,
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${credentials.accessToken}`,
            "X-User-Id": encodeURIComponent(credentials.userId),
            ...(credentials.domain ? { "X-Domain": credentials.domain } : {}),
            ...(credentials.enterpriseId
              ? {
                  "X-Enterprise-Id": credentials.enterpriseId,
                  "X-Tenant-Id": credentials.enterpriseId,
                }
              : {}),
            "X-Product": "SaaS",
            "X-Conversation-ID": conversationId,
            "X-Conversation-Request-ID": requestId,
            "X-Conversation-Message-ID": requestId,
            "X-Request-ID": requestId,
            "X-Agent-Intent": "craft",
          },
          body,
        },
      );
      trace({ phase: "response", httpStatus: response.status });
      for await (const chunk of parseResponse(
        response,
        signal,
        (value) => {
          credit = value;
          this.dependencies.onCredit?.(value);
        },
        [credentials.accessToken, credentials.userId],
        (raw) => {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            value = {};
          }
          const parsed = z
            .object({ id: z.string().optional() })
            .safeParse(value);
          if (parsed.success && parsed.data.id) responseId = parsed.data.id;
          trace({ phase: "event", raw, ...(responseId ? { responseId } : {}) });
        },
      )) {
        if (chunk.type === "finish") {
          const metadata = {
            requestId,
            conversationId,
            ...(responseId ? { responseId } : {}),
            ...(credit === undefined ? {} : { credit }),
          };
          trace({ phase: "complete", ...metadata });
          yield { ...chunk, replayState: { response: metadata } };
        } else yield chunk;
      }
    } catch (error) {
      trace({
        phase: "error",
        error:
          error instanceof LlmError ? error.code : "WORKBUDDY_REQUEST_FAILED",
        ...(responseId ? { responseId } : {}),
      });
      throw error;
    }
  }
}
