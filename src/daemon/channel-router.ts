import type { AppConfig, ResolvedChannelConfig } from "../shared/types.js";
import { resolveChannelConfig } from "../shared/config.js";

export class ChannelRouter {
  private config: AppConfig;
  private dynamicChannels = new Map<string, { agentName: string; autoReply: boolean }>();

  constructor(config: AppConfig) {
    this.config = config;
  }

  resolve(channelId: string): ResolvedChannelConfig | null {
    return resolveChannelConfig(this.config, channelId);
  }

  isConfigured(channelId: string): boolean {
    return this.resolve(channelId) !== null;
  }

  registerDynamic(channelId: string, agentName: string, autoReply: boolean): void {
    if (!this.config.agents[agentName]) {
      console.error(`Cannot register dynamic channel: unknown agent "${agentName}"`);
      return;
    }
    this.dynamicChannels.set(channelId, { agentName, autoReply });
    // Merge into existing channel config to preserve cwd/discord_tools overrides
    const existing = this.config.channels[channelId];
    this.config.channels[channelId] = {
      ...existing,
      agent: agentName,
      auto_reply: autoReply,
    };
  }

  unregisterDynamic(channelId: string): void {
    this.dynamicChannels.delete(channelId);
    delete this.config.channels[channelId];
  }

  updateConfig(newConfig: AppConfig): void {
    this.config = newConfig;
    // Re-inject dynamic channels that aren't already in the new config
    for (const [channelId, { agentName, autoReply }] of this.dynamicChannels) {
      if (!this.config.channels[channelId] && this.config.agents[agentName]) {
        this.config.channels[channelId] = {
          agent: agentName,
          auto_reply: autoReply,
        };
      }
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }
}
