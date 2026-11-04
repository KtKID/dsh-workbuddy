/** 从当前桌面登录态取得一次模型请求使用的凭据，读取错误按安全诊断返回。 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
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
    if (config.credentialsFile) {
      const file = await open(
        config.credentialsFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 64 * 1024 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("private credentials required");
        const result = CredentialsSchema.parse(
          JSON.parse(await file.readFile("utf8")),
        );
        if (result.expiresAt <= Date.now()) throw new Error("expired");
        return result;
      } finally {
        await file.close();
      }
    }
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
      "WORKBUDDY_AUTH_UNAVAILABLE：请确认 WorkBuddy 登录有效，导入凭据文件须归当前用户并仅对本人可读写",
      "WORKBUDDY_AUTH_UNAVAILABLE",
    );
  }
}
