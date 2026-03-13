import { parse, stringify } from "smol-toml";
import { readFileSync, writeFileSync } from "node:fs";
import type { AppConfig, ChannelConfig, ResolvedChannelConfig } from "./types.js";

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

    parsedAgents[name] = {
      command: agent.command,
      args: (agent.args as string[]) ?? [],
      cwd: typeof agent.cwd === "string" ? agent.cwd : process.cwd(),
      idle_timeout: typeof agent.idle_timeout === "number" ? agent.idle_timeout : 600,
      discord_tools: agent.discord_tools === true,
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

    parsedChannels[id] = {
      agent: agentRef,
      cwd: ch.cwd ? String(ch.cwd) : undefined,
      auto_reply: ch.auto_reply === true,
      discord_tools: ch.discord_tools ?? undefined,
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

export function saveConfig(configPath: string, config: AppConfig): void {
  // Convert AppConfig to a plain object suitable for smol-toml stringify
  const tomlObj: Record<string, unknown> = {
    discord: { token: config.discord.token },
    agents: {} as Record<string, Record<string, unknown>>,
    channels: {} as Record<string, Record<string, unknown>>,
  };

  const agents = tomlObj.agents as Record<string, Record<string, unknown>>;
  for (const [name, agent] of Object.entries(config.agents)) {
    const a: Record<string, unknown> = {
      command: agent.command,
    };
    if (agent.args.length > 0) a.args = agent.args;
    if (agent.cwd !== process.cwd()) a.cwd = agent.cwd;
    if (agent.idle_timeout !== 600) a.idle_timeout = agent.idle_timeout;
    if (agent.discord_tools) a.discord_tools = agent.discord_tools;
    agents[name] = a;
  }

  const channels = tomlObj.channels as Record<string, Record<string, unknown>>;
  for (const [id, ch] of Object.entries(config.channels)) {
    const c: Record<string, unknown> = {
      agent: ch.agent,
    };
    if (ch.cwd !== undefined) c.cwd = ch.cwd;
    if (ch.auto_reply !== undefined) c.auto_reply = ch.auto_reply;
    if (ch.discord_tools !== undefined) c.discord_tools = ch.discord_tools;
    channels[id] = c;
  }

  const toml = stringify(tomlObj);
  writeFileSync(configPath, toml, "utf-8");
}

export function addChannelToConfig(
  configPath: string,
  channelId: string,
  channelConfig: ChannelConfig,
): AppConfig {
  const config = loadConfig(configPath);
  config.channels[channelId] = channelConfig;
  saveConfig(configPath, config);
  return config;
}

export function removeChannelFromConfig(
  configPath: string,
  channelId: string,
): AppConfig {
  const config = loadConfig(configPath);
  delete config.channels[channelId];
  saveConfig(configPath, config);
  return config;
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
    },
    autoReply: channelConf.auto_reply === true,
  };
}
