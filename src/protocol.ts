/** 解析单次 WorkBuddy SSE 并映射 KMH 文本流，结束前汇总用量与 credit。 */
import {
  LlmError,
  ToolCallId,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { z } from "zod";
import type { UsageSchema } from "./schema.js";
import { ErrorResponseSchema, EventSchema } from "./schema.js";

/** 输入可读响应体和取消信号，逐个返回 SSE data；失败释放读取锁并终止流。 */
async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const abort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "" && data.length > 0) {
          yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) {
        if (buffer.trim() || data.length)
          throw new LlmError(
            "WORKBUDDY_PROTOCOL：SSE 事件被截断",
            "WORKBUDDY_PROTOCOL",
          );
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 将含缓存的 prompt 总数拆为 KMH 互斥计数，非法缓存数量作为协议错误。 */
function tokenUsage(raw: z.infer<typeof UsageSchema>): TokenUsage {
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0;
  if (cached > raw.prompt_tokens)
    throw new LlmError(
      "WORKBUDDY_PROTOCOL：缓存 token 超出输入总量",
      "WORKBUDDY_PROTOCOL",
    );
  return {
    inputTokens: raw.prompt_tokens - cached,
    outputTokens: raw.completion_tokens,
    ...(raw.total_tokens === undefined
      ? {}
      : { totalTokens: raw.total_tokens }),
    ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(raw.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: raw.completion_tokens_details.reasoning_tokens }),
  };
}

/** 输入一次响应、取消信号与 credit 观察器，返回 KMH 流；格式/远端错误按安全码抛出。 */
export async function* parseResponse(
  response: Response,
  signal: AbortSignal,
  onCredit?: (credit: number) => void,
  secrets: readonly string[] = [],
  onEvent?: (data: string) => void,
): AsyncIterable<StreamChunk> {
  if (!response.ok) {
    let code = `WORKBUDDY_HTTP_${response.status}`;
    let detail = "";
    try {
      let raw = await response.text();
      for (const secret of secrets)
        if (secret) raw = raw.replaceAll(secret, "[redacted]");
      onEvent?.(raw);
      const body = ErrorResponseSchema.parse(JSON.parse(raw));
      if (body.code === 11128 || body.code === "11128")
        code = "WORKBUDDY_CHANNEL_REJECTED";
      detail =
        body.displayTips?.zh ??
        body.message ??
        body.msg ??
        (typeof body.error === "string" ? body.error : body.error?.message) ??
        "";
      for (const secret of secrets)
        if (secret) detail = detail.replaceAll(secret, "[redacted]");
      detail = detail.replace(/[\r\n]/g, " ").slice(0, 300);
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    throw new LlmError(detail ? `${code}: ${detail}` : code, code, {
      status: response.status,
    });
  }
  if (!response.body)
    throw new LlmError("WORKBUDDY_PROTOCOL：响应体为空", "WORKBUDDY_PROTOCOL");
  const blocks = new Map<
    "text" | "reasoning",
    { index: number; text: string }
  >();
  let nextIndex = 0;
  const calls = new Map<
    number,
    {
      index: number;
      id: ReturnType<typeof ToolCallId>;
      name: string;
      arguments: string;
    }
  >();
  let finish: "stop" | "max-tokens" | "tool-calls" | undefined;
  let usage: TokenUsage | undefined;
  let credit: number | undefined;
  for await (const data of events(response.body, signal)) {
    let safe = data;
    for (const secret of secrets)
      if (secret) safe = safe.replaceAll(secret, "[redacted]");
    onEvent?.(safe);
    if (data === "[DONE]") break;
    let raw: z.infer<typeof EventSchema>;
    try {
      raw = EventSchema.parse(JSON.parse(data));
    } catch {
      throw new LlmError(
        "WORKBUDDY_PROTOCOL：模型流格式错误",
        "WORKBUDDY_PROTOCOL",
      );
    }
    if (
      raw.error !== undefined ||
      (raw.choices === undefined && raw.usage === undefined)
    )
      throw new LlmError(
        "WORKBUDDY_PROTOCOL：远端返回错误事件",
        "WORKBUDDY_PROTOCOL",
      );
    if (raw.usage) {
      usage = tokenUsage(raw.usage);
      credit = raw.usage.credit ?? credit;
    }
    for (const choice of raw.choices ?? []) {
      for (const delta of choice.delta.tool_calls ?? []) {
        let call = calls.get(delta.index);
        if (!call) {
          if (!delta.id)
            throw new LlmError(
              "WORKBUDDY_PROTOCOL：工具调用缺少 ID",
              "WORKBUDDY_PROTOCOL",
            );
          call = {
            index: nextIndex++,
            id: ToolCallId(delta.id),
            name: "",
            arguments: "",
          };
          calls.set(delta.index, call);
          yield {
            type: "block-start",
            index: call.index,
            blockType: "tool-call",
          };
        }
        if (delta.id && delta.id !== call.id)
          throw new LlmError(
            "WORKBUDDY_PROTOCOL：工具调用 ID 变化",
            "WORKBUDDY_PROTOCOL",
          );
        call.name += delta.function?.name ?? "";
        call.arguments += delta.function?.arguments ?? "";
        yield {
          type: "tool-call-delta",
          index: call.index,
          id: call.id,
          ...(delta.function?.name ? { name: delta.function.name } : {}),
          argumentsDelta: delta.function?.arguments ?? "",
        };
      }
      for (const [type, delta] of [
        ["reasoning", choice.delta.reasoning_content ?? choice.delta.reasoning],
        ["text", choice.delta.content],
      ] satisfies ["text" | "reasoning", string | null | undefined][]) {
        if (!delta) continue;
        let block = blocks.get(type);
        if (!block) {
          block = { index: nextIndex++, text: "" };
          blocks.set(type, block);
          yield { type: "block-start", index: block.index, blockType: type };
        }
        block.text += delta;
        yield type === "text"
          ? { type: "text-delta", index: block.index, text: delta }
          : { type: "reasoning-delta", index: block.index, text: delta };
      }
      // WorkBuddy 中间分片使用空字符串表示继续生成。
      if (choice.finish_reason != null && choice.finish_reason !== "") {
        if (
          choice.finish_reason !== "stop" &&
          choice.finish_reason !== "length" &&
          choice.finish_reason !== "tool_calls"
        )
          throw new LlmError(
            "WORKBUDDY_PROTOCOL：结束原因超出 MVP 范围",
            "WORKBUDDY_PROTOCOL",
          );
        finish =
          choice.finish_reason === "length"
            ? "max-tokens"
            : choice.finish_reason === "tool_calls"
              ? "tool-calls"
              : "stop";
      }
    }
  }
  signal.throwIfAborted();
  if (!finish)
    throw new LlmError(
      "WORKBUDDY_PROTOCOL：模型流缺少结束事件",
      "WORKBUDDY_PROTOCOL",
    );
  for (const [type, block] of blocks)
    yield {
      type: "block-end",
      index: block.index,
      block: { type, text: block.text },
    };
  if (finish === "tool-calls" && !calls.size)
    throw new LlmError(
      "WORKBUDDY_PROTOCOL：工具结束缺少调用",
      "WORKBUDDY_PROTOCOL",
    );
  for (const call of calls.values()) {
    if (!call.name)
      throw new LlmError(
        "WORKBUDDY_PROTOCOL：工具调用缺少名称",
        "WORKBUDDY_PROTOCOL",
      );
    yield {
      type: "block-end",
      index: call.index,
      block: {
        type: "tool-call",
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    };
  }
  if (usage) yield { type: "usage", usage };
  if (credit !== undefined) onCredit?.(credit);
  yield { type: "finish", reason: { kind: finish } };
}
