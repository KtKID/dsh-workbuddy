/** 解析单次 WorkBuddy SSE 并映射 KMH 文本流，结束前汇总用量与 credit。 */
import { type StreamChunk } from "@deepseek-ai/dsh-llm";
/** 输入一次响应、取消信号与 credit 观察器，返回 KMH 流；格式/远端错误按安全码抛出。 */
export declare function parseResponse(response: Response, signal: AbortSignal, onCredit?: (credit: number) => void, secrets?: readonly string[], onEvent?: (data: string) => void): AsyncIterable<StreamChunk>;
