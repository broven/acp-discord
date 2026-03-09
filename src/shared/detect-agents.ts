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
