/** 宿主与浏览器共享的余额、模型和请求关联协议。 */
import { z } from "zod";

export const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxInputTokens: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  credits: z.string().optional(),
});
export const BalanceSchema = z.object({
  total: z.number().nonnegative(),
  plan: z.string(),
  groups: z.array(
    z.object({ name: z.string(), remaining: z.number().nonnegative() }),
  ),
});
export const StatusSchema = z.object({
  models: z.array(ModelSchema),
  balance: BalanceSchema.nullable(),
  updatedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorkBuddyStatus = z.infer<typeof StatusSchema>;
export const TraceSchema = z.object({
  phase: z.enum(["request", "response", "event", "complete", "error"]),
  requestId: z.string(),
  conversationId: z.string(),
  model: z.string(),
  responseId: z.string().optional(),
  httpStatus: z.number().optional(),
  body: z.string().optional(),
  raw: z.string().optional(),
  credit: z.number().optional(),
  error: z.string().optional(),
});
export type WorkBuddyTrace = z.infer<typeof TraceSchema>;
