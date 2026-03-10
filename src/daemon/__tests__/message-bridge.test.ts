import { describe, it, expect } from "vitest";
import { splitMessage, formatToolSummary, type ToolStatus } from "../message-bridge.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits at 2000 chars", () => {
    const long = "a".repeat(3500);
    const chunks = splitMessage(long);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeLessThanOrEqual(2000);
    expect(chunks[1].length).toBeLessThanOrEqual(2000);
    expect(chunks.join("")).toBe(long);
  });

  it("does not break code blocks", () => {
    const msg = "before\n```js\n" + "x\n".repeat(1000) + "```\nafter";
    const chunks = splitMessage(msg);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      // Each chunk should have balanced code fences (even number)
      expect(opens % 2).toBe(0);
    }
  });

  it("splits at newline boundaries when possible", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n");
    const chunks = splitMessage(lines);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join("")).toBe(lines);
  });
});

describe("formatToolSummary", () => {
  it("shows rawInput detail from known safe fields", () => {
    const tools = new Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>();
    tools.set("1", { title: "Read", status: "completed", rawInput: { file_path: "/src/index.ts" } });
    tools.set("2", { title: "Bash", status: "in_progress", rawInput: { command: "npm test" } });
    const result = formatToolSummary(tools);
    expect(result).toContain("/src/index.ts");
    expect(result).toContain("npm test");
  });

  it("shows no detail when rawInput is missing", () => {
    const tools = new Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>();
    tools.set("1", { title: "Read", status: "pending" });
    const result = formatToolSummary(tools);
    expect(result).not.toContain("·");
  });

  it("ignores unknown fields in rawInput", () => {
    const tools = new Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>();
    tools.set("1", { title: "Custom", status: "completed", rawInput: { secret_key: "abc123" } });
    const result = formatToolSummary(tools);
    expect(result).not.toContain("abc123");
  });

  it("sanitizes backticks in detail", () => {
    const tools = new Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>();
    tools.set("1", { title: "Bash", status: "in_progress", rawInput: { command: "echo `whoami`" } });
    const result = formatToolSummary(tools);
    expect(result).not.toContain("`whoami`");
    expect(result).toContain("'whoami'");
  });

  it("truncates long detail values", () => {
    const tools = new Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>();
    const longCmd = "a".repeat(200);
    tools.set("1", { title: "Bash", status: "in_progress", rawInput: { command: longCmd } });
    const result = formatToolSummary(tools);
    expect(result.length).toBeLessThan(200);
  });
});
