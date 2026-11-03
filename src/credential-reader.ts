/** 在 WorkBuddy 原生 Node 短进程内只读解密 access token，通过父进程管道交付。 */
import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BuildProtectionSchema,
  CredentialsSchema,
  DesktopLoginSchema,
  EnvelopeSchema,
  type Credentials,
} from "./schema.js";

/** 编码已知保护协议的长度前缀，返回用于 AES-GCM 完整性校验的字节。 */
function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** 按当前 WorkBuddy sym-v1 字段协议构造认证上下文；版本由 envelope 校验。 */
function fieldAad(keyId: string): Buffer {
  const suite = Buffer.alloc(4);
  suite.writeUInt32BE(1);
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suite,
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

/** 输入登录文件与应用保护材料，返回可用凭据；保护校验失败抛出错误。 */
export function decryptDesktopCredentials(
  login: unknown,
  build: unknown,
): Credentials {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const session = DesktopLoginSchema.parse(login);
    if (session.auth.expiresAt <= Date.now())
      throw new Error("WORKBUDDY_AUTH_EXPIRED");
    let accessToken: string;
    if (typeof session.auth.accessToken === "string") {
      accessToken = session.auth.accessToken;
    } else {
      const protection = BuildProtectionSchema.parse(build);
      key = createHash("sha256")
        .update(protection.atRestSecretKey, "utf8")
        .digest();
      const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
      const encoded = Buffer.from(session.auth.accessToken.envelope, "base64");
      if (encoded.toString("base64") !== session.auth.accessToken.envelope)
        throw new Error("invalid envelope");
      const envelope = EnvelopeSchema.parse(
        JSON.parse(encoded.toString("utf8")),
      );
      if (envelope.keyId !== keyId) throw new Error("key mismatch");
      const nonce = Buffer.from(envelope.nonce, "base64");
      const tag = Buffer.from(envelope.authTag, "base64");
      if (nonce.length !== 12 || tag.length !== 16)
        throw new Error("invalid GCM parameters");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(fieldAad(keyId));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      accessToken = plaintext.toString("utf8");
    }
    return CredentialsSchema.parse({
      accessToken,
      userId: session.account.uid,
      expiresAt: session.auth.expiresAt,
      ...(session.auth.domain === undefined
        ? {}
        : { domain: session.auth.domain }),
      ...(session.account.enterpriseId === undefined
        ? {}
        : { enterpriseId: session.account.enterpriseId }),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === "WORKBUDDY_AUTH_EXPIRED"
        ? error.message
        : "WORKBUDDY_AUTH_UNAVAILABLE",
    );
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}

/** 仅在 WorkBuddy 自带 Electron 中读取保护材料，输出交给父进程管道。 */
async function main(): Promise<void> {
  try {
    const authFile = z.string().min(1).parse(process.argv[2]);
    const linkedBinding = z
      .function({ input: [z.string()], output: z.unknown() })
      .parse(Reflect.get(process, "_linkedBinding"));
    const storage = z
      .object({ loggerGet: z.function({ input: [], output: z.string() }) })
      .parse(linkedBinding("electron_browser_workbuddy_storage"));
    const build: unknown = JSON.parse(storage.loggerGet());
    const login: unknown = JSON.parse(await readFile(authFile, "utf8"));
    process.stdout.write(
      JSON.stringify(decryptDesktopCredentials(login, build)),
    );
  } catch (error) {
    process.stderr.write(
      error instanceof Error && error.message === "WORKBUDDY_AUTH_EXPIRED"
        ? error.message
        : "WORKBUDDY_AUTH_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
