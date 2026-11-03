/** 增量 UTF-8/NDJSON 解码；跨包字符和行尾留存，历史 JSON 数组仅用于兼容回放。 */
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { CliEventSchema } from "./native-schema.js";
export class NativeDecoder {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  constructor(readonly receive: (event: unknown, raw: string) => void) {}
  push(bytes: Buffer): void {
    this.pending += this.decoder.write(bytes);
    this.lines();
  }
  private lines(): void {
    if (this.pending.length > 16_000_000)
      throw new LlmError(
        "WORKBUDDY_CLI_OUTPUT_LIMIT",
        "WORKBUDDY_CLI_OUTPUT_LIMIT",
      );
    if (this.pending.trimStart().startsWith("[")) return;
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (line) this.line(line);
    }
  }
  private line(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LlmError(
        "WORKBUDDY_CLI_INVALID_OUTPUT",
        "WORKBUDDY_CLI_INVALID_OUTPUT",
      );
    }
    this.receive(value, raw);
  }
  end(): void {
    this.pending += this.decoder.end();
    this.lines();
    const remaining = this.pending.trim();
    this.pending = "";
    if (!remaining) return;
    if (remaining.startsWith("[")) {
      let values;
      try {
        values = z.array(CliEventSchema).parse(JSON.parse(remaining));
      } catch {
        throw new LlmError("WORKBUDDY_CLI_PROTOCOL", "WORKBUDDY_CLI_PROTOCOL");
      }
      const start =
        values.findLastIndex((e) => e.type === "message" && e.role === "user") +
        1;
      for (const event of values.slice(start))
        this.receive(event, JSON.stringify(event));
    } else this.line(remaining);
  }
}
