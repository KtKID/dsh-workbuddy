#!/usr/bin/env node
/** 导出已安装的官方 WorkBuddy CLI 和当前登录到私有目录，供本人 Docker 部署。 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readDesktopCredentials } from "../lib/credentials.js";
import { readWorkBuddyClientHeaders } from "../lib/client-info.js";
import { resolveWorkBuddyCli } from "../lib/runtime.js";
import { ConfigSchema } from "../lib/schema.js";

/** 校验源安装与登录后创建新目录；失败只输出固定诊断，凭据始终留在私有文件。 */
async function main() {
  const { values } = parseArgs({
    options: {
      dest: { type: "string" },
      electron: { type: "string" },
      auth: { type: "string" },
    },
  });
  if (!values.dest) throw new Error("EXPORT_DEST_REQUIRED");
  const config = ConfigSchema.parse({
    ...(values.electron ? { electronPath: resolve(values.electron) } : {}),
    ...(values.auth ? { authFile: resolve(values.auth) } : {}),
  });
  await readWorkBuddyClientHeaders(config);
  const credentials = await readDesktopCredentials(config);
  const dest = resolve(values.dest);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await mkdir(dest, { mode: 0o700 });
  await cp(
    resolve(dirname(resolveWorkBuddyCli(config)), ".."),
    resolve(dest, "runtime"),
    { recursive: true },
  );
  await writeFile(
    resolve(dest, "credentials.json"),
    JSON.stringify(credentials),
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(
    `WorkBuddy runtime exported to ${dest}\nCredentials expire at ${new Date(credentials.expiresAt).toISOString()}\n`,
  );
}

try {
  await main();
} catch {
  process.stderr.write(
    "WORKBUDDY_EXPORT_FAILED: confirm desktop login and use a new private destination directory.\n",
  );
  process.exitCode = 1;
}
