import type { ToolSchema } from "@deepseek-ai/dsh-llm";
export interface KmhTransfer {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
/** 绑定随机回环端口；工具名按本轮声明验证，返回原名与一次调用的独立标识。 */
export declare function createKmhBridge(tools: readonly ToolSchema[], onTransfer: (call: KmhTransfer) => void): Promise<{
    names: string[];
    config: {
        mcpServers: {
            kmh: {
                type: string;
                transparent_proxy: boolean;
                builtin_tools: string[];
                url: string;
                headers: {
                    Authorization: string;
                };
            };
        } | {
            kmh?: never;
        };
    };
    close(): Promise<void>;
}>;
