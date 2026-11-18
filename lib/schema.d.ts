import schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import type { LoginRegion } from "./public-schema.js";
export declare const ENDPOINT = "https://www.workbuddy.cn/v2/chat/completions";
export declare function workBuddyDataDir(): string;
export declare const ConfigSchema: z.ZodObject<{
    transport: z.ZodDefault<z.ZodEnum<{
        cli: "cli";
        direct: "direct";
    }>>;
    model: z.ZodDefault<z.ZodString>;
    maxTokens: z.ZodDefault<z.ZodNumber>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    cliPath: z.ZodOptional<z.ZodString>;
    credentialsFile: z.ZodOptional<z.ZodString>;
    traceDir: z.ZodDefault<z.ZodString>;
    electronPath: z.ZodDefault<z.ZodString>;
    authFile: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
export type WorkBuddyConfig = z.infer<typeof ConfigSchema>;
export declare const Config: schema<unknown, WorkBuddyConfig>;
export declare const CredentialsSchema: z.ZodObject<{
    accessToken: z.ZodString;
    userId: z.ZodString;
    expiresAt: z.ZodNumber;
    domain: z.ZodOptional<z.ZodString>;
    enterpriseId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Credentials = z.infer<typeof CredentialsSchema>;
export type WorkBuddyAccount = {
    source: "local";
    credentials: Credentials;
} | {
    source: "web";
    region: LoginRegion;
    credentials: Credentials;
};
export declare const EncryptedFieldSchema: z.ZodObject<{
    $wbEncrypted: z.ZodLiteral<1>;
    envelope: z.ZodString;
}, z.core.$strict>;
export declare const DesktopLoginSchema: z.ZodObject<{
    account: z.ZodObject<{
        uid: z.ZodString;
        enterpriseId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    auth: z.ZodObject<{
        accessToken: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            $wbEncrypted: z.ZodLiteral<1>;
            envelope: z.ZodString;
        }, z.core.$strict>]>;
        expiresAt: z.ZodNumber;
        domain: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const BuildProtectionSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    atRestSecretKey: z.ZodString;
}, z.core.$strip>;
export declare const EnvelopeSchema: z.ZodObject<{
    suite: z.ZodLiteral<1>;
    keyId: z.ZodString;
    nonce: z.ZodString;
    authTag: z.ZodString;
    ciphertext: z.ZodString;
}, z.core.$strict>;
export declare const UsageSchema: z.ZodObject<{
    prompt_tokens: z.ZodNumber;
    completion_tokens: z.ZodNumber;
    total_tokens: z.ZodOptional<z.ZodNumber>;
    prompt_tokens_details: z.ZodOptional<z.ZodObject<{
        cached_tokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    completion_tokens_details: z.ZodOptional<z.ZodObject<{
        reasoning_tokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    credit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const EventSchema: z.ZodObject<{
    choices: z.ZodOptional<z.ZodArray<z.ZodObject<{
        delta: z.ZodObject<{
            content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            reasoning_content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            reasoning: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            tool_calls: z.ZodOptional<z.ZodArray<z.ZodObject<{
                index: z.ZodNumber;
                id: z.ZodOptional<z.ZodString>;
                function: z.ZodOptional<z.ZodObject<{
                    name: z.ZodOptional<z.ZodString>;
                    arguments: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
        }, z.core.$strip>;
        finish_reason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>>;
    usage: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        prompt_tokens: z.ZodNumber;
        completion_tokens: z.ZodNumber;
        total_tokens: z.ZodOptional<z.ZodNumber>;
        prompt_tokens_details: z.ZodOptional<z.ZodObject<{
            cached_tokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        completion_tokens_details: z.ZodOptional<z.ZodObject<{
            reasoning_tokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        credit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    error: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export declare const ErrorResponseSchema: z.ZodObject<{
    code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    msg: z.ZodOptional<z.ZodString>;
    displayTips: z.ZodOptional<z.ZodObject<{
        zh: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    message: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        message: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>>;
}, z.core.$strip>;
