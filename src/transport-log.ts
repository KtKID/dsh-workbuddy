/** 将已脱敏的传输记录按会话保存，独立于 DSH 的持久化事件格式。 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TraceSchema, type WorkBuddyTrace } from "./public-schema.js";

/** 返回会话诊断路径；会话标识经哈希编码，任意标识都保持在指定目录内。 */
export function transportTracePath(
  directory: string,
  sessionId: string,
): string {
  const filename = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${filename}.jsonl`);
}

/** 同步追加一条完整诊断；载荷校验和文件错误向请求传播。 */
export function appendTransportTrace(
  directory: string,
  sessionId: string,
  trace: WorkBuddyTrace,
): void {
  const data = TraceSchema.parse(trace);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(
    transportTracePath(directory, sessionId),
    JSON.stringify({ type: "workbuddy/transport", time: Date.now(), data }) +
      "\n",
    { encoding: "utf8", mode: 0o600, flush: true },
  );
}
