/** 从当前桌面登录态取得一次模型请求使用的凭据，读取错误按安全诊断返回。 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CredentialsSchema,
  type Credentials,
  type WorkBuddyConfig,
} from "./schema.js";

const runFile = promisify(execFile);
const CREDENTIAL_READ_TIMEOUT_MS = 10_000;

/** 输入应用和登录文件路径；返回只读凭据，缺失或不可读时抛出 LlmError。 */
export async function readDesktopCredentials(
  config: WorkBuddyConfig,
): Promise<Credentials> {
  try {
    const { stdout } = await runFile(
      config.electronPath,
      [
        fileURLToPath(new URL("./credential-reader.js", import.meta.url)),
        config.authFile,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        timeout: CREDENTIAL_READ_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
    );
    const result = CredentialsSchema.parse(JSON.parse(stdout));
    if (result.expiresAt <= Date.now()) throw new Error("expired");
    return result;
  } catch {
    // execFile 的异常可携带 stdout；使用固定诊断保住管道中的 access token。
    throw new LlmError(
      "WORKBUDDY_AUTH_UNAVAILABLE：请在 WorkBuddy 中确认当前登录有效",
      "WORKBUDDY_AUTH_UNAVAILABLE",
    );
  }
}
