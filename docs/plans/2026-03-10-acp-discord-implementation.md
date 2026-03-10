# acp-discord Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Discord bot that wraps ACP protocol, letting users interact with coding agents in Discord channels.

**Architecture:** CLI entry (`npx acp-discord`) dispatches to `init` (ACP-agent-driven setup wizard) or `daemon` subcommands (start/stop/status/enable/disable). The daemon runs a Discord.js client that bridges Discord messages to ACP agent subprocesses — one per channel session, managed with idle timeouts.

**Tech Stack:** TypeScript 5.x, Node.js 18+, discord.js v14, @agentclientprotocol/sdk, smol-toml, commander, tsup, vitest

**Design Doc:** `docs/plans/2026-03-10-acp-discord-design.md`

**ACP Reference:** `.local/docs/acp_guide.md` — read sections 3, 4, 8, 9 for SDK usage, message flow, tool call lifecycle, permission model

**Discord Reference:** `.local/docs/discord_bot.md` — read for discord.js patterns, button interactions, embed construction

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

**Step 1: Initialize package.json**

```bash
cd /Users/metajs/.superset/projects/acp-discord
pnpm init
```

Then edit `package.json` to:

```json
{
  "name": "acp-discord",
  "version": "0.1.0",
  "description": "Discord bot that wraps ACP protocol for coding agents",
  "type": "module",
  "bin": {
    "acp-discord": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT"
}
```

**Step 2: Install dependencies**

```bash
pnpm add discord.js @agentclientprotocol/sdk commander smol-toml
pnpm add -D typescript tsx tsup vitest @types/node
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

**Step 5: Create minimal src/index.ts**

```typescript
console.log("acp-discord");
```

**Step 6: Verify build works**

```bash
pnpm build && node dist/index.js
```

Expected: prints `acp-discord`

**Step 7: Verify tests work**

```bash
pnpm test
```

Expected: no tests found, exits cleanly

**Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsup.config.ts src/index.ts
git commit -m "chore: project scaffolding"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/shared/types.ts`

**Step 1: Define config and agent types**

```typescript
export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  idle_timeout: number;
}

export interface ChannelConfig {
  agent: string;
  cwd?: string; // override agent's default cwd
}

export interface DiscordConfig {
  token: string;
}

export interface AppConfig {
  discord: DiscordConfig;
  agents: Record<string, AgentConfig>;
  channels: Record<string, ChannelConfig>;
}

export interface ResolvedChannelConfig {
  channelId: string;
  agent: AgentConfig;
}
```

**Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add shared type definitions"
```

---

### Task 3: Config Parsing

**Files:**
- Create: `src/shared/config.ts`
- Create: `src/shared/__tests__/config.test.ts`

**Step 1: Write the test**

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
pnpm test
```

Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
import { parse } from "smol-toml";
import type { AppConfig, ResolvedChannelConfig } from "./types.js";

export function parseConfig(toml: string): AppConfig {
  const raw = parse(toml) as Record<string, unknown>;

  const discord = raw.discord as Record<string, unknown> | undefined;
  if (!discord?.token || typeof discord.token !== "string") {
    throw new Error("Missing required: discord.token");
  }

  const agents = raw.agents as Record<string, Record<string, unknown>> | undefined;
  if (!agents || Object.keys(agents).length === 0) {
    throw new Error("Missing required: at least one agent in [agents.*]");
  }

  const parsedAgents: AppConfig["agents"] = {};
  for (const [name, agent] of Object.entries(agents)) {
    parsedAgents[name] = {
      command: String(agent.command ?? ""),
      args: (agent.args as string[]) ?? [],
      cwd: String(agent.cwd ?? process.cwd()),
      idle_timeout: Number(agent.idle_timeout ?? 600),
    };
  }

  const channels = (raw.channels ?? {}) as Record<string, Record<string, unknown>>;
  const parsedChannels: AppConfig["channels"] = {};
  for (const [id, ch] of Object.entries(channels)) {
    parsedChannels[id] = {
      agent: String(ch.agent ?? "default"),
      cwd: ch.cwd ? String(ch.cwd) : undefined,
    };
  }

  return {
    discord: { token: String(discord.token) },
    agents: parsedAgents,
    channels: parsedChannels,
  };
}

export function loadConfig(configPath: string): AppConfig {
  const fs = await import("node:fs");
  const content = fs.readFileSync(configPath, "utf-8");
  return parseConfig(content);
}

export function resolveChannelConfig(
  config: AppConfig,
  channelId: string,
): ResolvedChannelConfig | null {
  const channelConf = config.channels[channelId];
  if (!channelConf) return null;

  const agentConf = config.agents[channelConf.agent];
  if (!agentConf) return null;

  return {
    channelId,
    agent: {
      ...agentConf,
      cwd: channelConf.cwd ?? agentConf.cwd,
    },
  };
}
```

Note: `loadConfig` uses top-level await import — change to sync:

```typescript
import { readFileSync } from "node:fs";

export function loadConfig(configPath: string): AppConfig {
  const content = readFileSync(configPath, "utf-8");
  return parseConfig(content);
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test
```

Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add src/shared/config.ts src/shared/__tests__/config.test.ts
git commit -m "feat: config parsing with TOML support"
```

---

### Task 4: Agent Detection

**Files:**
- Create: `src/shared/detect-agents.ts`
- Create: `src/shared/__tests__/detect-agents.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { KNOWN_AGENTS, type AgentInfo } from "../detect-agents.js";

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
```

**Step 2: Run test to verify it fails**

```bash
pnpm test
```

**Step 3: Write implementation**

```typescript
import { execFileSync } from "node:child_process";

export interface AgentInfo {
  name: string;
  command: string;
  acpPackage: string;
  detectCommand: string;
  detectArgs: string[];
}

export const KNOWN_AGENTS: AgentInfo[] = [
  {
    name: "claude-code",
    command: "npx",
    acpPackage: "@zed-industries/claude-agent-acp",
    detectCommand: "claude",
    detectArgs: ["--version"],
  },
  {
    name: "codex",
    command: "npx",
    acpPackage: "@openai/codex-acp",
    detectCommand: "codex",
    detectArgs: ["--version"],
  },
  {
    name: "opencode",
    command: "npx",
    acpPackage: "@opencode/acp",
    detectCommand: "opencode",
    detectArgs: ["--version"],
  },
  {
    name: "pi",
    command: "npx",
    acpPackage: "@anthropic-ai/pi-acp",
    detectCommand: "pi",
    detectArgs: ["--version"],
  },
];

export function detectInstalledAgents(): AgentInfo[] {
  const found: AgentInfo[] = [];
  for (const agent of KNOWN_AGENTS) {
    try {
      execFileSync(agent.detectCommand, agent.detectArgs, {
        stdio: "ignore",
        timeout: 5000,
      });
      found.push(agent);
    } catch {
      // not installed
    }
  }
  return found;
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/detect-agents.ts src/shared/__tests__/detect-agents.test.ts
git commit -m "feat: detect installed ACP-compatible agents"
```

---

### Task 5: CLI Skeleton

**Files:**
- Modify: `src/index.ts`
- Create: `src/cli/index.ts`
- Create: `src/cli/daemon.ts`
- Create: `src/cli/init.ts`

**Step 1: Create CLI entry with commander**

`src/cli/index.ts`:

```typescript
import { Command } from "commander";
import { makeDaemonCommand } from "./daemon.js";
import { makeInitCommand } from "./init.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("acp-discord")
    .description("Discord bot for ACP coding agents")
    .version("0.1.0");

  program.addCommand(makeInitCommand());
  program.addCommand(makeDaemonCommand());

  return program;
}
```

**Step 2: Create daemon subcommand**

`src/cli/daemon.ts`:

```typescript
import { Command } from "commander";

export function makeDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the acp-discord daemon");

  daemon
    .command("start")
    .description("Start the daemon")
    .action(async () => {
      console.log("TODO: daemon start");
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      console.log("TODO: daemon stop");
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      console.log("TODO: daemon status");
    });

  daemon
    .command("enable")
    .description("Enable auto-start on boot")
    .action(async () => {
      console.log("TODO: daemon enable");
    });

  daemon
    .command("disable")
    .description("Disable auto-start on boot")
    .action(async () => {
      console.log("TODO: daemon disable");
    });

  return daemon;
}
```

**Step 3: Create init subcommand stub**

`src/cli/init.ts`:

```typescript
import { Command } from "commander";

export function makeInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup wizard")
    .action(async () => {
      console.log("TODO: init wizard");
    });
}
```

**Step 4: Update src/index.ts**

```typescript
import { createCli } from "./cli/index.js";

createCli().parse();
```

**Step 5: Verify CLI works**

```bash
pnpm dev -- --help
pnpm dev -- daemon --help
pnpm dev -- init
```

Expected: help text shows commands; `init` prints "TODO: init wizard"

**Step 6: Commit**

```bash
git add src/index.ts src/cli/
git commit -m "feat: CLI skeleton with commander"
```

---

### Task 6: Daemon PID Management

**Files:**
- Create: `src/cli/pid.ts`
- Create: `src/cli/__tests__/pid.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePid, readPid, removePid, isDaemonRunning } from "../pid.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-pid-test");
const PID_PATH = join(TEST_DIR, "daemon.pid");

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("PID management", () => {
  it("writes and reads PID", () => {
    writePid(PID_PATH, 12345);
    expect(readPid(PID_PATH)).toBe(12345);
  });

  it("returns null when no PID file", () => {
    expect(readPid(PID_PATH)).toBeNull();
  });

  it("removes PID file", () => {
    writePid(PID_PATH, 12345);
    removePid(PID_PATH);
    expect(existsSync(PID_PATH)).toBe(false);
  });

  it("detects current process as running", () => {
    writePid(PID_PATH, process.pid);
    expect(isDaemonRunning(PID_PATH)).toBe(true);
  });

  it("detects stale PID as not running", () => {
    writePid(PID_PATH, 999999);
    expect(isDaemonRunning(PID_PATH)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test
```

**Step 3: Write implementation**

```typescript
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writePid(pidPath: string, pid: number): void {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(pid), "utf-8");
}

export function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const content = readFileSync(pidPath, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removePid(pidPath: string): void {
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

export function isDaemonRunning(pidPath: string): boolean {
  const pid = readPid(pidPath);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test
```

Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add src/cli/pid.ts src/cli/__tests__/pid.test.ts
git commit -m "feat: daemon PID file management"
```

---

### Task 7: Daemon Start/Stop/Status

**Files:**
- Modify: `src/cli/daemon.ts`
- Create: `src/daemon/index.ts`

Daemon start forks itself in detached mode. The forked child runs the Discord bot.

**Step 1: Create daemon entry point**

`src/daemon/index.ts`:

```typescript
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../shared/config.js";
import { writePid } from "../cli/pid.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export async function runDaemon(): Promise<void> {
  writePid(PID_PATH, process.pid);

  const config = loadConfig(CONFIG_PATH);
  console.log(`acp-discord daemon started (PID: ${process.pid})`);
  console.log(`Watching ${Object.keys(config.channels).length} channel(s)`);

  // TODO: Task 9+ will add Discord client + session manager here

  // Keep process alive
  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    process.exit(0);
  });
}

// When run as forked child
if (process.env.ACP_DISCORD_DAEMON === "1") {
  runDaemon().catch((err) => {
    console.error("Daemon failed:", err);
    process.exit(1);
  });
}
```

**Step 2: Implement daemon start/stop/status in CLI**

Update `src/cli/daemon.ts`:

```typescript
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDaemonRunning, readPid, removePid } from "./pid.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export function makeDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the acp-discord daemon");

  daemon
    .command("start")
    .description("Start the daemon")
    .action(async () => {
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon already running (PID: ${pid})`);
        process.exit(1);
      }
      removePid(PID_PATH); // clean stale

      const daemonEntry = fileURLToPath(new URL("../daemon/index.js", import.meta.url));
      const child = fork(daemonEntry, [], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ACP_DISCORD_DAEMON: "1" },
      });

      child.unref();
      console.log(`Daemon started (PID: ${child.pid})`);
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const pid = readPid(PID_PATH);
      if (pid === null) {
        console.log("Daemon is not running");
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        removePid(PID_PATH);
        console.log(`Daemon stopped (PID: ${pid})`);
      } catch {
        removePid(PID_PATH);
        console.log("Daemon was not running (stale PID removed)");
      }
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon is running (PID: ${pid})`);
      } else {
        removePid(PID_PATH);
        console.log("Daemon is not running");
      }
    });

  daemon
    .command("enable")
    .description("Enable auto-start on boot")
    .action(async () => {
      console.log("TODO: enable auto-start");
    });

  daemon
    .command("disable")
    .description("Disable auto-start on boot")
    .action(async () => {
      console.log("TODO: disable auto-start");
    });

  return daemon;
}
```

**Step 3: Verify daemon start/stop/status work**

First create a minimal config:

```bash
mkdir -p ~/.acp-discord
cat > ~/.acp-discord/config.toml << 'EOF'
[discord]
token = "test-token"

[agents.default]
command = "npx"
args = ["@zed-industries/claude-agent-acp"]
cwd = "/tmp"
idle_timeout = 600

[channels.123]
agent = "default"
EOF
```

Then:

```bash
pnpm dev -- daemon start
pnpm dev -- daemon status
pnpm dev -- daemon stop
pnpm dev -- daemon status
```

Expected: start → "Daemon started (PID: xxx)", status → running, stop → stopped, status → not running

**Step 4: Commit**

```bash
git add src/cli/daemon.ts src/daemon/index.ts
git commit -m "feat: daemon start/stop/status with PID management"
```

---

### Task 8: ACP Client Implementation

**Files:**
- Create: `src/daemon/acp-client.ts`

This is the core ACP Client interface that handles session updates and permission requests. It bridges ACP events to callbacks that the Discord layer will consume.

**Step 1: Implement ACP Client**

```typescript
import type * as acp from "@agentclientprotocol/sdk";

export interface AcpEventHandlers {
  onToolCall(channelId: string, toolCallId: string, title: string, kind: string, status: string): void;
  onToolCallUpdate(channelId: string, toolCallId: string, status: string): void;
  onAgentMessageChunk(channelId: string, text: string): void;
  onPermissionRequest(
    channelId: string,
    toolCall: { toolCallId: string; title: string; kind: string },
    options: Array<{ optionId: string; name: string; kind: string }>,
  ): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>;
  onPromptComplete(channelId: string, stopReason: string): void;
}

export function createAcpClient(
  channelId: string,
  handlers: AcpEventHandlers,
): acp.Client {
  return {
    async requestPermission(params) {
      const result = await handlers.onPermissionRequest(
        channelId,
        {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? "Unknown",
          kind: params.toolCall.kind ?? "other",
        },
        params.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      );
      return { outcome: result };
    },

    sessionUpdate(params) {
      const update = params.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          if (update.content.type === "text") {
            handlers.onAgentMessageChunk(channelId, update.content.text);
          }
          break;
        }
        case "tool_call": {
          handlers.onToolCall(
            channelId,
            update.toolCallId,
            update.title ?? "Unknown",
            update.kind ?? "other",
            update.status ?? "pending",
          );
          break;
        }
        case "tool_call_update": {
          handlers.onToolCallUpdate(
            channelId,
            update.toolCallId,
            update.status ?? "in_progress",
          );
          break;
        }
      }
    },
  };
}
```

**Step 2: Verify it compiles**

```bash
pnpm build
```

Expected: no type errors

**Step 3: Commit**

```bash
git add src/daemon/acp-client.ts
git commit -m "feat: ACP Client interface implementation"
```

---

### Task 9: Session Manager

**Files:**
- Create: `src/daemon/session-manager.ts`

Manages channel → ACP session mapping, agent process lifecycle, idle timeout.

**Step 1: Implement SessionManager**

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../shared/types.js";
import { createAcpClient, type AcpEventHandlers } from "./acp-client.js";

interface ManagedSession {
  channelId: string;
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  lastActivity: number;
  idleTimer: NodeJS.Timeout;
  prompting: boolean;
  queue: string[];
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private handlers: AcpEventHandlers;

  constructor(handlers: AcpEventHandlers) {
    this.handlers = handlers;
  }

  async prompt(channelId: string, text: string, agentConfig: AgentConfig): Promise<string> {
    const session = await this.getOrCreate(channelId, agentConfig);
    session.lastActivity = Date.now();
    this.resetIdleTimer(session, agentConfig.idle_timeout);

    if (session.prompting) {
      session.queue.push(text);
      return "queued";
    }

    return this.executePrompt(session, text, agentConfig);
  }

  private async executePrompt(session: ManagedSession, text: string, agentConfig: AgentConfig): Promise<string> {
    session.prompting = true;
    try {
      const result = await session.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.handlers.onPromptComplete(session.channelId, result.stopReason);
      return result.stopReason;
    } finally {
      session.prompting = false;
      // Process queue
      const next = session.queue.shift();
      if (next) {
        this.executePrompt(session, next, agentConfig);
      }
    }
  }

  cancel(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (session) {
      session.connection.cancel({ sessionId: session.sessionId });
    }
  }

  private async getOrCreate(channelId: string, agentConfig: AgentConfig): Promise<ManagedSession> {
    const existing = this.sessions.get(channelId);
    if (existing) return existing;
    return this.createSession(channelId, agentConfig);
  }

  private async createSession(channelId: string, config: AgentConfig): Promise<ManagedSession> {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: config.cwd,
    });

    proc.on("exit", (code) => {
      const session = this.sessions.get(channelId);
      if (session?.process === proc) {
        this.sessions.delete(channelId);
        clearTimeout(session.idleTimer);
      }
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!),
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );

    const client = createAcpClient(channelId, this.handlers);
    const connection = new acp.ClientSideConnection((_agent) => client, stream);

    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: "acp-discord",
        title: "ACP Discord Bot",
        version: "0.1.0",
      },
    });

    const { sessionId } = await connection.newSession({
      cwd: config.cwd,
      mcpServers: [],
    });

    const managed: ManagedSession = {
      channelId,
      process: proc,
      connection,
      sessionId,
      lastActivity: Date.now(),
      idleTimer: this.startIdleTimer(channelId, config.idle_timeout),
      prompting: false,
      queue: [],
    };

    this.sessions.set(channelId, managed);
    return managed;
  }

  private startIdleTimer(channelId: string, timeoutSec: number): NodeJS.Timeout {
    return setTimeout(() => this.teardown(channelId), timeoutSec * 1000);
  }

  private resetIdleTimer(session: ManagedSession, timeoutSec: number): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = this.startIdleTimer(session.channelId, timeoutSec);
  }

  teardown(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.process.kill();
    this.sessions.delete(channelId);
  }

  teardownAll(): void {
    for (const channelId of this.sessions.keys()) {
      this.teardown(channelId);
    }
  }

  isPrompting(channelId: string): boolean {
    return this.sessions.get(channelId)?.prompting ?? false;
  }

  getActiveChannels(): string[] {
    return Array.from(this.sessions.keys());
  }
}
```

**Step 2: Verify it compiles**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/daemon/session-manager.ts
git commit -m "feat: session manager with process lifecycle and idle timeout"
```

---

### Task 10: Message Bridge (Text Splitting + Debounce)

**Files:**
- Create: `src/daemon/message-bridge.ts`
- Create: `src/daemon/__tests__/message-bridge.test.ts`

**Step 1: Write the test for text splitting**

```typescript
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
      // or properly opened/closed
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
```

**Step 2: Run test to verify it fails**

```bash
pnpm test
```

**Step 3: Write implementation**

```typescript
const DISCORD_MAX_LENGTH = 2000;

export function splitMessage(text: string, maxLength = DISCORD_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeFence = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find split point: prefer newline before maxLength
    let splitAt = maxLength;
    const lastNewline = remaining.lastIndexOf("\n", maxLength);
    if (lastNewline > maxLength * 0.5) {
      splitAt = lastNewline + 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Handle code blocks: count fences in this chunk
    const fenceMatches = chunk.match(/```\w*/g) || [];
    for (const fence of fenceMatches) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fence;
      } else {
        inCodeBlock = false;
        codeFence = "";
      }
    }

    // If we're inside a code block at the split, close and reopen
    if (inCodeBlock) {
      chunk += "\n```";
      remaining = codeFence + "\n" + remaining;
      inCodeBlock = false;
      codeFence = "";
    }

    chunks.push(chunk);
  }

  return chunks;
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

const STATUS_ICONS: Record<ToolStatus, string> = {
  pending: "\u23F3",     // ⏳
  in_progress: "\uD83D\uDD04", // 🔄
  completed: "\u2705",   // ✅
  failed: "\u274C",      // ❌
};

export function formatToolSummary(
  tools: Map<string, { title: string; status: ToolStatus }>,
): string {
  const lines: string[] = [];
  for (const [, tool] of tools) {
    lines.push(`${STATUS_ICONS[tool.status]} ${tool.title}`);
  }
  return lines.join("\n");
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test
```

**Step 5: Commit**

```bash
git add src/daemon/message-bridge.ts src/daemon/__tests__/message-bridge.test.ts
git commit -m "feat: message splitting and tool summary formatting"
```

---

### Task 11: Permission UI

**Files:**
- Create: `src/daemon/permission-ui.ts`

**Step 1: Implement permission button builder**

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextChannel,
  type Message,
} from "discord.js";

const KIND_LABELS: Record<string, string> = {
  allow_once: "\u2705 Allow",
  allow_always: "\u2705 Always Allow",
  reject_once: "\u274C Reject",
  reject_always: "\u274C Never Allow",
};

const KIND_STYLES: Record<string, ButtonStyle> = {
  allow_once: ButtonStyle.Success,
  allow_always: ButtonStyle.Success,
  reject_once: ButtonStyle.Danger,
  reject_always: ButtonStyle.Danger,
};

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export async function sendPermissionRequest(
  channel: TextChannel,
  toolTitle: string,
  toolKind: string,
  options: PermissionOption[],
  timeoutMs = 14 * 60 * 1000,
): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }> {
  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`Permission: ${toolTitle}`)
    .setDescription(`Tool type: \`${toolKind}\``)
    .setTimestamp();

  const buttons = options.map((opt) =>
    new ButtonBuilder()
      .setCustomId(`perm_${opt.optionId}`)
      .setLabel(KIND_LABELS[opt.kind] ?? opt.name)
      .setStyle(KIND_STYLES[opt.kind] ?? ButtonStyle.Secondary),
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  const msg = await channel.send({ embeds: [embed], components: [row] });

  return new Promise((resolve) => {
    const collector = msg.createMessageComponentCollector({ time: timeoutMs });

    collector.on("collect", async (interaction) => {
      const optionId = interaction.customId.replace("perm_", "");
      await interaction.update({ components: [] }); // disable buttons
      collector.stop("selected");
      resolve({ outcome: "selected", optionId });
    });

    collector.on("end", (_collected, reason) => {
      if (reason === "time") {
        msg.edit({ components: [] }).catch(() => {});
        resolve({ outcome: "cancelled" });
      }
    });
  });
}
```

**Step 2: Verify it compiles**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/daemon/permission-ui.ts
git commit -m "feat: permission request buttons UI"
```

---

### Task 12: Discord Bot Core — Triggers + Message Handling

**Files:**
- Create: `src/daemon/discord-bot.ts`
- Create: `src/daemon/channel-router.ts`
- Modify: `src/daemon/index.ts`

**Step 1: Create channel router**

`src/daemon/channel-router.ts`:

```typescript
import type { AppConfig, ResolvedChannelConfig } from "../shared/types.js";
import { resolveChannelConfig } from "../shared/config.js";

export class ChannelRouter {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  resolve(channelId: string): ResolvedChannelConfig | null {
    return resolveChannelConfig(this.config, channelId);
  }

  isConfigured(channelId: string): boolean {
    return this.resolve(channelId) !== null;
  }
}
```

**Step 2: Create Discord bot with message handling**

`src/daemon/discord-bot.ts`:

```typescript
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type TextChannel,
} from "discord.js";
import type { AppConfig } from "../shared/types.js";
import { ChannelRouter } from "./channel-router.js";
import { SessionManager } from "./session-manager.js";
import { sendPermissionRequest, type PermissionOption } from "./permission-ui.js";
import { splitMessage, formatToolSummary, type ToolStatus } from "./message-bridge.js";
import type { AcpEventHandlers } from "./acp-client.js";

export async function startDiscordBot(config: AppConfig): Promise<void> {
  const router = new ChannelRouter(config);

  // Per-channel state for display
  const toolStates = new Map<string, Map<string, { title: string; status: ToolStatus }>>();
  const toolSummaryMessages = new Map<string, Message>();
  const replyBuffers = new Map<string, string>();
  const replyMessages = new Map<string, Message>();
  const flushTimers = new Map<string, NodeJS.Timeout>();

  // Pending permission resolvers
  const pendingPermissions = new Map<
    string,
    (result: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }) => void
  >();

  let discordClient: Client;

  const handlers: AcpEventHandlers = {
    onToolCall(channelId, toolCallId, title, kind, status) {
      if (!toolStates.has(channelId)) toolStates.set(channelId, new Map());
      toolStates.get(channelId)!.set(toolCallId, { title, status: status as ToolStatus });
      updateToolSummaryMessage(channelId);
    },

    onToolCallUpdate(channelId, toolCallId, status) {
      const tools = toolStates.get(channelId);
      const tool = tools?.get(toolCallId);
      if (tool) {
        tool.status = status as ToolStatus;
        updateToolSummaryMessage(channelId);
      }
    },

    onAgentMessageChunk(channelId, text) {
      const current = replyBuffers.get(channelId) ?? "";
      replyBuffers.set(channelId, current + text);
      scheduleFlushReply(channelId);
    },

    async onPermissionRequest(channelId, toolCall, options) {
      const channel = discordClient.channels.cache.get(channelId) as TextChannel | undefined;
      if (!channel) return { outcome: "cancelled" as const };
      return sendPermissionRequest(channel, toolCall.title, toolCall.kind, options);
    },

    onPromptComplete(channelId, _stopReason) {
      // Final flush
      flushReply(channelId, true);
      // Remove stop button from tool summary
      removeStopButton(channelId);
      // Clear state for next turn
      toolStates.delete(channelId);
      toolSummaryMessages.delete(channelId);
      replyBuffers.delete(channelId);
      replyMessages.delete(channelId);
    },
  };

  const sessionManager = new SessionManager(handlers);

  // --- Display helpers ---

  async function updateToolSummaryMessage(channelId: string) {
    const tools = toolStates.get(channelId);
    if (!tools) return;

    const content = formatToolSummary(tools);
    const channel = discordClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;

    const stopButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`stop_${channelId}`)
        .setLabel("\u23F9 Stop")
        .setStyle(ButtonStyle.Secondary),
    );

    const existing = toolSummaryMessages.get(channelId);
    if (existing) {
      await existing.edit({ content, components: [stopButton] }).catch(() => {});
    } else {
      const msg = await channel.send({ content, components: [stopButton] });
      toolSummaryMessages.set(channelId, msg);
    }
  }

  async function removeStopButton(channelId: string) {
    const msg = toolSummaryMessages.get(channelId);
    if (msg) {
      const tools = toolStates.get(channelId);
      const content = tools ? formatToolSummary(tools) : msg.content;
      await msg.edit({ content, components: [] }).catch(() => {});
    }
  }

  function scheduleFlushReply(channelId: string) {
    if (flushTimers.has(channelId)) return;
    flushTimers.set(
      channelId,
      setTimeout(() => {
        flushTimers.delete(channelId);
        flushReply(channelId, false);
      }, 500),
    );
  }

  async function flushReply(channelId: string, final: boolean) {
    const timer = flushTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(channelId);
    }

    const buffer = replyBuffers.get(channelId);
    if (!buffer) return;

    const channel = discordClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;

    if (final) {
      // Send final reply as new message(s), delete streaming message
      const existing = replyMessages.get(channelId);
      if (existing) await existing.delete().catch(() => {});
      replyMessages.delete(channelId);

      const chunks = splitMessage(buffer);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
      replyBuffers.delete(channelId);
    } else {
      // Streaming update: edit existing message
      const truncated = buffer.length > 2000 ? buffer.slice(buffer.length - 1900) + "..." : buffer;
      const existing = replyMessages.get(channelId);
      if (existing) {
        await existing.edit(truncated).catch(() => {});
      } else {
        const msg = await channel.send(truncated);
        replyMessages.set(channelId, msg);
      }
    }
  }

  // --- Discord client setup ---

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.on(Events.ClientReady, (c) => {
    console.log(`Discord bot ready: ${c.user.tag}`);
  });

  // Handle @mention and regular messages in configured channels
  discordClient.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const channelId = message.channelId;
    const resolved = router.resolve(channelId);
    if (!resolved) return;

    const isMention = message.mentions.has(discordClient.user!);
    // In configured channels, respond to @mention or any message
    // For @mention, strip the mention prefix
    let text = message.content;
    if (isMention) {
      text = text.replace(/<@!?\d+>/g, "").trim();
    } else {
      // Only respond to @mention in channels (not every message)
      // Unless user sent /ask command — handled separately
      return;
    }

    if (!text) {
      await message.reply("Please provide a message.");
      return;
    }

    if (sessionManager.isPrompting(channelId)) {
      await message.reply("\u23F3 Agent is working. Your message has been queued.");
    }

    await sessionManager.prompt(channelId, text, resolved.agent);
  });

  // Handle stop button clicks
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith("stop_")) {
      const channelId = interaction.customId.replace("stop_", "");
      sessionManager.cancel(channelId);
      await interaction.update({ components: [] });
    }
  });

  // Register /ask slash command
  const askCommand = new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the coding agent a question")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Your message").setRequired(true),
    );

  const rest = new REST().setToken(config.discord.token);
  await rest.put(Routes.applicationCommands(discordClient.application?.id ?? ""), {
    body: [askCommand.toJSON()],
  });

  // Handle /ask command
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "ask") return;

    const channelId = interaction.channelId;
    const resolved = router.resolve(channelId);
    if (!resolved) {
      await interaction.reply({ content: "This channel is not configured for ACP.", ephemeral: true });
      return;
    }

    const text = interaction.options.getString("message", true);
    await interaction.deferReply();

    if (sessionManager.isPrompting(channelId)) {
      await interaction.editReply("\u23F3 Agent is working. Your message has been queued.");
    } else {
      await interaction.editReply(`\uD83D\uDCAC Processing: ${text.slice(0, 100)}...`);
    }

    await sessionManager.prompt(channelId, text, resolved.agent);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sessionManager.teardownAll();
    discordClient.destroy();
  });

  process.on("SIGINT", () => {
    sessionManager.teardownAll();
    discordClient.destroy();
  });

  await discordClient.login(config.discord.token);
}
```

**Step 3: Update daemon entry to use Discord bot**

`src/daemon/index.ts`:

```typescript
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../shared/config.js";
import { writePid, removePid } from "../cli/pid.js";
import { startDiscordBot } from "./discord-bot.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export async function runDaemon(): Promise<void> {
  writePid(PID_PATH, process.pid);
  console.log(`acp-discord daemon started (PID: ${process.pid})`);

  const config = loadConfig(CONFIG_PATH);
  console.log(`Loaded config: ${Object.keys(config.channels).length} channel(s)`);

  process.on("exit", () => removePid(PID_PATH));

  await startDiscordBot(config);
}

if (process.env.ACP_DISCORD_DAEMON === "1") {
  runDaemon().catch((err) => {
    console.error("Daemon failed:", err);
    process.exit(1);
  });
}
```

**Step 4: Verify it compiles**

```bash
pnpm build
```

**Step 5: Commit**

```bash
git add src/daemon/discord-bot.ts src/daemon/channel-router.ts src/daemon/index.ts
git commit -m "feat: Discord bot with @mention, /ask, stop button, streaming replies"
```

---

### Task 13: Init Wizard

**Files:**
- Modify: `src/cli/init.ts`

**Step 1: Implement init with agent detection + ACP-driven setup**

```typescript
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { detectInstalledAgents } from "../shared/detect-agents.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

const INIT_SYSTEM_PROMPT = `You are a setup assistant for acp-discord, a Discord bot that connects Discord channels to ACP coding agents.

Your job is to help the user configure ~/.acp-discord/config.toml interactively.

You need to collect:
1. Discord Bot Token (guide them to https://discord.com/developers/applications if needed)
2. Default working directory (the project path the agent will work on)
3. Channel IDs to bind (explain how to get channel IDs: right-click channel → Copy Channel ID)

Once you have all info, write the config file using the write_text_file tool to ${CONFIG_PATH}.

Config format (TOML):
\`\`\`toml
[discord]
token = "<token>"

[agents.default]
command = "npx"
args = ["<acp-package>"]
cwd = "<working-directory>"
idle_timeout = 600

[channels.<channel-id>]
agent = "default"
\`\`\`

Be friendly and concise. Ask one question at a time.`;

export function makeInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup wizard")
    .action(async () => {
      console.log("Welcome to acp-discord setup!\n");

      // Detect agents
      console.log("Detecting ACP-compatible agents...");
      const agents = detectInstalledAgents();

      if (agents.length === 0) {
        console.error("No ACP-compatible agents found.");
        console.error("Install one of: claude-code, codex, opencode, pi");
        process.exit(1);
      }

      for (const agent of agents) {
        console.log(`  \u2713 ${agent.name} (found)`);
      }

      const selected = agents[0];
      console.log(`\nUsing: ${selected.name}\n`);
      console.log("Starting setup agent...\n");

      // Spawn ACP agent for interactive setup
      const proc = spawn(selected.command, [selected.acpPackage], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      const stream = acp.ndJsonStream(
        Writable.toWeb(proc.stdin!),
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );

      // Simple readline for user input
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const askUser = (prompt: string): Promise<string> =>
        new Promise((resolve) => rl.question(prompt, resolve));

      // Collect agent output
      let agentBuffer = "";

      const client: acp.Client = {
        async requestPermission(params) {
          // Auto-allow file writes during setup
          const allowOption = params.options.find((o) => o.kind === "allow_once");
          return {
            outcome: {
              outcome: "selected",
              optionId: allowOption?.optionId ?? params.options[0].optionId,
            },
          };
        },
        sessionUpdate(params) {
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            process.stdout.write(update.content.text);
            agentBuffer += update.content.text;
          }
        },
      };

      const connection = new acp.ClientSideConnection((_agent) => client, stream);

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "acp-discord-init", title: "ACP Discord Init", version: "0.1.0" },
      });

      mkdirSync(CONFIG_DIR, { recursive: true });

      const { sessionId } = await connection.newSession({
        cwd: CONFIG_DIR,
        mcpServers: [],
      });

      // Initial prompt
      await connection.prompt({
        sessionId,
        prompt: [
          { type: "text", text: INIT_SYSTEM_PROMPT },
          { type: "text", text: `The ACP agent package is: ${selected.acpPackage}\nPlease start the setup.` },
        ],
      });

      // Interactive loop
      while (true) {
        const input = await askUser("\n> ");
        if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") break;

        agentBuffer = "";
        const result = await connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: input }],
        });

        if (result.stopReason === "end_turn" && existsSync(CONFIG_PATH)) {
          // Check if config was written
          try {
            const content = readFileSync(CONFIG_PATH, "utf-8");
            if (content.includes("[discord]")) {
              console.log("\n\nSetup complete! Config written to", CONFIG_PATH);
              console.log("Run `npx acp-discord daemon start` to begin.");
              break;
            }
          } catch {}
        }
      }

      rl.close();
      proc.kill();
    });
}
```

**Step 2: Verify it compiles**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/cli/init.ts
git commit -m "feat: init wizard with ACP agent-driven setup"
```

---

### Task 14: Daemon Enable/Disable

**Files:**
- Create: `src/cli/autostart.ts`
- Modify: `src/cli/daemon.ts`

**Step 1: Implement autostart for systemd and launchd**

`src/cli/autostart.ts`:

```typescript
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = "acp-discord.service";
const LAUNCHD_DIR = join(homedir(), "Library", "LaunchAgents");
const LAUNCHD_PLIST = "com.acp-discord.plist";

function getNodePath(): string {
  return execSync("which node", { encoding: "utf-8" }).trim();
}

function getNpxPath(): string {
  return execSync("which npx", { encoding: "utf-8" }).trim();
}

export function enableAutostart(): void {
  const os = platform();

  if (os === "linux") {
    mkdirSync(SYSTEMD_DIR, { recursive: true });
    const npx = getNpxPath();
    const service = `[Unit]
Description=acp-discord daemon
After=network.target

[Service]
ExecStart=${npx} acp-discord daemon start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
    const servicePath = join(SYSTEMD_DIR, SYSTEMD_SERVICE);
    writeFileSync(servicePath, service);
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    console.log(`Enabled systemd service: ${servicePath}`);
    console.log("Run: systemctl --user start acp-discord");
  } else if (os === "darwin") {
    mkdirSync(LAUNCHD_DIR, { recursive: true });
    const npx = getNpxPath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.acp-discord</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npx}</string>
    <string>acp-discord</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), ".acp-discord", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".acp-discord", "daemon.error.log")}</string>
</dict>
</plist>`;
    const plistPath = join(LAUNCHD_DIR, LAUNCHD_PLIST);
    writeFileSync(plistPath, plist);
    console.log(`Enabled launchd service: ${plistPath}`);
    console.log("Run: launchctl load " + plistPath);
  } else {
    console.error(`Auto-start not supported on ${os}. Use your OS service manager manually.`);
  }
}

export function disableAutostart(): void {
  const os = platform();

  if (os === "linux") {
    const servicePath = join(SYSTEMD_DIR, SYSTEMD_SERVICE);
    try {
      execSync(`systemctl --user disable ${SYSTEMD_SERVICE}`);
    } catch {}
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execSync("systemctl --user daemon-reload");
    console.log("Disabled systemd auto-start");
  } else if (os === "darwin") {
    const plistPath = join(LAUNCHD_DIR, LAUNCHD_PLIST);
    try {
      execSync(`launchctl unload ${plistPath}`);
    } catch {}
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log("Disabled launchd auto-start");
  } else {
    console.error(`Auto-start not supported on ${os}.`);
  }
}
```

**Step 2: Wire into daemon.ts**

Update the `enable` and `disable` actions in `src/cli/daemon.ts`:

```typescript
import { enableAutostart, disableAutostart } from "./autostart.js";

// ... in makeDaemonCommand():
  daemon
    .command("enable")
    .description("Enable auto-start on boot")
    .action(async () => {
      enableAutostart();
    });

  daemon
    .command("disable")
    .description("Disable auto-start on boot")
    .action(async () => {
      disableAutostart();
    });
```

**Step 3: Verify it compiles**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add src/cli/autostart.ts src/cli/daemon.ts
git commit -m "feat: daemon enable/disable auto-start (systemd + launchd)"
```

---

### Task 15: Slash Command Registration

**Files:**
- Modify: `src/daemon/discord-bot.ts`

The `/ask` slash command registration should happen at bot startup, using the bot's application ID from the ready event.

**Step 1: Fix command registration timing**

Move the `rest.put` call into the `ClientReady` handler where `client.application.id` is available:

```typescript
discordClient.on(Events.ClientReady, async (c) => {
  console.log(`Discord bot ready: ${c.user.tag}`);

  const askCommand = new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the coding agent a question")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Your message").setRequired(true),
    );

  const rest = new REST().setToken(config.discord.token);
  try {
    await rest.put(Routes.applicationCommands(c.application.id), {
      body: [askCommand.toJSON()],
    });
    console.log("Registered /ask command");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});
```

Remove the earlier registration code that was outside the ready handler.

**Step 2: Verify it compiles**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/daemon/discord-bot.ts
git commit -m "fix: register slash commands after bot ready"
```

---

### Task 16: Integration Test — Full Flow

**Files:**
- Create: `src/__tests__/integration.test.ts`

This test verifies the config → channel router → session manager wiring without real Discord/ACP connections.

**Step 1: Write integration test**

```typescript
import { describe, it, expect } from "vitest";
import { parseConfig, resolveChannelConfig } from "../shared/config.js";
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
```

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests PASS

**Step 3: Commit**

```bash
git add src/__tests__/integration.test.ts
git commit -m "test: integration test for config → router → display pipeline"
```

---

### Task 17: Final Build & Verification

**Step 1: Clean build**

```bash
rm -rf dist && pnpm build
```

Expected: builds successfully, no type errors

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests pass

**Step 3: Test CLI help**

```bash
node dist/index.js --help
node dist/index.js daemon --help
node dist/index.js init --help
```

Expected: all help text displays correctly

**Step 4: Verify npx simulation**

```bash
node dist/index.js daemon status
```

Expected: "Daemon is not running"

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: final build verification"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Project scaffolding | package.json, tsconfig.json, tsup.config.ts |
| 2 | Shared types | src/shared/types.ts |
| 3 | Config parsing | src/shared/config.ts + tests |
| 4 | Agent detection | src/shared/detect-agents.ts + tests |
| 5 | CLI skeleton | src/cli/index.ts, daemon.ts, init.ts |
| 6 | PID management | src/cli/pid.ts + tests |
| 7 | Daemon start/stop/status | src/cli/daemon.ts, src/daemon/index.ts |
| 8 | ACP Client | src/daemon/acp-client.ts |
| 9 | Session Manager | src/daemon/session-manager.ts |
| 10 | Message Bridge | src/daemon/message-bridge.ts + tests |
| 11 | Permission UI | src/daemon/permission-ui.ts |
| 12 | Discord Bot Core | src/daemon/discord-bot.ts, channel-router.ts |
| 13 | Init Wizard | src/cli/init.ts |
| 14 | Autostart | src/cli/autostart.ts |
| 15 | Slash Command Registration | src/daemon/discord-bot.ts fix |
| 16 | Integration Test | src/__tests__/integration.test.ts |
| 17 | Final Verification | build + test + CLI check |
