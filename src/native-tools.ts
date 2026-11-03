/** 将官方 CLI 文本中的完整 DSML 调用转为 KMH 工具块；保持审批与参数校验在宿主执行层。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LlmError, ToolCallId, type ToolCallBlock } from "@deepseek-ai/dsh-llm";

const Invoke = z.object({ name: z.string().min(1) });
const Parameter = z.object({
  name: z.string().min(1),
  string: z.enum(["true", "false"]),
  value: z.string(),
});
const Arguments = z.record(z.string(), z.unknown());
const marker = "<｜｜DSML｜｜";
const protocolError = () =>
  new LlmError(
    "WORKBUDDY_TOOL_PROTOCOL: 工具调用格式异常，请重新发送本轮请求。",
    "WORKBUDDY_TOOL_PROTOCOL",
  );

/** 输入模型本轮文本及获准工具名；返回正文与完整调用，损坏或未声明调用整批失败。代码引用保持原文。 */
export function nativeToolBlocks(text: string, declared: ReadonlySet<string>) {
  // 用等长空白遮蔽代码引用，保证示例中的调用标记不会触发执行。
  const visible = text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|`[^`\n]*`/g,
    (quoted) => " ".repeat(quoted.length),
  );
  const start = visible.indexOf(marker);
  if (start < 0) return { text, calls: [] };
  const prefix = text.slice(0, start).trimEnd();
  // 调用块占据回复尾部独立段；内联引用、残缺标记及额外尾文都显式失败。
  if (!/(?:^|\n)[ \t]*$/.test(text.slice(0, start))) throw protocolError();
  let rest = text.slice(start).trim();
  const take = (pattern: RegExp) => {
    const match = pattern.exec(rest);
    if (!match) throw protocolError();
    rest = rest.slice(match[0].length).trimStart();
    return match.groups;
  };
  take(/^<｜｜DSML｜｜ calls>/);
  const calls: ToolCallBlock[] = [];
  try {
    while (!rest.startsWith("</｜｜DSML｜｜ calls>")) {
      const invocation = Invoke.parse(
        take(/^<｜｜DSML｜｜ invoke name="(?<name>[^"<>]+)">/),
      );
      const name = declared.has(invocation.name)
        ? invocation.name
        : invocation.name.replace(/^mcp__kmh__/, "");
      if (!declared.has(name)) throw protocolError();
      const parameters = new Map<string, unknown>();
      while (!rest.startsWith("</｜｜DSML｜｜ invoke>")) {
        const param = Parameter.parse(
          take(
            /^<｜｜DSML｜｜ parameter name="(?<name>[^"<>]+)" string="(?<string>true|false)">(?<value>[\s\S]*?)<\/｜｜DSML｜｜ parameter>/,
          ),
        );
        if (
          parameters.has(param.name) ||
          ["__proto__", "prototype", "constructor"].includes(param.name) ||
          param.value.includes(marker)
        )
          throw protocolError();
        parameters.set(
          param.name,
          param.string === "true" ? param.value : JSON.parse(param.value),
        );
      }
      take(/^<\/｜｜DSML｜｜ invoke>/);
      calls.push({
        type: "tool-call",
        id: ToolCallId(randomUUID()),
        name,
        arguments: JSON.stringify(
          Arguments.parse(Object.fromEntries(parameters)),
        ),
      });
    }
    take(/^<\/｜｜DSML｜｜ calls>/);
    if (rest || !calls.length) throw protocolError();
  } catch {
    throw protocolError();
  }
  return { text: prefix, calls };
}
