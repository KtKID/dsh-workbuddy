/** 将官方 SDK 已校验的 ACP 通知投影为 KMH 流；原生工具和扩展信息留在协议元数据。 */
import type {
  SessionNotification,
  PromptResponse,
  ToolCall,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import {
  ToolCallId,
  type ContentBlock,
  type StreamChunk,
  type FinishReason,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { KmhTransfer } from "./mcp-bridge.js";

/** WB ACP 扩展的两种实际用量形状；外层通知与标准 Usage 由官方 SDK 校验。 */
const count = z.number().int().nonnegative();
const wbUsage = z.union([
  z
    .object({
      inputTokens: count,
      outputTokens: count,
      totalTokens: count.optional(),
      inputTokensDetails: z
        .object({ cached_tokens: count.optional() })
        .optional(),
      outputTokensDetails: z
        .object({ reasoning_tokens: count.optional() })
        .optional(),
    })
    .transform((u) => ({
      providerMessage: false,
      usage: projectUsage({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens ?? u.inputTokens + u.outputTokens,
        cachedReadTokens: u.inputTokensDetails?.cached_tokens ?? null,
        thoughtTokens: u.outputTokensDetails?.reasoning_tokens ?? null,
      }),
    })),
  z
    .object({
      prompt_tokens: count,
      completion_tokens: count,
      total_tokens: count.optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: count.optional() })
        .optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: count.optional() })
        .optional(),
      prompt_cache_hit_tokens: count.optional(),
      cache_read_input_tokens: count.optional(),
      cache_creation_input_tokens: count.optional(),
      prompt_cache_write_tokens: count.optional(),
      completion_thinking_tokens: count.optional(),
    })
    .transform((u) => ({
      providerMessage: true,
      usage: projectUsage({
        inputTokens: u.prompt_tokens,
        outputTokens: u.completion_tokens,
        totalTokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
        cachedReadTokens:
          reportedCount(
            u.cache_read_input_tokens,
            u.prompt_tokens_details?.cached_tokens,
            u.prompt_cache_hit_tokens,
          ) ?? null,
        cachedWriteTokens:
          reportedCount(
            u.cache_creation_input_tokens,
            u.prompt_cache_write_tokens,
          ) ?? null,
        thoughtTokens:
          reportedCount(
            u.completion_tokens_details?.reasoning_tokens,
            u.completion_thinking_tokens,
          ) ?? null,
      }),
    })),
]);
const wbMeta = z.object({
  "codebuddy.ai/modelRequestId": z.string().min(1).optional(),
  "codebuddy.ai/llmMessageId": z.string().min(1).optional(),
  "codebuddy.ai/messageId": z.string().min(1).optional(),
  usage: wbUsage.optional(),
});

/** 采用 WB 已报告的正数，保留显式零值；缺失计数保持未知。 */
function reportedCount(...values: (number | undefined)[]): number | undefined {
  return (
    values.find((v) => v !== undefined && v > 0) ??
    values.find((v) => v !== undefined)
  );
}

/** 将 ACP 的完整输入拆成 KMH 的未缓存输入与缓存分项；思考属于输出分项。 */
function projectUsage(u: Usage): TokenUsage {
  return {
    inputTokens: Math.max(
      0,
      u.inputTokens - (u.cachedReadTokens ?? 0) - (u.cachedWriteTokens ?? 0),
    ),
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    ...(u.cachedReadTokens == null
      ? {}
      : { cacheReadTokens: u.cachedReadTokens }),
    ...(u.cachedWriteTokens == null
      ? {}
      : { cacheWriteTokens: u.cachedWriteTokens }),
    ...(u.thoughtTokens == null ? {} : { reasoningTokens: u.thoughtTokens }),
  };
}

export class AcpOutput {
  readonly content: ContentBlock[] = [];
  readonly metadata: Record<string, unknown> = {};
  readonly tools = new Map<string, ToolCall | ToolCallUpdate>();
  private readonly usageByCall = new Map<string, TokenUsage>();
  private modelRequestId: string | undefined;
  private index = 0;
  private active:
    | {
        index: number;
        kind: "text" | "reasoning";
        text: string;
        messageId: string | null | undefined;
      }
    | undefined;
  /** 关闭一个已输出的文本块；块顺序与 ACP 通知顺序一致。 */
  close(): StreamChunk[] {
    const block = this.active;
    if (!block) return [];
    this.active = undefined;
    const value: ContentBlock =
      block.kind === "text"
        ? { type: "text", text: block.text }
        : { type: "reasoning", text: block.text };
    this.content.push(value);
    return [{ type: "block-end", index: block.index, block: value }];
  }
  /** 接收官方 SessionNotification；完整通知同时保存在传输记录。 */
  push({ update }: SessionNotification): StreamChunk[] {
    if (update._meta?.["codebuddy.ai/memberEvent"]) {
      this.metadata["memberEvent"] = update;
      return [];
    }
    const meta = wbMeta.safeParse(update._meta);
    if (meta.success) {
      const m = meta.data;
      this.modelRequestId =
        m["codebuddy.ai/modelRequestId"] ??
        m["codebuddy.ai/llmMessageId"] ??
        this.modelRequestId;
      if (update.sessionUpdate === "usage_update" && m.usage) {
        const id = m.usage.providerMessage
          ? (m["codebuddy.ai/messageId"] ?? this.modelRequestId)
          : (this.modelRequestId ?? m["codebuddy.ai/messageId"]);
        if (id) {
          this.usageByCall.set(id, {
            ...this.usageByCall.get(id),
            ...m.usage.usage,
          });
          this.metadata[update.sessionUpdate] = update;
          return [{ type: "usage", usage: this.totalUsage() }];
        }
      }
    }
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const previous = this.tools.get(update.toolCallId);
      const fields = Object.fromEntries(
        Object.entries(update).filter(([, value]) => value != null),
      );
      this.tools.set(update.toolCallId, {
        ...previous,
        ...fields,
        toolCallId: update.toolCallId,
      });
      this.metadata[`nativeTool:${update.toolCallId}`] = this.tools.get(
        update.toolCallId,
      );
      return this.close();
    }
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk"
    ) {
      this.metadata[update.sessionUpdate] = update;
      return [];
    }
    if (update.content.type !== "text") {
      this.metadata["assistantContent"] = update;
      return [];
    }
    const kind =
      update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning";
    const chunks: StreamChunk[] = [];
    if (
      this.active &&
      (this.active.kind !== kind || this.active.messageId !== update.messageId)
    )
      chunks.push(...this.close());
    if (!this.active) {
      this.active = {
        index: this.index++,
        kind,
        text: "",
        messageId: update.messageId,
      };
      chunks.push({
        type: "block-start",
        index: this.active.index,
        blockType: kind,
      });
    }
    this.active.text += update.content.text;
    chunks.push(
      kind === "text"
        ? {
            type: "text-delta",
            index: this.active.index,
            text: update.content.text,
          }
        : {
            type: "reasoning-delta",
            index: this.active.index,
            text: update.content.text,
          },
    );
    return chunks;
  }
  /** 返回当前 prompt 的用量快照；同一调用的重复或更新通知替换原值。 */
  private totalUsage(): TokenUsage {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (const usage of this.usageByCall.values())
      for (const key of [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "reasoningTokens",
      ] as const)
        if (usage[key] !== undefined)
          total[key] = (total[key] ?? 0) + usage[key];
    return total;
  }
  /** MCP SDK 确认的请求是宿主工具调用的唯一来源，ACP 工具通知只用于观察。 */
  transfer(call: KmhTransfer): StreamChunk[] {
    const chunks = this.close();
    const block = {
      type: "tool-call" as const,
      id: ToolCallId(call.id),
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    };
    const index = this.index++;
    this.content.push(block);
    chunks.push(
      { type: "block-start", index, blockType: "tool-call" },
      {
        type: "tool-call-delta",
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: block.arguments,
      },
      { type: "block-end", index, block },
    );
    return chunks;
  }
  /** 正式响应决定本轮结束；标准用量优先，WB 通知补齐扩展用量。 */
  finish(response: PromptResponse, transferred: boolean): StreamChunk[] {
    const chunks = this.close();
    let reason: FinishReason;
    switch (response.stopReason) {
      case "end_turn":
        reason = { kind: transferred ? "tool-calls" : "stop" };
        break;
      case "max_tokens":
        reason = { kind: "max-tokens" };
        break;
      case "max_turn_requests":
        reason = transferred
          ? { kind: "tool-calls" }
          : {
              kind: "error",
              failure: {
                code: "WORKBUDDY_MAX_TURNS",
                message: "WorkBuddy reached its configured turn budget",
              },
            };
        break;
      case "refusal":
        reason = { kind: "stop" };
        break;
      case "cancelled":
        reason = {
          kind: "aborted",
          failure: {
            code: "WORKBUDDY_ACP_CANCELLED",
            message: "WorkBuddy cancelled the turn",
          },
        };
        break;
    }
    if (response.usage)
      chunks.push({ type: "usage", usage: projectUsage(response.usage) });
    else if (this.usageByCall.size)
      chunks.push({ type: "usage", usage: this.totalUsage() });
    this.metadata["promptResponse"] = response;
    chunks.push({ type: "finish", reason });
    return chunks;
  }
}
