/** 宿主与浏览器共享的余额、模型和请求关联协议。 */
import { z } from "zod";
export declare const LoginRegionSchema: z.ZodEnum<{
    cn: "cn";
    global: "global";
}>;
export type LoginRegion = z.infer<typeof LoginRegionSchema>;
export declare const LoginSourceSchema: z.ZodEnum<{
    local: "local";
    web: "web";
}>;
export type LoginSource = z.infer<typeof LoginSourceSchema>;
export declare const LoginStartRequest: z.ZodObject<{
    region: z.ZodEnum<{
        cn: "cn";
        global: "global";
    }>;
}, z.core.$strict>;
export declare const LoginStartResponse: z.ZodObject<{
    loginId: z.ZodUUID;
    url: z.ZodURL;
    expiresInMs: z.ZodNumber;
}, z.core.$strip>;
export declare const LoginPollRequest: z.ZodObject<{
    loginId: z.ZodUUID;
}, z.core.$strict>;
export declare const LoginPollResponse: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"waiting">;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"success">;
    region: z.ZodEnum<{
        cn: "cn";
        global: "global";
    }>;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"error">;
}, z.core.$strip>], "status">;
export type LoginPoll = z.infer<typeof LoginPollResponse>;
export declare const LoginSelectRequest: z.ZodObject<{
    source: z.ZodEnum<{
        local: "local";
        web: "web";
    }>;
}, z.core.$strict>;
export declare const LoginSignOutRequest: z.ZodObject<{}, z.core.$strict>;
export declare const LoginViewSchema: z.ZodObject<{
    source: z.ZodEnum<{
        local: "local";
        web: "web";
    }>;
    localAvailable: z.ZodBoolean;
    webAvailable: z.ZodBoolean;
    webRegion: z.ZodOptional<z.ZodEnum<{
        cn: "cn";
        global: "global";
    }>>;
    webName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type LoginView = z.infer<typeof LoginViewSchema>;
export declare const LOGIN_POLL_INTERVAL_MS = 2000;
export declare const ModelSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    maxInputTokens: z.ZodOptional<z.ZodNumber>;
    maxOutputTokens: z.ZodOptional<z.ZodNumber>;
    credits: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const BalanceSchema: z.ZodObject<{
    total: z.ZodNumber;
    plan: z.ZodString;
    groups: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        remaining: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const StatusSchema: z.ZodObject<{
    models: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        maxInputTokens: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        credits: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    balance: z.ZodNullable<z.ZodObject<{
        total: z.ZodNumber;
        plan: z.ZodString;
        groups: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            remaining: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    updatedAt: z.ZodNullable<z.ZodString>;
    error: z.ZodNullable<z.ZodString>;
    login: z.ZodOptional<z.ZodObject<{
        source: z.ZodEnum<{
            local: "local";
            web: "web";
        }>;
        localAvailable: z.ZodBoolean;
        webAvailable: z.ZodBoolean;
        webRegion: z.ZodOptional<z.ZodEnum<{
            cn: "cn";
            global: "global";
        }>>;
        webName: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type WorkBuddyStatus = z.infer<typeof StatusSchema>;
export declare const TraceSchema: z.ZodObject<{
    phase: z.ZodEnum<{
        error: "error";
        request: "request";
        response: "response";
        event: "event";
        complete: "complete";
    }>;
    requestId: z.ZodString;
    conversationId: z.ZodString;
    model: z.ZodString;
    responseId: z.ZodOptional<z.ZodString>;
    httpStatus: z.ZodOptional<z.ZodNumber>;
    body: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodString>;
    credit: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type WorkBuddyTrace = z.infer<typeof TraceSchema>;
