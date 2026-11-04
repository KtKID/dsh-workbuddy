/** 使用 WB 实际 ACP 用量形状验证宿主统计，沿用官方 SDK 传输与 KMH 用量模型。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AcpOutput } from "../lib/acp-output.js";
import { nativeCompletion } from "../lib/native.js";
import {
  fixture,
  credentials,
  request,
  collect,
} from "./support/acp-fixture.mjs";

const updates = JSON.parse(
  await readFile(new URL("./fixtures/acp-usage.json", import.meta.url), "utf8"),
);
const expected = {
  inputTokens: 14241,
  outputTokens: 116,
  totalTokens: 46485,
  cacheReadTokens: 32128,
  cacheWriteTokens: 0,
  reasoningTokens: 71,
};
const push = (output, update) => output.push({ sessionId: "fixture", update });
const finish = (output, response = { stopReason: "end_turn" }) =>
  output.finish(response, false).find((c) => c.type === "usage")?.usage;
function replay(values) {
  const output = new AcpOutput();
  const chunks = values.flatMap((u) => push(output, u));
  return { output, chunks };
}

test("WB 实际双格式用量：两次模型调用完整汇总且相同调用去重", () => {
  const { output, chunks } = replay(updates);
  assert.deepEqual(finish(output), expected);
  assert.deepEqual(chunks.findLast((c) => c.type === "usage").usage, expected);
});

test("WB 重复通知保持幂等，等值的独立模型调用分别计入", () => {
  const { output } = replay([...updates, ...updates]);
  assert.deepEqual(finish(output), expected);
  const one = updates.slice(0, 3);
  const two = JSON.parse(
    JSON.stringify(one)
      .replaceAll("model-one", "model-another")
      .replaceAll("display-one", "display-another"),
  );
  assert.deepEqual(finish(replay([...one, ...two]).output), {
    inputTokens: 25762,
    outputTokens: 152,
    totalTokens: 45242,
    cacheReadTokens: 19328,
    cacheWriteTokens: 0,
    reasoningTokens: 86,
  });
});

for (const format of ["raw", "normalized"])
  test(`WB 仅 ${format} 通知也可透传`, () => {
    const values = updates.filter(
      (u) =>
        u.sessionUpdate !== "usage_update" ||
        (format === "raw"
          ? "prompt_tokens" in u._meta.usage
          : "inputTokens" in u._meta.usage),
    );
    const actual = finish(replay(values).output);
    assert.deepEqual(
      actual,
      format === "raw"
        ? expected
        : (({ cacheWriteTokens, ...rest }) => rest)(expected),
    );
  });

test("WB 同一调用更新快照只保留最新值，标准结束用量优先", () => {
  const partial = structuredClone(updates[2]);
  partial._meta.usage = {
    prompt_tokens: 22545,
    completion_tokens: 2,
    total_tokens: 22547,
  };
  const { output } = replay([updates[0], partial, ...updates.slice(1)]);
  assert.deepEqual(finish(output), expected);
  assert.deepEqual(
    finish(output, {
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 30,
        cachedWriteTokens: 10,
        thoughtTokens: 5,
      },
    }),
    {
      inputTokens: 60,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    },
  );
});

test("WB 缓存读写和思考分别映射，cache miss 保持未缓存输入", () => {
  const update = structuredClone(updates[2]);
  update._meta.usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 30,
    cache_creation_input_tokens: 10,
    prompt_cache_write_tokens: 10,
    prompt_cache_miss_tokens: 60,
    completion_thinking_tokens: 5,
  };
  assert.deepEqual(finish(replay([update]).output), {
    inputTokens: 60,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
  });
  delete update._meta.usage.cache_creation_input_tokens;
  delete update._meta.usage.prompt_cache_write_tokens;
  assert.deepEqual(finish(replay([update]).output), {
    inputTokens: 70,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 30,
    reasoningTokens: 5,
  });
});

test("上下文占用、无效统计与子代理通知保持独立", () => {
  const invalid = structuredClone(updates[2]);
  invalid._meta.usage.prompt_tokens = -1;
  const child = structuredClone(updates[2]);
  child._meta["codebuddy.ai/memberEvent"] = true;
  assert.equal(
    finish(
      replay([
        { sessionUpdate: "usage_update", used: 99999, size: 300000 },
        invalid,
        child,
      ]).output,
    ),
    undefined,
  );
});

test("官方 ACP 子进程透传 WB 通知，续聊排除历史用量回放", async (t) => {
  const { config, root } = await fixture(t, { mode: "usage" });
  const first = await collect(
    nativeCompletion(request, config, credentials, () => {}, undefined, root),
  );
  assert.deepEqual(first.findLast((c) => c.type === "usage").usage, expected);
  const source = {
    kind: "model",
    provider: "workbuddy",
    model: "fixture",
    replayState: first.at(-1).replayState,
  };
  const content = first
    .filter((c) => c.type === "block-end")
    .map((c) => c.block);
  const second = await collect(
    nativeCompletion(
      {
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant", content, source },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
      },
      config,
      credentials,
      () => {},
      undefined,
      root,
    ),
  );
  assert.deepEqual(second.findLast((c) => c.type === "usage").usage, expected);
  const calls = (await readFile(`${root}/requests.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter((c) => c.method === "load").length, 1);
});
