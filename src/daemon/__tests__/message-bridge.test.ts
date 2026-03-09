import { describe, it, expect } from "vitest";
import { splitMessage } from "../message-bridge.js";

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
