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
