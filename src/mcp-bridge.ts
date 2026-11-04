/** 官方 MCP SDK 发布本轮 KMH 工具；调用登记后由宿主审批、执行并回填结果。 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

export interface KmhTransfer {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 绑定随机回环端口；工具名按本轮声明验证，返回原名与一次调用的独立标识。 */
export async function createKmhBridge(
  tools: readonly ToolSchema[],
  onTransfer: (call: KmhTransfer) => void,
) {
  const declared = new Map(tools.map((tool) => [`kmh-${tool.name}`, tool]));
  const names = [...declared.keys()];
  const token = randomUUID();
  const connections = new Set<Server>();
  const http = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const sdk = new Server(
      { name: "kmh", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    // SDK 的类访问器含 undefined；此委托满足 exactOptionalPropertyTypes，字节与协议仍由 SDK 处理。
    const strictTransport: Transport = {
      start: () => transport.start(),
      send: (message, options) => transport.send(message, options),
      close: () => transport.close(),
      get onclose() {
        return transport.onclose ?? (() => {});
      },
      set onclose(handler) {
        transport.onclose = handler;
      },
      get onerror() {
        return transport.onerror ?? (() => {});
      },
      set onerror(handler) {
        transport.onerror = handler;
      },
      get onmessage() {
        return transport.onmessage ?? (() => {});
      },
      set onmessage(handler) {
        transport.onmessage = handler;
      },
    };
    connections.add(sdk);
    sdk.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...declared].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    }));
    sdk.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      const tool = declared.get(params.name);
      if (!tool)
        throw new McpError(ErrorCode.InvalidParams, "Undeclared KMH tool");
      onTransfer({
        id: randomUUID(),
        name: tool.name,
        arguments: params.arguments ?? {},
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "KMH_TOOL_TRANSFERRED: this request is queued for KMH approval and execution. End the current response. Continue after KMH supplies the actual tool result.",
          },
        ],
      };
    });
    res.once("close", () => {
      connections.delete(sdk);
      sdk.close().catch(() => {});
    });
    sdk
      .connect(strictTransport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  if (tools.length)
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
  const address = http.address();
  const config = {
    mcpServers:
      address && typeof address !== "string"
        ? {
            kmh: {
              type: "http",
              transparent_proxy: true,
              builtin_tools: names,
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: { Authorization: `Bearer ${token}` },
            },
          }
        : {},
  };
  return {
    names,
    config,
    async close(): Promise<void> {
      await Promise.all([...connections].map((sdk) => sdk.close()));
      http.closeAllConnections();
      if (http.listening)
        await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
