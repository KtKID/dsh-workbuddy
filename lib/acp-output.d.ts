/** 将官方 SDK 已校验的 ACP 通知投影为 KMH 流；原生工具和扩展信息留在协议元数据。 */
import type { SessionNotification, PromptResponse, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { type ContentBlock, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { KmhTransfer } from "./mcp-bridge.js";
export declare class AcpOutput {
    readonly content: ContentBlock[];
    readonly metadata: Record<string, unknown>;
    readonly tools: Map<string, ToolCall | ToolCallUpdate>;
    private readonly usageByCall;
    private modelRequestId;
    private index;
    private active;
    /** 关闭一个已输出的文本块；块顺序与 ACP 通知顺序一致。 */
    close(): StreamChunk[];
    /** 接收官方 SessionNotification；完整通知同时保存在传输记录。 */
    push({ update }: SessionNotification): StreamChunk[];
    /** 返回当前 prompt 的用量快照；同一调用的重复或更新通知替换原值。 */
    private totalUsage;
    /** MCP SDK 确认的请求是宿主工具调用的唯一来源，ACP 工具通知只用于观察。 */
    transfer(call: KmhTransfer): StreamChunk[];
    /** 正式响应决定本轮结束；标准用量优先，WB 通知补齐扩展用量。 */
    finish(response: PromptResponse, transferred: boolean): StreamChunk[];
}
