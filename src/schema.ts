/** WorkBuddy MVP 的配置、只读登录凭据与远程响应协议；外部数据在此校验。 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import schema from "@deepseek-ai/schemastery";
import { z } from "zod";

export const ENDPOINT = "https://www.workbuddy.cn/v2/chat/completions";
export const ConfigSchema = z.strictObject({
  transport: z.enum(["cli", "direct"]).default("cli"),
  model: z.string().min(1).default("deepseek-v4-flash"),
  maxTokens: z.number().int().positive().default(512),
  timeoutMs: z.number().int().positive().default(60_000),
  traceDir: z
    .string()
    .min(1)
    .default(() =>
      resolve(
        process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
        "workbuddy",
        "transport",
      ),
    ),
  electronPath: z
    .string()
    .min(1)
    .default("/Applications/WorkBuddy.app/Contents/MacOS/Electron"),
  authFile: z
    .string()
    .min(1)
    .default(
      join(
        homedir(),
        "Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info",
      ),
    ),
});
export type WorkBuddyConfig = z.infer<typeof ConfigSchema>;
export const Config = schema.transform(
  schema.any<unknown>(),
  (value: unknown) => ConfigSchema.parse(value),
);

export const CredentialsSchema = z.object({
  accessToken: z.string().min(1),
  userId: z.string().min(1),
  expiresAt: z.number().positive(),
  domain: z.string().optional(),
  enterpriseId: z.string().optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const EncryptedFieldSchema = z.strictObject({
  $wbEncrypted: z.literal(1),
  envelope: z.string().min(1),
});
export const DesktopLoginSchema = z.object({
  account: z.object({
    uid: z.string().min(1),
    enterpriseId: z.string().optional(),
  }),
  auth: z.object({
    accessToken: z.union([z.string().min(1), EncryptedFieldSchema]),
    expiresAt: z.number().positive(),
    domain: z.string().optional(),
  }),
});
export const BuildProtectionSchema = z.object({
  version: z.literal(1),
  atRestSecretKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export const EnvelopeSchema = z.strictObject({
  suite: z.literal(1),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  nonce: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

export const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  credit: z.number().nonnegative().optional(),
});
export const EventSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          reasoning: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                id: z.string().optional(),
                function: z
                  .object({
                    name: z.string().optional(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: UsageSchema.nullable().optional(),
  error: z.unknown().optional(),
});

export const ErrorResponseSchema = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  msg: z.string().optional(),
  displayTips: z.object({ zh: z.string().optional() }).optional(),
  message: z.string().optional(),
  error: z
    .union([z.string(), z.object({ message: z.string().optional() })])
    .optional(),
});
