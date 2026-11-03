/** 将已校验官方事件转换成 DSH 有序流；正文、思考、工具、用量和结束状态共用此入口。 */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  LlmError,
  ToolCallId,
  type ContentBlock,
  type ToolCallBlock,
  type StreamChunk,
  type FinishReason,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import {
  CliEventSchema,
  ToolArgumentsSchema,
  type CliBlock,
  type CliUsage,
  type CliResult,
  type CliEvent,
} from "./native-schema.js";
import { nativeToolBlocks } from "./native-tools.js";
const BlockState = z.object({
  index: z.number(),
  kind: z.enum(["text", "reasoning", "tool-call", "redacted"]),
  text: z.string().default(""),
  sent: z.number().default(0),
  opened: z.boolean().default(false),
  id: z.string().optional(),
  name: z.string().optional(),
  signature: z.string().optional(),
});
type BlockState = z.infer<typeof BlockState>;
const fault = (detail: string) =>
  new LlmError(`WORKBUDDY_CLI_PROTOCOL: ${detail}`, "WORKBUDDY_CLI_PROTOCOL");
/** 输入原始事件，输出增量；不执行工具。finish 在进程退出后统一验证终止与退出状态。 */
export class NativeOutput {
  readonly content: ContentBlock[] = [];
  readonly calls: ToolCallBlock[] = [];
  readonly metadata: Record<string, unknown> = {};
  readonly requestIds = new Set<string>();
  responseId: string | undefined;
  credit: number | undefined;
  result: CliResult | undefined;
  messageStopped = false;
  private nextIndex = 0;
  private generation = "default";
  private active = new Map<string, BlockState>();
  private streamed = new Set<string>();
  private seen = new Set<string>();
  private matchedTransfers = new Set<string>();
  private usages = new Map<string, CliUsage>();
  private stopReason: string | null | undefined;
  constructor(
    readonly declared: ReadonlySet<string>,
    readonly resumed = false,
  ) {}
  private tool(
    name: string,
    id: string,
    args: string,
    state?: BlockState,
  ): StreamChunk[] {
    const resolved = this.declared.has(name)
      ? name
      : name.replace(/^mcp__kmh__/, "");
    if (!this.declared.has(resolved)) throw fault(`undeclared tool ${name}`);
    let argumentsValue: unknown;
    try {
      argumentsValue = ToolArgumentsSchema.parse(JSON.parse(args));
    } catch {
      throw fault("invalid tool arguments");
    }
    const serialized = JSON.stringify(argumentsValue);
    const previous = this.calls.find((c) => c.id === id);
    if (previous) {
      if (
        previous.name !== resolved ||
        !isDeepStrictEqual(JSON.parse(previous.arguments), argumentsValue)
      )
        throw fault("conflicting call ID");
      return [];
    }
    const block: ToolCallBlock = {
      type: "tool-call",
      id: ToolCallId(id),
      name: resolved,
      arguments: serialized,
    };
    this.calls.push(block);
    this.content.push(block);
    const index = state?.index ?? this.nextIndex++;
    const chunks: StreamChunk[] = state?.opened
      ? []
      : [{ type: "block-start", index, blockType: "tool-call" }];
    return [...chunks, { type: "block-end", index, block }];
  }
  /** MCP 回调仅核对/补齐调用，原生回调结果不作为宿主真实执行结果。 */
  transfer(
    name: string,
    args: Record<string, unknown>,
    id: string,
  ): StreamChunk[] {
    const normalized = name.replace(/^mcp__kmh__/, "");
    const match = this.calls.find(
      (c) =>
        !this.matchedTransfers.has(c.id) &&
        c.name === normalized &&
        isDeepStrictEqual(JSON.parse(c.arguments), args),
    );
    const chunks = match ? [] : this.tool(name, id, JSON.stringify(args));
    this.matchedTransfers.add(match?.id ?? id);
    return chunks;
  }
  private emitText(state: BlockState, final = false): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    let end = state.text.length;
    if (state.kind === "text") {
      // 屏蔽完整或尚未结束的代码引用，仅缓冲可能成为 DSML 的后缀。
      const visible = state.text.replace(
        /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1|$)|`[^`\n]*(?:`|$)/g,
        (q) => " ".repeat(q.length),
      );
      const marker = "<｜｜DSML｜｜";
      const special = visible.indexOf(marker);
      if (special >= 0) end = special;
      else
        for (
          let size = Math.min(marker.length - 1, visible.length);
          size > 0;
          size--
        ) {
          if (visible.endsWith(marker.slice(0, size))) {
            end -= size;
            break;
          }
        }
      if (final) {
        const parsed = nativeToolBlocks(state.text, this.declared);
        if (!parsed.text.startsWith(state.text.slice(0, state.sent)))
          throw fault("text prefix changed");
        state.text = parsed.text;
        end = state.text.length;
        this.metadata.pendingDsml = parsed.calls;
      }
    }
    if (!final && state.kind === "text")
      end = state.text.slice(0, end).trimEnd().length;
    if (end > state.sent) {
      if (!state.opened) {
        chunks.push({
          type: "block-start",
          index: state.index,
          blockType: state.kind === "reasoning" ? "reasoning" : "text",
        });
        state.opened = true;
      }
      const text = state.text.slice(state.sent, end);
      state.sent = end;
      chunks.push(
        state.kind === "reasoning"
          ? { type: "reasoning-delta", index: state.index, text }
          : { type: "text-delta", index: state.index, text },
      );
    }
    return chunks;
  }
  private close(state: BlockState): StreamChunk[] {
    if (state.kind === "tool-call")
      return this.tool(
        state.name ?? "",
        state.id ?? "",
        state.text || "{}",
        state,
      );
    if (state.kind === "redacted") {
      this.metadata.redactedThinking = true;
      return [];
    }
    const chunks = this.emitText(state, true);
    if (state.opened) {
      const block: ContentBlock =
        state.kind === "reasoning"
          ? { type: "reasoning", text: state.text }
          : { type: "text", text: state.text };
      this.content.push(block);
      chunks.push({ type: "block-end", index: state.index, block });
    }
    if (state.signature)
      this.metadata[`signature:${state.index}`] = state.signature;
    if (state.kind === "text") {
      const parsed = z
        .array(
          z.object({ id: z.string(), name: z.string(), arguments: z.string() }),
        )
        .parse(this.metadata.pendingDsml ?? []);
      delete this.metadata.pendingDsml;
      for (const call of parsed)
        chunks.push(...this.tool(call.name, call.id, call.arguments));
    }
    return chunks;
  }
  private block(block: CliBlock, partialIndex?: number): StreamChunk[] {
    if (block.type === "tool_result") {
      if (!this.calls.some((c) => c.id === block.tool_use_id))
        throw fault("orphan native tool result");
      this.metadata[`nativeToolResult:${block.tool_use_id}`] = block;
      return [];
    }
    const kind =
      block.type === "thinking"
        ? "reasoning"
        : block.type === "tool_use"
          ? "tool-call"
          : block.type === "redacted_thinking"
            ? "redacted"
            : "text";
    const snapshotKey = `${this.generation}:${kind}`;
    if (
      partialIndex === undefined &&
      kind !== "tool-call" &&
      this.streamed.has(snapshotKey)
    ) {
      if (block.type === "thinking" && block.signature)
        this.metadata[`signature:${this.generation}`] = block.signature;
      return [];
    }
    const state = BlockState.parse({
      index: this.nextIndex++,
      kind,
      text:
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : block.type === "refusal"
              ? block.refusal
              : block.type === "tool_use" && Object.keys(block.input).length
                ? JSON.stringify(block.input)
                : "",
      ...(block.type === "tool_use" ? { id: block.id, name: block.name } : {}),
      ...(block.type === "thinking" && block.signature
        ? { signature: block.signature }
        : {}),
    });
    if (partialIndex !== undefined) {
      const key = `${this.generation}:${partialIndex}`;
      if (this.active.has(key)) throw fault("duplicate block start");
      this.active.set(key, state);
      this.streamed.add(snapshotKey);
      if (kind === "tool-call") {
        if (!state.id) throw fault("missing tool ID");
        const name = state.name?.replace(/^mcp__kmh__/, "") ?? "";
        if (!this.declared.has(name)) throw fault(`undeclared tool ${name}`);
        state.opened = true;
        return [
          { type: "block-start", index: state.index, blockType: "tool-call" },
          {
            type: "tool-call-delta",
            index: state.index,
            id: ToolCallId(state.id),
            name,
            argumentsDelta: state.text,
          },
        ];
      }
      return kind === "text" || kind === "reasoning"
        ? this.emitText(state)
        : [];
    }
    return this.close(state);
  }
  private usage(value: CliUsage | undefined) {
    if (!value) return;
    // 某些 CLI message_stop 会发全零占位统计，保留此前的权威计数。
    if (
      (value.input_tokens ?? 0) + (value.output_tokens ?? 0) === 0 &&
      this.usages.has(this.generation)
    )
      return;
    this.usages.set(this.generation, {
      ...this.usages.get(this.generation),
      ...value,
    });
  }
  push(raw: unknown): StreamChunk[] {
    const parsed = CliEventSchema.safeParse(raw);
    if (!parsed.success)
      throw fault(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 500),
      );
    const e = parsed.data;
    if ("isReplay" in e && e.isReplay) return [];
    if ("parent_tool_use_id" in e && e.parent_tool_use_id)
      throw fault("unexpected native subagent output");
    if ("uuid" in e && typeof e.uuid === "string") {
      if (this.seen.has(e.uuid)) return [];
      this.seen.add(e.uuid);
    }
    if ("_requestId" in e && typeof e._requestId === "string")
      this.requestIds.add(e._requestId);
    if ("_messageId" in e && typeof e._messageId === "string")
      this.generation = e._messageId;
    if ("_meta" in e && e._meta) this.metadata[this.generation] = e._meta;
    if (
      (e.type === "message" ||
        e.type === "reasoning" ||
        e.type === "function_call" ||
        e.type === "function_call_result") &&
      e.providerData
    ) {
      const provider = e.providerData;
      if (provider.conversationRequestId)
        this.requestIds.add(provider.conversationRequestId);
      this.metadata[`provider:${e.id ?? this.generation}`] = provider;
    }
    switch (e.type) {
      case "stream_event": {
        const v = e.event;
        switch (v.type) {
          case "message_start":
            this.generation = v.message.id ?? this.generation;
            this.responseId = this.generation;
            this.messageStopped = false;
            this.usage(v.message.usage);
            return [];
          case "content_block_start":
            return this.block(v.content_block, v.index);
          case "content_block_delta": {
            const s = this.active.get(`${this.generation}:${v.index}`);
            if (!s) throw fault("delta without block start");
            switch (v.delta.type) {
              case "text_delta":
                if (s.kind !== "text") throw fault("text delta type mismatch");
                s.text += v.delta.text;
                return this.emitText(s);
              case "thinking_delta":
                if (s.kind !== "reasoning")
                  throw fault("thinking delta type mismatch");
                s.text += v.delta.thinking;
                return this.emitText(s);
              case "signature_delta":
                if (s.kind !== "reasoning")
                  throw fault("signature type mismatch");
                s.signature = (s.signature ?? "") + v.delta.signature;
                return [];
              case "input_json_delta":
                if (s.kind !== "tool-call" || !s.id)
                  throw fault("tool delta type mismatch");
                s.text += v.delta.partial_json;
                return [
                  {
                    type: "tool-call-delta",
                    index: s.index,
                    id: ToolCallId(s.id),
                    argumentsDelta: v.delta.partial_json,
                  },
                ];
            }
            throw fault("unsupported delta");
          }
          case "content_block_stop": {
            const key = `${this.generation}:${v.index}`;
            const s = this.active.get(key);
            if (!s) throw fault("stop without block");
            this.active.delete(key);
            return this.close(s);
          }
          case "message_delta":
            this.stopReason = v.delta.stop_reason ?? this.stopReason;
            this.usage(v.usage);
            return [];
          case "message_stop": {
            this.messageStopped = true;
            // 官方转换器在仅思考后直接转工具时省略 thinking 的 block_stop。
            const chunks: StreamChunk[] = [];
            for (const [key, state] of this.active) {
              if (
                key.startsWith(`${this.generation}:`) &&
                state.kind === "reasoning"
              ) {
                chunks.push(...this.close(state));
                this.active.delete(key);
              }
            }
            return chunks;
          }
        }
        throw fault("unsupported stream event");
      }
      case "assistant": {
        this.generation = e._messageId ?? e.message.id ?? this.generation;
        this.responseId = e.uuid ?? e.message.id ?? this.responseId;
        this.usage(e.message.usage);
        this.stopReason = e.message.stop_reason ?? this.stopReason;
        const blocks =
          typeof e.message.content === "string"
            ? [{ type: "text" as const, text: e.message.content }]
            : e.message.content;
        return blocks.flatMap((b) => this.block(b));
      }
      case "user":
        return typeof e.message.content === "string"
          ? []
          : e.message.content.flatMap((b) =>
              b.type === "tool_result" ? this.block(b) : [],
            );
      case "result":
        if (this.result) throw fault("duplicate result");
        this.result = e;
        this.metadata.terminal = e;
        return [];
      case "system":
        if (e.prevent_continuation)
          throw new LlmError(
            e.content ?? "WORKBUDDY_PERMISSION_DENIED",
            "WORKBUDDY_PERMISSION_DENIED",
          );
        return [];
      case "file-history-snapshot":
      case "ai-title":
      case "topic":
        return [];
      case "message": {
        if (e.role !== "assistant") return [];
        this.responseId = e.id ?? this.responseId;
        this.generation = e.providerData?.messageId ?? e.id ?? this.generation;
        this.rawUsage(e);
        if (e.status === "incomplete") this.metadata.incomplete = true;
        return e.content.flatMap((b) =>
          this.block(
            b.type === "refusal"
              ? { type: "refusal", refusal: b.refusal }
              : { type: "text", text: b.text },
          ),
        );
      }
      case "reasoning":
        return (e.rawContent ?? e.content).flatMap((b) =>
          b.type !== "refusal"
            ? this.block({
                type: "thinking",
                thinking: b.text,
                ...(e.providerData?.signature
                  ? { signature: e.providerData.signature }
                  : {}),
              })
            : [],
        );
      case "function_call":
        return this.tool(e.name, e.callId, e.arguments);
      case "function_call_result":
        if (!this.calls.some((c) => c.id === e.callId))
          throw fault("orphan native tool result");
        this.metadata[`nativeToolResult:${e.callId}`] = e.output;
        return [];
    }
  }
  private rawUsage(e: Extract<CliEvent, { type: "message" }>) {
    const u = e.providerData?.usage,
      r = e.providerData?.rawUsage;
    if (u || r)
      this.usage({
        input_tokens: r?.prompt_tokens ?? u?.inputTokens,
        output_tokens: r?.completion_tokens ?? u?.outputTokens,
        cache_read_input_tokens:
          r?.prompt_cache_hit_tokens ??
          r?.prompt_tokens_details?.cached_tokens ??
          r?.cache_read_input_tokens ??
          u?.inputTokensDetails?.reduce(
            (s, x) => s + (x.cached_tokens ?? 0),
            0,
          ),
        cache_creation_input_tokens: r?.cache_creation_input_tokens,
        total_tokens: r?.total_tokens ?? u?.totalTokens,
        reasoning_tokens:
          r?.completion_tokens_details?.reasoning_tokens ??
          r?.completion_thinking_tokens ??
          u?.outputTokensDetails?.reduce(
            (s, x) => s + (x.reasoning_tokens ?? 0),
            0,
          ),
        credit: r?.credit,
      });
  }
  finish(exitCode: number | null): StreamChunk[] {
    if (exitCode !== 0)
      throw new LlmError(
        "WORKBUDDY_CLI_PROCESS_FAILED",
        "WORKBUDDY_CLI_PROCESS_FAILED",
      );
    const result = this.result;
    if (!result) throw fault("missing terminal result");
    let reason: FinishReason = {
      kind: this.calls.length ? "tool-calls" : "stop",
    };
    const failure = (code: string, message = code) => ({ code, message });
    if (result?.terminal_reason?.startsWith("aborted"))
      reason = { kind: "aborted", failure: failure("WORKBUDDY_CLI_ABORTED") };
    else if (result?.permission_denials?.length)
      reason = {
        kind: "error",
        failure: failure("WORKBUDDY_PERMISSION_DENIED"),
      };
    else if (
      result?.is_error &&
      !(this.calls.length && result.subtype === "error_max_turns")
    )
      reason = {
        kind: "error",
        failure: failure(
          "WORKBUDDY_CLI_FAILED",
          result.errors?.join("\n") ?? result.result ?? "WORKBUDDY_CLI_FAILED",
        ),
      };
    else if (
      result?.terminal_reason === "max_tokens" ||
      ["max_tokens", "length"].includes(this.stopReason ?? "")
    )
      reason = { kind: "max-tokens" };
    else if (this.metadata.incomplete)
      reason = { kind: "error", failure: failure("WORKBUDDY_CLI_INCOMPLETE") };
    if (
      this.active.size &&
      (reason.kind === "stop" || reason.kind === "tool-calls")
    )
      throw fault("truncated content block");
    const chunks: StreamChunk[] = [];
    const values = [...this.usages.values()];
    if (!values.length && !this.resumed && result?.usage)
      values.push(result.usage);
    if (values.length) {
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let total = 0,
        totalKnown = true;
      for (const u of values) {
        const input = u.input_tokens ?? 0,
          output = u.output_tokens ?? 0,
          read = u.cache_read_input_tokens ?? 0,
          write = u.cache_creation_input_tokens ?? 0;
        if (read + write > input) throw fault("cache counts exceed input");
        usage.inputTokens += input - read - write;
        usage.outputTokens += output;
        if (read) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + read;
        if (write)
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + write;
        if (u.reasoning_tokens != null)
          usage.reasoningTokens =
            (usage.reasoningTokens ?? 0) + u.reasoning_tokens;
        if (u.total_tokens != null && u.total_tokens !== input + output)
          throw fault("inconsistent total tokens");
        if (u.input_tokens == null || u.output_tokens == null)
          totalKnown = false;
        else total += input + output;
        if (u.credit != null) this.credit = (this.credit ?? 0) + u.credit;
      }
      if (totalKnown) usage.totalTokens = total;
      chunks.push({ type: "usage", usage });
    }
    chunks.push({ type: "finish", reason });
    return chunks;
  }
}
