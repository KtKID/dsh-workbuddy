/** 官方 CLI stream-json 与历史记录的唯一协议定义；未知事件拒绝，已知事件的扩展元数据保留。 */
import { z } from "zod";
const count = z.number().finite().nonnegative();
const nullableCount = count.nullable().optional();
const jsonObject = z.record(z.string(), z.unknown());
export const CliUsageSchema = z.looseObject({
  input_tokens: nullableCount,
  output_tokens: nullableCount,
  cache_read_input_tokens: nullableCount,
  cache_creation_input_tokens: nullableCount,
  total_tokens: nullableCount,
  reasoning_tokens: nullableCount,
  credit: nullableCount,
});
const ProviderUsage = z.looseObject({
  inputTokens: count,
  outputTokens: count,
  totalTokens: count.optional(),
  inputTokensDetails: z
    .array(z.looseObject({ cached_tokens: count.optional() }))
    .optional(),
  outputTokensDetails: z
    .array(z.looseObject({ reasoning_tokens: count.optional() }))
    .optional(),
});
export const ProviderDataSchema = z.looseObject({
  usage: ProviderUsage.optional(),
  rawUsage: z
    .looseObject({
      prompt_tokens: nullableCount,
      completion_tokens: nullableCount,
      total_tokens: nullableCount,
      cache_read_input_tokens: nullableCount,
      cache_creation_input_tokens: nullableCount,
      prompt_cache_hit_tokens: nullableCount,
      prompt_cache_miss_tokens: nullableCount,
      prompt_tokens_details: z
        .looseObject({ cached_tokens: nullableCount })
        .optional(),
      completion_tokens_details: z
        .looseObject({ reasoning_tokens: nullableCount })
        .optional(),
      completion_thinking_tokens: nullableCount,
      credit: nullableCount,
    })
    .optional(),
  signature: z.string().optional(),
  conversationRequestId: z.string().optional(),
  messageId: z.string().optional(),
  traceId: z.string().optional(),
});
const text = z.looseObject({ type: z.literal("text"), text: z.string() });
const thinking = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
const tool = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObject,
});
export const CliBlockSchema = z.discriminatedUnion("type", [
  text,
  thinking,
  tool,
  z.looseObject({ type: z.literal("redacted_thinking"), data: z.string() }),
  z.looseObject({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(text)]),
    is_error: z.boolean().optional(),
  }),
  z.looseObject({ type: z.literal("refusal"), refusal: z.string() }),
]);
const stop = z
  .enum([
    "end_turn",
    "stop",
    "stop_sequence",
    "tool_use",
    "tool_calls",
    "max_tokens",
    "length",
    "refusal",
    "pause_turn",
  ])
  .nullable();
const message = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["assistant", "user"]),
  content: z.union([z.string(), z.array(CliBlockSchema)]),
  stop_reason: stop.optional(),
  usage: CliUsageSchema.optional(),
});
export const PartialEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("message_start"), message }),
  z.looseObject({
    type: z.literal("content_block_start"),
    index: z.number().int().nonnegative(),
    content_block: CliBlockSchema,
  }),
  z.looseObject({
    type: z.literal("content_block_delta"),
    index: z.number().int().nonnegative(),
    delta: z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal("text_delta"), text: z.string() }),
      z.looseObject({
        type: z.literal("thinking_delta"),
        thinking: z.string(),
      }),
      z.looseObject({
        type: z.literal("signature_delta"),
        signature: z.string(),
      }),
      z.looseObject({
        type: z.literal("input_json_delta"),
        partial_json: z.string(),
      }),
    ]),
  }),
  z.looseObject({
    type: z.literal("content_block_stop"),
    index: z.number().int().nonnegative(),
  }),
  z.looseObject({
    type: z.literal("message_delta"),
    delta: z.looseObject({
      stop_reason: stop.optional(),
      stop_sequence: z.string().nullable().optional(),
    }),
    usage: CliUsageSchema.optional(),
  }),
  z.looseObject({ type: z.literal("message_stop") }),
]);
const envelope = {
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  isReplay: z.boolean().optional(),
  _requestId: z.string().optional(),
  _messageId: z.string().optional(),
  _meta: jsonObject.optional(),
};
export const ResultSchema = z.looseObject({
  type: z.literal("result"),
  ...envelope,
  subtype: z
    .enum([
      "success",
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ])
    .optional(),
  is_error: z.boolean(),
  result: z.string().optional(),
  terminal_reason: z
    .enum([
      "aborted_streaming",
      "aborted_tools",
      "max_tokens",
      "stop",
      "end_turn",
    ])
    .optional(),
  usage: CliUsageSchema.optional(),
  errors: z.array(z.string()).optional(),
  errors_info: z
    .array(
      z
        .looseObject({
          code: z.union([z.string(), z.number()]).optional(),
          message: z.string().optional(),
          details: z.string().optional(),
        })
        .nullable(),
    )
    .optional(),
  permission_denials: z
    .array(
      z.looseObject({
        tool_name: z.string(),
        tool_use_id: z.string().optional(),
        tool_input: z.unknown().optional(),
      }),
    )
    .optional(),
  structured_output: z.unknown().optional(),
});
const rawBlock = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("input_text"), text: z.string() }),
  z.looseObject({ type: z.literal("output_text"), text: z.string() }),
  z.looseObject({ type: z.literal("reasoning_text"), text: z.string() }),
  z.looseObject({ type: z.literal("summary_text"), text: z.string() }),
  z.looseObject({ type: z.literal("refusal"), refusal: z.string() }),
]);
const rawBase = {
  id: z.string().optional(),
  providerData: ProviderDataSchema.optional(),
  status: z.enum(["completed", "incomplete", "in_progress"]).optional(),
};
export const CliEventSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("stream_event"),
    ...envelope,
    event: PartialEventSchema,
  }),
  z.looseObject({ type: z.literal("assistant"), ...envelope, message }),
  z.looseObject({ type: z.literal("user"), ...envelope, message }),
  ResultSchema,
  z.looseObject({
    type: z.literal("system"),
    ...envelope,
    subtype: z.enum([
      "init",
      "keepalive",
      "informational",
      "status",
      "compact_boundary",
      "task_started",
      "task_progress",
      "task_notification",
      "hook_started",
      "hook_progress",
      "hook_response",
    ]),
    content: z.string().optional(),
    prevent_continuation: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal("file-history-snapshot"),
    snapshot: z.unknown().optional(),
  }),
  z.looseObject({ type: z.literal("ai-title"), aiTitle: z.string() }),
  z.looseObject({ type: z.literal("topic"), topic: z.string() }),
  // 既有完整 JSON 的离线回放同样按明确的官方历史事件校验。
  z.looseObject({
    type: z.literal("message"),
    ...rawBase,
    role: z.enum(["assistant", "user", "system"]),
    content: z.array(rawBlock),
  }),
  z.looseObject({
    type: z.literal("reasoning"),
    ...rawBase,
    content: z.array(rawBlock),
    rawContent: z.array(rawBlock).optional(),
  }),
  z.looseObject({
    type: z.literal("function_call"),
    ...rawBase,
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.looseObject({
    type: z.literal("function_call_result"),
    ...rawBase,
    callId: z.string(),
    output: z.unknown(),
  }),
]);
export type CliEvent = z.infer<typeof CliEventSchema>;
export type CliBlock = z.infer<typeof CliBlockSchema>;
export type CliUsage = z.infer<typeof CliUsageSchema>;
export type CliResult = z.infer<typeof ResultSchema>;
export const ToolArgumentsSchema = jsonObject;
export const RpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export const McpCallSchema = z.object({
  name: z.string().min(1),
  arguments: jsonObject.default({}),
});
