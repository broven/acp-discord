import { describe, it, expect } from "vitest";
import { KNOWN_AGENTS } from "../detect-agents.js";

describe("KNOWN_AGENTS", () => {
  it("has correct priority order", () => {
    const names = KNOWN_AGENTS.map((a) => a.name);
    expect(names).toEqual(["claude-code", "codex", "opencode", "pi"]);
  });

  it("each agent has command and acp package", () => {
    for (const agent of KNOWN_AGENTS) {
      expect(agent.command).toBeTruthy();
      expect(agent.acpPackage).toBeTruthy();
    }
  });
});
