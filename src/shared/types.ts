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
