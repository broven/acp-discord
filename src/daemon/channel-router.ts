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

  registerDynamic(channelId: string, agentName: string, autoReply: boolean): void {
    if (!this.config.agents[agentName]) {
      console.error(`Cannot register dynamic channel: unknown agent "${agentName}"`);
      return;
    }
    this.config.channels[channelId] = {
      agent: agentName,
      auto_reply: autoReply,
    };
  }

  unregisterDynamic(channelId: string): void {
    delete this.config.channels[channelId];
  }
}
