export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  idle_timeout: number;
  discord_tools: boolean;
}

export interface ChannelConfig {
  agent: string;
  cwd?: string; // override agent's default cwd
  auto_reply?: boolean; // respond to all messages, not just @mentions
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
  agentName: string;
  agent: AgentConfig;
  autoReply: boolean;
}
