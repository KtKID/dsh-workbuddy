/** 为每个用例分配独立的 WB 应用目录，凭据与 ACP Agent 均使用本地夹具。 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../lib/schema.js";

export const credentials = {
  accessToken: "fixture-secret",
  userId: "fixture-user",
  expiresAt: Date.now() + 600000,
};
export const request = {
  provider: "workbuddy",
  model: "fixture",
  sessionId: "kmh-fixture",
  messages: [
    { role: "user", content: [{ type: "text", text: "fixture task" }] },
  ],
};
export async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}
export async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "wb-acp-"));
  let dispose = async () => {};
  t.after(async () => {
    try {
      await dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const cli = join(root, "Contents/Resources/app.asar.unpacked/cli/dist");
  await mkdir(cli, { recursive: true });
  await mkdir(join(root, "Contents/MacOS"), { recursive: true });
  const electronPath = join(root, "Contents/MacOS/Electron");
  await writeFile(
    electronPath,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify(credentials)}));`,
    { mode: 0o700 },
  );
  await writeFile(
    join(cli, "../product.json"),
    JSON.stringify({ productName: "WorkBuddy", genieVersion: "5.8.3" }),
  );
  await writeFile(
    join(cli, "../package.json"),
    JSON.stringify({ version: "2.161.0" }),
  );
  await writeFile(
    join(cli, "codebuddy-lite-wb.mjs"),
    `import {serve} from ${JSON.stringify(new URL("./acp-agent.mjs", import.meta.url).href)};await serve(${JSON.stringify({ root, ...settings })});`,
  );
  return {
    root,
    config: ConfigSchema.parse({ electronPath, timeoutMs: 20 }),
    beforeRemove: (close) => {
      dispose = close;
    },
  };
}
