import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
import type { AppConfig, ResolvedChannelConfig } from "./types.js";

export function parseConfig(toml: string): AppConfig {
  const raw = parse(toml) as Record<string, unknown>;

  const discord = raw.discord as Record<string, unknown> | undefined;
  if (!discord?.token || typeof discord.token !== "string") {
    throw new Error("Missing required: discord.token");
  }
  if (discord.token.trim().length === 0) {
    throw new Error("discord.token must not be empty");
  }

  const agents = raw.agents as Record<string, Record<string, unknown>> | undefined;
  if (!agents || Object.keys(agents).length === 0) {
    throw new Error("Missing required: at least one agent in [agents.*]");
  }

  const parsedAgents: AppConfig["agents"] = {};
  for (const [name, agent] of Object.entries(agents)) {
    // Validate command is a non-empty string
    if (!agent.command || typeof agent.command !== "string") {
      throw new Error(`agents.${name}.command must be a non-empty string`);
    }

    // Validate args is an array of strings
    if (agent.args !== undefined) {
      if (!Array.isArray(agent.args) || !agent.args.every((a: unknown) => typeof a === "string")) {
        throw new Error(`agents.${name}.args must be an array of strings`);
      }
    }

    // Validate idle_timeout is a positive number
    if (agent.idle_timeout !== undefined) {
      if (typeof agent.idle_timeout !== "number" || agent.idle_timeout <= 0) {
        throw new Error(`agents.${name}.idle_timeout must be a positive number`);
      }
    }

    // Validate cwd is a string if provided
    if (agent.cwd !== undefined && typeof agent.cwd !== "string") {
      throw new Error(`agents.${name}.cwd must be a string`);
    }

    // Validate discord_tools is a boolean if provided
    if (agent.discord_tools !== undefined && typeof agent.discord_tools !== "boolean") {
      throw new Error(`agents.${name}.discord_tools must be a boolean`);
    }

    // Validate scheduled_tasks is a boolean if provided
    if (agent.scheduled_tasks !== undefined && typeof agent.scheduled_tasks !== "boolean") {
      throw new Error(`agents.${name}.scheduled_tasks must be a boolean`);
    }

    parsedAgents[name] = {
      command: agent.command,
      args: (agent.args as string[]) ?? [],
      cwd: typeof agent.cwd === "string" ? agent.cwd : process.cwd(),
      idle_timeout: typeof agent.idle_timeout === "number" ? agent.idle_timeout : 600,
      discord_tools: agent.discord_tools === true,
      scheduled_tasks: agent.scheduled_tasks === true,
    };
  }

  const channels = (raw.channels ?? {}) as Record<string, Record<string, unknown>>;
  const parsedChannels: AppConfig["channels"] = {};
  for (const [id, ch] of Object.entries(channels)) {
    const agentRef = ch.agent ?? "default";
    if (typeof agentRef !== "string") {
      throw new Error(`channels.${id}.agent must be a string`);
    }
    if (!parsedAgents[agentRef]) {
      throw new Error(`channels.${id}.agent references unknown agent "${agentRef}"`);
    }
    if (ch.cwd !== undefined && typeof ch.cwd !== "string") {
      throw new Error(`channels.${id}.cwd must be a string`);
    }
    if (ch.auto_reply !== undefined && typeof ch.auto_reply !== "boolean") {
      throw new Error(`channels.${id}.auto_reply must be a boolean`);
    }
    if (ch.discord_tools !== undefined && typeof ch.discord_tools !== "boolean") {
      throw new Error(`channels.${id}.discord_tools must be a boolean`);
    }
    if (ch.scheduled_tasks !== undefined && typeof ch.scheduled_tasks !== "boolean") {
      throw new Error(`channels.${id}.scheduled_tasks must be a boolean`);
    }

    parsedChannels[id] = {
      agent: agentRef,
      cwd: ch.cwd ? String(ch.cwd) : undefined,
      auto_reply: ch.auto_reply === true,
      discord_tools: ch.discord_tools ?? undefined,
      scheduled_tasks: ch.scheduled_tasks ?? undefined,
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
    agentName: channelConf.agent,
    agent: {
      ...agentConf,
      cwd: channelConf.cwd ?? agentConf.cwd,
      discord_tools: channelConf.discord_tools ?? agentConf.discord_tools,
      scheduled_tasks: channelConf.scheduled_tasks ?? agentConf.scheduled_tasks,
    },
    autoReply: channelConf.auto_reply === true,
  };
}
