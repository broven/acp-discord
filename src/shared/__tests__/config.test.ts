import { describe, it, expect } from "vitest";
import { parseConfig, resolveChannelConfig } from "../config.js";

const VALID_TOML = `
[discord]
token = "test-token"

[agents.default]
command = "npx"
args = ["@zed-industries/claude-agent-acp"]
cwd = "/home/user/project-a"
idle_timeout = 600

[agents.codex]
command = "npx"
args = ["@openai/codex-acp"]
cwd = "/home/user/project-b"
idle_timeout = 300

[channels.111]
agent = "default"

[channels.222]
agent = "codex"
cwd = "/tmp/override"
`;

describe("parseConfig", () => {
  it("parses valid TOML config", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.discord.token).toBe("test-token");
    expect(config.agents.default.command).toBe("npx");
    expect(config.agents.default.idle_timeout).toBe(600);
    expect(config.channels["111"].agent).toBe("default");
  });

  it("throws on missing discord.token", () => {
    expect(() => parseConfig("[discord]\n")).toThrow("token");
  });

  it("throws on missing agents", () => {
    expect(() => parseConfig('[discord]\ntoken = "t"\n')).toThrow("agents");
  });

  it("throws on missing agent command", () => {
    expect(() => parseConfig(`
[discord]
token = "t"
[agents.default]
args = ["foo"]
`)).toThrow("command");
  });

  it("throws on invalid args type", () => {
    expect(() => parseConfig(`
[discord]
token = "t"
[agents.default]
command = "npx"
args = "not-an-array"
`)).toThrow("args");
  });

  it("throws on negative idle_timeout", () => {
    expect(() => parseConfig(`
[discord]
token = "t"
[agents.default]
command = "npx"
idle_timeout = -1
`)).toThrow("idle_timeout");
  });

  it("throws on channel referencing unknown agent", () => {
    expect(() => parseConfig(`
[discord]
token = "t"
[agents.default]
command = "npx"
[channels.123]
agent = "nonexistent"
`)).toThrow("nonexistent");
  });
});

describe("resolveChannelConfig", () => {
  it("resolves channel to agent config", () => {
    const config = parseConfig(VALID_TOML);
    const resolved = resolveChannelConfig(config, "111");
    expect(resolved?.agent.command).toBe("npx");
    expect(resolved?.agent.cwd).toBe("/home/user/project-a");
  });

  it("applies channel cwd override", () => {
    const config = parseConfig(VALID_TOML);
    const resolved = resolveChannelConfig(config, "222");
    expect(resolved?.agent.cwd).toBe("/tmp/override");
  });

  it("returns null for unconfigured channel", () => {
    const config = parseConfig(VALID_TOML);
    expect(resolveChannelConfig(config, "999")).toBeNull();
  });
});
