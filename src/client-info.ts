/** 从 WorkBuddy 安装包公开元数据构造客户端标识；读取或校验失败时终止请求。 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import type { WorkBuddyConfig } from "./schema.js";
import { resolveWorkBuddyCli } from "./runtime.js";

const VersionSchema = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const ProductSchema = z.object({
  productName: z.literal("WorkBuddy"),
  genieVersion: VersionSchema,
});
const PackageSchema = z.object({
  version: z.string().optional(),
  publishConfig: z
    .object({
      customPackage: z.object({ version: z.string().optional() }).optional(),
    })
    .optional(),
});

/** 输入 Electron 路径，返回桌面和内嵌 CLI 标识；失败给固定错误且保持凭据未读取。 */
export async function readWorkBuddyClientHeaders(
  config: WorkBuddyConfig,
): Promise<Record<string, string>> {
  try {
    const cliRoot = resolve(dirname(resolveWorkBuddyCli(config)), "..");
    const [productText, packageText] = await Promise.all([
      readFile(join(cliRoot, "product.json"), "utf8"),
      readFile(join(cliRoot, "package.json"), "utf8"),
    ]);
    const product = ProductSchema.parse(JSON.parse(productText));
    const pkg = PackageSchema.parse(JSON.parse(packageText));
    const cliVersion = VersionSchema.parse(
      pkg.version && pkg.version !== "0.0.0"
        ? pkg.version
        : pkg.publishConfig?.customPackage?.version,
    );
    // 桌面 sidecar 提供 IDE 版本，官方 UA 构造器再追加内嵌 CLI 的实际版本。
    return {
      "User-Agent": `WorkBuddy/${product.genieVersion} WorkBuddy/${product.genieVersion} CLI/${cliVersion}`,
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Version": product.genieVersion,
    };
  } catch {
    throw new LlmError(
      "WORKBUDDY_CLIENT_INFO_UNAVAILABLE：请确认 WorkBuddy 安装元数据完整",
      "WORKBUDDY_CLIENT_INFO_UNAVAILABLE",
    );
  }
}
