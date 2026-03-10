import { describe, it, expect } from "vitest";
import { formatDiff } from "../message-bridge.js";
import type { DiffContent } from "../acp-client.js";

describe("formatDiff", () => {
  it("returns empty array for no diffs", () => {
    expect(formatDiff([])).toEqual([]);
  });

  it("formats a new file diff", () => {
    const diffs: DiffContent[] = [
      { path: "/project/src/hello.ts", oldText: null, newText: "console.log('hello');\n" },
    ];
    const result = formatDiff(diffs);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const joined = result.join("");
    expect(joined).toContain("**hello.ts**");
    expect(joined).toContain("```diff");
    expect(joined).toContain("+console.log('hello');");
    expect(joined).toContain("/dev/null");
  });

  it("formats a modified file diff", () => {
    const diffs: DiffContent[] = [
      {
        path: "/project/src/auth.ts",
        oldText: "const x = 1;\nconst y = 2;\n",
        newText: "const x = 1;\nconst y = 3;\n",
      },
    ];
    const result = formatDiff(diffs);
    const joined = result.join("");
    expect(joined).toContain("**auth.ts**");
    expect(joined).toContain("```diff");
    expect(joined).toContain("-const y = 2;");
    expect(joined).toContain("+const y = 3;");
  });

  it("truncates large diffs", () => {
    const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const newLines = Array.from({ length: 300 }, (_, i) => `changed ${i}`).join("\n");
    const diffs: DiffContent[] = [
      { path: "/project/big.txt", oldText: oldLines, newText: newLines },
    ];
    const result = formatDiff(diffs, 50);
    const joined = result.join("");
    expect(joined).toContain("more lines");
  });

  it("formats multiple file diffs", () => {
    const diffs: DiffContent[] = [
      { path: "/project/a.ts", oldText: "a\n", newText: "b\n" },
      { path: "/project/c.ts", oldText: null, newText: "new\n" },
    ];
    const result = formatDiff(diffs);
    const joined = result.join("");
    expect(joined).toContain("**a.ts**");
    expect(joined).toContain("**c.ts**");
  });

  it("splits long diffs into multiple messages", () => {
    const bigContent = Array.from({ length: 200 }, (_, i) => `const variable${i} = ${i};`).join("\n") + "\n";
    const diffs: DiffContent[] = [
      { path: "/project/huge.ts", oldText: null, newText: bigContent },
    ];
    const result = formatDiff(diffs);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be roughly within Discord limit (code fence closing may add a few chars)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2010);
    }
  });
});
