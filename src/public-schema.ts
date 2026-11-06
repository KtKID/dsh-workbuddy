/** 宿主与浏览器共享的余额、模型和请求关联协议。 */
import { z } from "zod";

export const LoginRegionSchema = z.enum(["cn", "global"]);
export type LoginRegion = z.infer<typeof LoginRegionSchema>;
export const LoginSourceSchema = z.enum(["local", "web"]);
export type LoginSource = z.infer<typeof LoginSourceSchema>;
export const LoginStartRequest = z.strictObject({ region: LoginRegionSchema });
export const LoginStartResponse = z.object({
  loginId: z.uuid(),
  url: z.url({ protocol: /^https$/ }),
  expiresInMs: z.number().int().positive(),
});
export const LoginPollRequest = z.strictObject({ loginId: z.uuid() });
export const LoginPollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting") }),
  z.object({
    status: z.literal("success"),
    region: LoginRegionSchema,
    name: z.string().optional(),
  }),
  z.object({ status: z.literal("error") }),
]);
export type LoginPoll = z.infer<typeof LoginPollResponse>;
export const LoginSelectRequest = z.strictObject({ source: LoginSourceSchema });
export const LoginSignOutRequest = z.strictObject({});
export const LoginViewSchema = z.object({
  source: LoginSourceSchema,
  localAvailable: z.boolean(),
  webAvailable: z.boolean(),
  webRegion: LoginRegionSchema.optional(),
  webName: z.string().optional(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;
export const LOGIN_POLL_INTERVAL_MS = 2_000;

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
  login: LoginViewSchema.optional(),
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
