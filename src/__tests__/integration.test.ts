import { describe, it, expect } from "vitest";
import { parseConfig } from "../shared/config.js";
import { ChannelRouter } from "../daemon/channel-router.js";
import { splitMessage, formatToolSummary, type ToolStatus } from "../daemon/message-bridge.js";

const CONFIG = `
[discord]
token = "test-token"

[agents.default]
command = "echo"
args = ["hello"]
cwd = "/tmp"
idle_timeout = 10

[channels.100]
agent = "default"
`;

describe("integration: config → router → display", () => {
  it("routes configured channel to agent", () => {
    const config = parseConfig(CONFIG);
    const router = new ChannelRouter(config);
    expect(router.isConfigured("100")).toBe(true);
    expect(router.isConfigured("999")).toBe(false);

    const resolved = router.resolve("100");
    expect(resolved?.agent.command).toBe("echo");
  });

  it("formats tool summary correctly", () => {
    const tools = new Map<string, { title: string; status: ToolStatus }>();
    tools.set("1", { title: "Reading file.ts", status: "completed" });
    tools.set("2", { title: "Writing file.ts", status: "in_progress" });

    const summary = formatToolSummary(tools);
    expect(summary).toContain("\u2705 Reading file.ts");
    expect(summary).toContain("\uD83D\uDD04 Writing file.ts");
  });

  it("splits long messages correctly", () => {
    const long = "x".repeat(5000);
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(long);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});
