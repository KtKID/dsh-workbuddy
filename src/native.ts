/** 官方 CLI 执行模型回合；MCP 只负责转交工具请求，实际执行与审批由 KMH 持有。 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  LlmError,
  projectToolUpdates,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Credentials, WorkBuddyConfig } from "./schema.js";
import type { WorkBuddyTrace } from "./public-schema.js";
import { NativeOutput } from "./native-output.js";
import { NativeDecoder } from "./native-decoder.js";
import { RpcSchema, McpCallSchema } from "./native-schema.js";
/** 输入正式会话历史，输出 KMH 流；进程结束、取消、超时及工具转交都回收子进程和临时 HTTP 服务。 */
export async function* nativeCompletion(
  options: GenerateOptions,
  config: WorkBuddyConfig,
  credentials: Credentials,
  onTrace: (trace: WorkBuddyTrace) => void,
): AsyncIterable<StreamChunk> {
  options.signal?.throwIfAborted();
  const requestId = randomUUID(),
    conversationId = options.sessionId ?? randomUUID(),
    initialNativeSessionId = randomUUID();
  const trace = (
    data: Omit<WorkBuddyTrace, "requestId" | "conversationId" | "model">,
  ) => onTrace({ requestId, conversationId, model: options.model, ...data });
  const safe = (text: string) =>
    [credentials.accessToken, credentials.userId].reduce(
      (s, key) => (key ? s.replaceAll(key, "[redacted]") : s),
      text,
    );
  const projected = projectToolUpdates(
    options.messages,
    options.tools,
    undefined,
    options.toolHistory,
  );
  if (
    projected.messages.some((m) =>
      m.content.some(
        (b) => !["text", "reasoning", "tool-call"].includes(b.type),
      ),
    )
  )
    throw new LlmError("WORKBUDDY_TEXT_ONLY", "WORKBUDDY_TEXT_ONLY");
  const declared = new Map(projected.tools?.map((t) => [t.name, t]) ?? []);
  const transfers = new Map<string, z.infer<typeof McpCallSchema>>();
  const bridgeToken = randomUUID();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${bridgeToken}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
        size += bytes.length;
        if (size > 2_000_000) {
          res.writeHead(413).end();
          return;
        }
        parts.push(bytes);
      }
      const message = RpcSchema.parse(
        JSON.parse(Buffer.concat(parts).toString("utf8")),
      );
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "kmh", version: "1.0.0" },
        };
      else if (message.method === "tools/list")
        result = {
          tools: [...declared.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        };
      else if (message.method === "tools/call") {
        const call = McpCallSchema.parse(message.params);
        if (!declared.has(call.name)) throw new Error("undeclared tool");
        transfers.set(String(message.id), call);
        // 只确认转交，工具执行仍由 KMH 负责；max-turns=1 阻止 CLI 进入下一次模型调用。
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: "KMH_TOOL_TRANSFERRED: execution is deferred to the host. This is a transport acknowledgement, not the tool result.",
            },
          ],
        };
      } else if (message.method !== "ping") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  let mcpConfig = { mcpServers: {} };
  if (declared.size) {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("WORKBUDDY_BRIDGE_ADDRESS");
    mcpConfig = {
      mcpServers: {
        kmh: {
          type: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: `Bearer ${bridgeToken}` },
        },
      },
    };
  }
  const latest = projected.messages.at(-1);
  const separateUser = latest?.role === "user";
  const history = separateUser
    ? projected.messages.slice(0, -1)
    : projected.messages;
  const currentText = separateUser
    ? latest.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
    : "Continue the current user task using the completed tool results in the conversation history.";
  const digest = (messages: readonly { role: string; content: unknown }[]) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          model: options.model,
          system: options.system ?? "",
          tools: projected.tools ?? [],
          account: [
            credentials.userId,
            credentials.enterpriseId ?? "",
            credentials.domain ?? "",
          ],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      )
      .digest("hex");
  const previous = history.at(-1);
  const envelope = z
    .object({ response: z.unknown() })
    .safeParse(
      previous?.role === "assistant" && previous.source?.kind === "model"
        ? previous.source.replayState
        : undefined,
    );
  const binding = z
    .object({ nativeSessionId: z.string(), historyDigest: z.string() })
    .safeParse(envelope.success ? envelope.data.response : undefined);
  const resume =
    separateUser &&
    binding.success &&
    binding.data.historyDigest === digest(history)
      ? binding.data.nativeSessionId
      : undefined;
  const nativeSessionId = resume ?? initialNativeSessionId;
  // 官方 CLI 保留自己的系统协议；KMH 的上下文作为本次任务材料传入。
  const prompt =
    resume || (!history.length && !options.system)
      ? currentText
      : [
          "You are handling a conversation in KMH. Use the prior conversation below as context, and answer only CURRENT_USER_MESSAGE at the end. The historical user messages have already been sent and answered.",
          options.system ? `HOST_TASK_CONTEXT:\n${options.system}` : "",
          `PRIOR_CONVERSATION_JSON:\n${JSON.stringify(history)}\nEND_PRIOR_CONVERSATION`,
          `CURRENT_USER_MESSAGE:\n${currentText}`,
        ]
          .filter(Boolean)
          .join("\n\n");
  const cli = resolve(
    dirname(config.electronPath),
    "../Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs",
  );
  const args = [
    cli,
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--setting-sources",
    "",
    "--max-turns",
    "1",
    ...(resume
      ? ["--resume", nativeSessionId]
      : ["--session-id", nativeSessionId]),
    "--model",
    options.model,
  ];
  if (declared.size)
    args.push(
      "--allowedTools",
      [...declared.keys()].map((name) => `mcp__kmh__${name}`).join(","),
    );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(ACC_PRODUCT_CONFIG|CODEBUDDY_(API_KEY|BASE_URL|CUSTOM_HEADERS|AUTH_TOKEN|MODEL|INTERNET_ENV|SETTINGS))/.test(
        key,
      ) ||
      /^(https?|all)_proxy$/i.test(key)
    )
      delete env[key];
  env.CODEBUDDY_AUTH_TOKEN = credentials.accessToken;
  env.ACC_USER_ID = credentials.userId;
  trace({
    phase: "request",
    body: JSON.stringify({
      transport: "official-cli",
      nativeSessionId,
      system: options.system ?? "",
      messages: projected.messages,
      tools: projected.tools ?? [],
    }),
  });
  const output = new NativeOutput(new Set(declared.keys()), Boolean(resume));
  const chunks: StreamChunk[] = [];
  let wake: () => void = () => {};
  let closed = false,
    timedOut = false,
    totalBytes = 0;
  let exitCode: number | null = null;
  let failure: Error | undefined;
  let stderr = "";
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* 已退出 */
      }
    };
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
  };
  const decoder = new NativeDecoder((event, raw) => {
    trace({ phase: "event", raw: safe(raw) });
    chunks.push(...output.push(event));
    wake();
  });
  child.stdout.on("data", (bytes: Buffer) => {
    if (failure) return;
    try {
      totalBytes += bytes.length;
      if (totalBytes > 16_000_000)
        throw new LlmError(
          "WORKBUDDY_CLI_OUTPUT_LIMIT",
          "WORKBUDDY_CLI_OUTPUT_LIMIT",
        );
      decoder.push(bytes);
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new LlmError("WORKBUDDY_CLI_PROTOCOL", "WORKBUDDY_CLI_PROTOCOL");
      stop();
      wake();
    }
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-16384);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const completion = new Promise<void>((done) => {
    child.once("error", () => {
      failure = new LlmError(
        "WORKBUDDY_CLI_PROCESS_FAILED",
        "WORKBUDDY_CLI_PROCESS_FAILED",
      );
      wake();
    });
    child.once("close", (code) => {
      exitCode = code;
      closed = true;
      if (!failure) {
        try {
          decoder.end();
        } catch (error) {
          failure =
            error instanceof Error
              ? error
              : new LlmError(
                  "WORKBUDDY_CLI_PROTOCOL",
                  "WORKBUDDY_CLI_PROTOCOL",
                );
        }
      }
      done();
      wake();
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    wake();
  }, config.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    while (!closed || chunks.length) {
      options.signal?.throwIfAborted();
      if (failure) throw failure;
      const chunk = chunks.shift();
      if (chunk) yield chunk;
      else if (!closed)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    options.signal?.throwIfAborted();
    if (timedOut)
      throw new LlmError("WORKBUDDY_CLI_TIMEOUT", "WORKBUDDY_CLI_TIMEOUT");
    if (failure) throw failure;
    for (const [id, call] of transfers)
      yield* output.transfer(
        call.name,
        call.arguments,
        `mcp-${requestId}-${id}`,
      );
    const metadata = {
      requestId,
      conversationId,
      nativeSessionId: output.result?.session_id ?? nativeSessionId,
      ...(output.responseId ? { responseId: output.responseId } : {}),
      providerRequestIds: [...output.requestIds],
      protocolMetadata: output.metadata,
      ...(output.calls.length
        ? {}
        : {
            historyDigest: digest([
              ...projected.messages,
              { role: "assistant", content: output.content },
            ]),
          }),
    };
    for (const chunk of output.finish(exitCode)) {
      if (chunk.type === "finish") {
        const failed =
          chunk.reason.kind === "error" || chunk.reason.kind === "aborted";
        trace({
          phase: failed ? "error" : "complete",
          ...(output.responseId ? { responseId: output.responseId } : {}),
          ...(output.credit === undefined ? {} : { credit: output.credit }),
          ...(chunk.reason.kind === "error" || chunk.reason.kind === "aborted"
            ? { error: chunk.reason.failure.code }
            : {}),
        });
        yield { ...chunk, replayState: { response: metadata } };
      } else yield chunk;
    }
  } catch (error) {
    if (stderr) trace({ phase: "event", raw: safe(stderr) });
    trace({
      phase: "error",
      error: error instanceof LlmError ? error.code : "WORKBUDDY_CLI_FAILED",
    });
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    stop();
    await completion;
    if (killTimer) clearTimeout(killTimer);
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((done) => server.close(() => done()));
  }
}
