/** 官方 ACP SDK 连接 WB 内置 CLI；原生工具由 WB 执行，KMH 工具经官方 MCP SDK 转交。 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { z } from "zod";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  LlmError,
  projectToolUpdates,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Credentials, WorkBuddyConfig } from "./schema.js";
import type { WorkBuddyTrace } from "./public-schema.js";
import { AcpOutput } from "./acp-output.js";
import { resolveWorkBuddyCli } from "./runtime.js";
import { createKmhBridge, type KmhTransfer } from "./mcp-bridge.js";

const Binding = z.object({
  response: z.object({
    transport: z.literal("acp-v1"),
    nativeSessionId: z.string(),
    historyDigest: z.string(),
  }),
});

/** 输入 KMH 完整历史，输出有序流；SDK 管理协议与请求关联，本函数拥有子进程和临时工具桥。 */
export async function* nativeCompletion(
  options: GenerateOptions,
  config: WorkBuddyConfig,
  credentials: Credentials,
  onTrace: (trace: WorkBuddyTrace) => void,
  onPermission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<boolean>,
  cwd = process.cwd(),
  onRejectedTurn?: () => void,
): AsyncIterable<StreamChunk> {
  options.signal?.throwIfAborted();
  const requestId = randomUUID();
  const conversationId = options.sessionId ?? randomUUID();
  const safe = (value: unknown): string =>
    [credentials.accessToken, credentials.userId].reduce(
      (s, key) => (key ? s.replaceAll(key, "[redacted]") : s),
      JSON.stringify(value),
    );
  const trace = (
    data: Omit<WorkBuddyTrace, "requestId" | "conversationId" | "model">,
  ) => onTrace({ requestId, conversationId, model: options.model, ...data });
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
  const currentStart =
    projected.messages.findLastIndex((m) => m.role !== "user") + 1;
  const separateUser = projected.messages.at(-1)?.role === "user";
  const history = separateUser
    ? projected.messages.slice(0, currentStart)
    : projected.messages;
  const currentText = separateUser
    ? projected.messages
        .slice(currentStart)
        .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
        .join("\n\n")
    : "Continue the active user task using the completed KMH tool results in the conversation history.";
  const messageView = (
    messages: readonly {
      role: string;
      content: unknown;
      toolCallId?: unknown;
      isError?: unknown;
    }[],
  ) =>
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === "tool"
        ? { toolCallId: message.toolCallId, isError: message.isError }
        : {}),
    }));
  const digest = (messages: Parameters<typeof messageView>[0]) =>
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
          transport: "acp-v1",
          historyVersion: 2,
          cwd,
          messages: messageView(messages),
        }),
      )
      .digest("hex");
  const anchor = history.findLastIndex(
    (message) => message.role === "assistant",
  );
  const previous = history[anchor];
  const binding = Binding.safeParse(
    previous?.role === "assistant" && previous.source?.kind === "model"
      ? previous.source.replayState
      : undefined,
  );
  const resume =
    binding.success &&
    binding.data.response.historyDigest ===
      digest(history.slice(0, anchor + 1)) &&
    projected.messages
      .slice(anchor + 1)
      .every((message) => message.role === "tool" || message.role === "user")
      ? binding.data.response.nativeSessionId
      : undefined;
  const added = projected.messages.slice(anchor + 1);
  const continuedPrompt = added.some((message) => message.role === "tool")
    ? `Continue the active user task. KMH has completed the queued host operations. Consume these actual tool results and new user context, then continue the remaining work.\nKMH_NEW_MESSAGES_JSON:\n${JSON.stringify(messageView(added))}`
    : currentText;
  const fullPrompt =
    !history.length && !options.system
      ? currentText
      : [
          "Continue the active user task in KMH using the ordered conversation and CURRENT_USER_MESSAGE. User messages may also contain runtime, skill, and time context. Preserve pending tasks and use completed tool results.",
          options.system ? `HOST_TASK_CONTEXT:\n${options.system}` : "",
          `PRIOR_CONVERSATION_JSON:\n${JSON.stringify(messageView(history))}\nEND_PRIOR_CONVERSATION`,
          `CURRENT_USER_MESSAGE:\n${currentText}`,
        ]
          .filter(Boolean)
          .join("\n\n");
  const transfers: KmhTransfer[] = [];
  const bridge = await createKmhBridge(projected.tools ?? [], (call) =>
    transfers.push(call),
  );
  const cli = resolveWorkBuddyCli(config);
  const args = [
    cli,
    "--serve",
    "--acp",
    "--acp-transport",
    "stdio",
    "--tools",
    "default",
    "--permission-mode",
    "default",
    "--max-turns",
    "99",
    "--model",
    options.model,
    "--append-system-prompt",
    "You are handling the active KMH task with WorkBuddy native tools and additional KMH tools. WorkBuddy executes its native tools. KMH tools use the exact advertised name kmh-<original-name>, for example kmh-read and kmh-bash. The host removes one leading kmh- and executes the original KMH tool. A KMH_TOOL_TRANSFERRED receipt acknowledges a queued KMH request. End the current response after that receipt so KMH can approve and execute the request. Continue when KMH supplies its actual tool result. Preserve the active task and supplied runtime context.",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(bridge.config),
    "--setting-sources",
    "",
    ...(bridge.names.length ? ["--allowedTools", bridge.names.join(",")] : []),
  ];
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
  const output = new AcpOutput();
  const chunks: StreamChunk[] = [];
  let wake: () => void = () => {};
  let nativeSessionId: string | undefined;
  let resumed = false;
  let prompting = false;
  let permissionRejected = false;
  let settled = false;
  let failure: Error | undefined;
  let stderr = "";
  const lifetime = new AbortController();
  const child = spawn(process.execPath, args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-16384);
  });
  child.stdin.on("error", () => {});
  let receiving = true;
  const incoming = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on("data", (bytes: Buffer) => {
        if (receiving) controller.enqueue(bytes);
      });
      child.stdout.once("end", () => {
        if (receiving) {
          receiving = false;
          controller.close();
        }
      });
      child.stdout.once("error", (error) => {
        if (receiving) {
          receiving = false;
          controller.error(error);
        }
      });
    },
    cancel() {
      receiving = false;
    },
  });
  const wire = ndJsonStream(Writable.toWeb(child.stdin), incoming);
  const connection = client({ name: "workbuddy" })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (prompting && params.sessionId === nativeSessionId) {
        try {
          chunks.push(...output.push(params));
          wake();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          connection.close(failure);
        }
      }
    })
    .onRequest(
      methods.client.session.requestPermission,
      async ({ params, signal }): Promise<RequestPermissionResponse> => {
        const bound = AbortSignal.any([
          signal,
          lifetime.signal,
          ...(options.signal ? [options.signal] : []),
        ]);
        if (params.sessionId !== nativeSessionId || !prompting || bound.aborted)
          return { outcome: { outcome: "cancelled" } };
        let allowed = false;
        let withdraw = () => {};
        const withdrawn = new Promise<boolean>((resolve) => {
          withdraw = () => resolve(false);
          bound.addEventListener("abort", withdraw, { once: true });
          if (bound.aborted) withdraw();
        });
        try {
          allowed = await Promise.race([
            onPermission ? onPermission(params, bound) : Promise.resolve(false),
            withdrawn,
          ]);
        } catch {
          /* 宿主审批异常按拒绝回传。 */
        } finally {
          bound.removeEventListener("abort", withdraw);
        }
        if (bound.aborted) return { outcome: { outcome: "cancelled" } };
        if (!allowed) permissionRejected = true;
        const selected = params.options.find(
          (o) => o.kind === (allowed ? "allow_once" : "reject_once"),
        );
        return selected
          ? { outcome: { outcome: "selected", optionId: selected.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
    )
    .connect({
      ...wire,
      readable: wire.readable.pipeThrough(
        new TransformStream({
          transform(message, controller) {
            trace({ phase: "event", raw: safe(message) });
            controller.enqueue(message);
          },
        }),
      ),
    });
  child.once("error", () =>
    connection.close(
      new LlmError(
        "WORKBUDDY_ACP_PROCESS_FAILED",
        "WORKBUDDY_ACP_PROCESS_FAILED",
      ),
    ),
  );
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    lifetime.abort();
    if (nativeSessionId && !connection.signal.aborted) {
      connection.agent
        .notify(methods.agent.session.cancel, { sessionId: nativeSessionId })
        .catch(() => {});
      cancelTimer ??= setTimeout(
        () =>
          connection.close(
            new LlmError("WORKBUDDY_ACP_CANCELLED", "WORKBUDDY_ACP_CANCELLED"),
          ),
        1500,
      );
    } else connection.close();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const running = (async () => {
    const initialized = await connection.agent.request(
      methods.agent.initialize,
      { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION)
      throw new LlmError(
        "WORKBUDDY_ACP_VERSION_UNSUPPORTED",
        "WORKBUDDY_ACP_VERSION_UNSUPPORTED",
      );
    if (resume && initialized.agentCapabilities?.loadSession) {
      nativeSessionId = resume;
      try {
        await connection.agent.request(methods.agent.session.load, {
          sessionId: resume,
          cwd,
          mcpServers: [],
        });
        resumed = true;
      } catch (error) {
        if (connection.signal.aborted || options.signal?.aborted) throw error;
        trace({
          phase: "event",
          raw: safe({
            recovery: "rebuild-from-kmh-history",
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }
    if (!resumed) {
      const session = await connection.agent.request(
        methods.agent.session.new,
        { cwd, mcpServers: [] },
      );
      nativeSessionId = session.sessionId;
    }
    if (!nativeSessionId)
      throw new LlmError(
        "WORKBUDDY_ACP_SESSION_MISSING",
        "WORKBUDDY_ACP_SESSION_MISSING",
      );
    trace({
      phase: "request",
      body: safe({
        transport: "acp-v1",
        nativeSessionId,
        resumed,
        system: options.system ?? "",
        messages: projected.messages,
        tools: projected.tools ?? [],
        cwd,
      }),
    });
    prompting = true;
    const response = await connection.agent.request(
      methods.agent.session.prompt,
      {
        sessionId: nativeSessionId,
        prompt: [
          { type: "text", text: resumed ? continuedPrompt : fullPrompt },
        ],
      },
    );
    if (
      response.stopReason === "cancelled" &&
      permissionRejected &&
      !options.signal?.aborted
    )
      onRejectedTurn?.();
    prompting = false;
    lifetime.abort();
    for (const call of transfers) chunks.push(...output.transfer(call));
    const finished = output.finish(response, transfers.length > 0);
    const metadata = {
      transport: "acp-v1",
      requestId,
      conversationId,
      nativeSessionId,
      protocolMetadata: output.metadata,
      historyDigest: digest([
        ...projected.messages,
        { role: "assistant", content: output.content },
      ]),
    };
    for (const chunk of finished)
      chunks.push(
        chunk.type === "finish"
          ? { ...chunk, replayState: { response: metadata } }
          : chunk,
      );
    const terminal = finished.find((chunk) => chunk.type === "finish");
    if (terminal?.reason.kind === "aborted")
      trace({
        phase: "complete",
        raw: safe({ stopReason: response.stopReason }),
      });
    else if (terminal?.reason.kind === "error")
      trace({ phase: "error", error: terminal.reason.failure.code });
    else trace({ phase: "complete" });
  })()
    .catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      settled = true;
      wake();
    });
  try {
    while (!settled || chunks.length) {
      options.signal?.throwIfAborted();
      if (failure) throw failure;
      const chunk = chunks.shift();
      if (chunk) yield chunk;
      else if (!settled)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    options.signal?.throwIfAborted();
    if (failure) throw failure;
  } catch (error) {
    if (options.signal?.aborted)
      trace({ phase: "complete", raw: safe({ cancelled: true }) });
    else trace({ phase: "error", error: "WORKBUDDY_ACP_FAILED" });
    if (stderr) trace({ phase: "event", raw: safe(stderr) });
    if (options.signal?.aborted) throw error;
    throw new LlmError(
      `WORKBUDDY_ACP_FAILED: ${safe(error instanceof Error ? error.message : error)}`,
      "WORKBUDDY_ACP_FAILED",
    );
  } finally {
    lifetime.abort();
    options.signal?.removeEventListener("abort", cancel);
    if (!settled) cancel();
    connection.close();
    child.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* 目标进程已退出。 */
      }
    };
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(force);
    if (cancelTimer) clearTimeout(cancelTimer);
    await running;
    await connection.closed;
    await bridge.close();
  }
}
