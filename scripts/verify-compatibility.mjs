/** 用固定依赖加载同一发行包并回归两套 DSH；失败保留隔离目录及命令诊断。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { z } from "zod";

const targetSchema = z.enum(["0.2.1-rc.2", "0.2.2-alpha.2"]);
const manifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    engines: z.object({ dsh: z.string() }),
    peerDependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
  })
  .passthrough();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = targetSchema.parse(process.argv[2]);
const archive = resolve(z.string().min(1).parse(process.argv[3]));
const source = manifestSchema.parse(
  JSON.parse(await readFile(join(root, "package.json"), "utf8")),
);
const fixture = await mkdtemp(join(tmpdir(), `workbuddy-compat-${target}-`));
const unpacked = join(fixture, "under-test");
const { NODE_V8_COVERAGE, ...childEnv } = process.env;

/** 输入命令、参数及可选环境覆盖；在隔离宿主执行，非零退出保留原始诊断。 */
function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: fixture,
    env: { ...childEnv, ...env },
    stdio: "inherit",
  });
}

console.log(`Compatibility target: ${target}\nFixture: ${fixture}`);
console.log(
  `Archive SHA256: ${createHash("sha256")
    .update(await readFile(archive))
    .digest("hex")}`,
);
await mkdir(unpacked);
run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1"]);
const packed = manifestSchema.parse(
  JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")),
);
assert.equal(packed.name, "dsh-workbuddy");
assert.equal(packed.version, source.version);
assert(
  semver.satisfies(target, packed.engines.dsh),
  `Package does not support DSH ${target}: ${packed.engines.dsh}`,
);
for (const [name, range] of Object.entries(packed.peerDependencies)) {
  if (name.startsWith("@deepseek-ai/dsh-")) {
    assert(
      semver.satisfies(target, range),
      `${name} does not support DSH ${target}: ${range}`,
    );
  }
}

const oldRuntime = target === "0.2.1-rc.2";
const devDependencies = { ...source.devDependencies };
for (const name of Object.keys(devDependencies)) {
  if (name.startsWith("@deepseek-ai/dsh-")) devDependencies[name] = target;
}
devDependencies["@deepseek-ai/cordis"] = oldRuntime ? "4.0.5" : "4.0.6-alpha.1";
if (oldRuntime) delete devDependencies["@deepseek-ai/dsh-tool-executor-native"];
assert(
  semver.satisfies(
    devDependencies["@deepseek-ai/cordis"],
    packed.peerDependencies["@deepseek-ai/cordis"],
  ),
);

const fixtureManifest = {
  ...source,
  private: true,
  devDependencies,
};
await writeFile(
  join(fixture, "package.json"),
  `${JSON.stringify(fixtureManifest, null, 2)}\n`,
);
for (const name of ["src", "test", "tsconfig.json", "pnpm-workspace.yaml"]) {
  await cp(join(root, name), join(fixture, name), { recursive: true });
}
await cp(
  join(
    root,
    oldRuntime ? "test/fixtures/dsh-0.2.1-rc.2-lock.yaml" : "pnpm-lock.yaml",
  ),
  join(fixture, "pnpm-lock.yaml"),
);
run("pnpm", [
  "install",
  "--frozen-lockfile",
  "--registry=https://registry.npmjs.org/",
]);
await symlink(join(unpacked, "lib"), join(fixture, "lib"), "dir");
run("pnpm", ["typecheck"]);
const tests = (await readdir(join(fixture, "test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));
run(process.execPath, ["--test", ...tests], {
  DSH_TEST_RUNTIME_VERSION: target,
  ...(NODE_V8_COVERAGE ? { NODE_V8_COVERAGE } : {}),
});
console.log(
  `Compatibility passed: ${packed.name}@${packed.version} on DSH ${target}`,
);
await rm(fixture, { recursive: true, force: true });
