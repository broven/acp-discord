import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
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
  const content = readFileSync(configPath, "utf-8");
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
