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
import { sendPermissionRequest } from "./permission-ui.js";
import { splitMessage, formatToolSummary, formatDiff, type ToolStatus } from "./message-bridge.js";
import type { AcpEventHandlers, DiffContent } from "./acp-client.js";

export async function startDiscordBot(config: AppConfig): Promise<void> {
  const router = new ChannelRouter(config);

  // Per-channel state for display
  const toolStates = new Map<string, Map<string, { title: string; status: ToolStatus }>>();
  const toolSummaryMessages = new Map<string, Message>();
  const replyBuffers = new Map<string, string>();
  const replyMessages = new Map<string, Message>();
  const flushTimers = new Map<string, NodeJS.Timeout>();
  // channelId -> toolCallId -> DiffContent[]
  const pendingDiffs = new Map<string, Map<string, DiffContent[]>>();

  let discordClient: Client;

  const handlers: AcpEventHandlers = {
    onToolCall(channelId, toolCallId, title, _kind, status, diffs) {
      if (!toolStates.has(channelId)) toolStates.set(channelId, new Map());
      toolStates.get(channelId)!.set(toolCallId, { title, status: status as ToolStatus });
      accumulateDiffs(channelId, toolCallId, diffs);
      updateToolSummaryMessage(channelId);
      if (status === "completed") sendDiffsForTool(channelId, toolCallId);
    },

    onToolCallUpdate(channelId, toolCallId, status, diffs) {
      const tools = toolStates.get(channelId);
      const tool = tools?.get(toolCallId);
      if (tool) {
        tool.status = status as ToolStatus;
        accumulateDiffs(channelId, toolCallId, diffs);
        updateToolSummaryMessage(channelId);
        if (status === "completed") sendDiffsForTool(channelId, toolCallId);
      }
    },

    onAgentMessageChunk(channelId, text) {
      const current = replyBuffers.get(channelId) ?? "";
      replyBuffers.set(channelId, current + text);
      scheduleFlushReply(channelId);
    },

    async onPermissionRequest(channelId, requestorId, toolCall, options) {
      const channel = await fetchChannel(channelId);
      if (!channel) return { outcome: "cancelled" as const };
      return sendPermissionRequest(channel, toolCall.title, toolCall.kind, options, requestorId);
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
      pendingDiffs.delete(channelId);
    },
  };

  const sessionManager = new SessionManager(handlers);

  // --- Display helpers ---

  function accumulateDiffs(channelId: string, toolCallId: string, diffs: DiffContent[]) {
    if (diffs.length === 0) return;
    if (!pendingDiffs.has(channelId)) pendingDiffs.set(channelId, new Map());
    const channelDiffs = pendingDiffs.get(channelId)!;
    const existing = channelDiffs.get(toolCallId) ?? [];
    channelDiffs.set(toolCallId, existing.concat(diffs));
  }

  async function sendDiffsForTool(channelId: string, toolCallId: string) {
    const channelDiffs = pendingDiffs.get(channelId);
    const diffs = channelDiffs?.get(toolCallId);
    if (!diffs || diffs.length === 0) return;

    const channel = await fetchChannel(channelId);
    if (!channel) return;

    const messages = formatDiff(diffs);
    for (const msg of messages) {
      await channel.send(msg);
    }

    channelDiffs!.delete(toolCallId);
  }

  async function fetchChannel(channelId: string): Promise<TextChannel | null> {
    const cached = discordClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (cached) return cached;
    try {
      const fetched = await discordClient.channels.fetch(channelId);
      return fetched as TextChannel;
    } catch {
      return null;
    }
  }

  async function updateToolSummaryMessage(channelId: string) {
    const tools = toolStates.get(channelId);
    if (!tools) return;

    const content = formatToolSummary(tools);
    const channel = await fetchChannel(channelId);
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

    const channel = await fetchChannel(channelId);
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

  discordClient.on(Events.ClientReady, async (c) => {
    console.log(`Discord bot ready: ${c.user.tag}`);

    // Register slash commands
    const askCommand = new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask the coding agent a question")
      .addStringOption((opt) =>
        opt.setName("message").setDescription("Your message").setRequired(true),
      );

    const clearCommand = new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear the agent session and start fresh");

    const rest = new REST().setToken(config.discord.token);
    try {
      await rest.put(Routes.applicationCommands(c.application.id), {
        body: [askCommand.toJSON(), clearCommand.toJSON()],
      });
      console.log("Registered /ask and /clear commands");
    } catch (err) {
      console.error("Failed to register commands:", err);
    }
  });

  // Handle @mention messages in configured channels
  discordClient.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const channelId = message.channelId;
    const resolved = router.resolve(channelId);
    if (!resolved) return;

    const isMention = message.mentions.has(discordClient.user!);
    if (!resolved.autoReply && !isMention) return;

    // Strip mention prefix if present
    const text = message.content.replace(/<@!?\d+>/g, "").trim();

    if (!text) {
      await message.reply("Please provide a message.");
      return;
    }

    if (sessionManager.isPrompting(channelId)) {
      await message.reply("\u23F3 Agent is working. Your message has been queued.");
    }

    try {
      await sessionManager.prompt(channelId, text, resolved.agent, message.author.id);
    } catch (err) {
      console.error(`Prompt failed for channel ${channelId}:`, err);
      await message.reply("An error occurred while processing your request.").catch(() => {});
    }
  });

  // Handle stop button clicks
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith("stop_")) {
      const channelId = interaction.customId.replace("stop_", "");
      const activeRequestor = sessionManager.getActiveRequestorId(channelId);

      // Only the user who triggered the current prompt can stop it
      if (activeRequestor && interaction.user.id !== activeRequestor) {
        await interaction.reply({ content: "Only the user who started this prompt can stop it.", ephemeral: true });
        return;
      }

      sessionManager.cancel(channelId);
      await interaction.update({ components: [] });
    }
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

    try {
      await sessionManager.prompt(channelId, text, resolved.agent, interaction.user.id);
    } catch (err) {
      console.error(`Prompt failed for channel ${channelId}:`, err);
      await interaction.followUp({ content: "An error occurred while processing your request.", ephemeral: true }).catch(() => {});
    }
  });

  // Handle /clear command
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "clear") return;

    const channelId = interaction.channelId;
    sessionManager.teardown(channelId);

    // Clean up display state
    toolStates.delete(channelId);
    toolSummaryMessages.delete(channelId);
    replyBuffers.delete(channelId);
    replyMessages.delete(channelId);
    const timer = flushTimers.get(channelId);
    if (timer) clearTimeout(timer);
    flushTimers.delete(channelId);

    await interaction.reply("Session cleared. Next message will start a fresh agent.");
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

  try {
    await discordClient.login(config.discord.token);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("TOKEN_INVALID") || message.includes("An invalid token was provided")) {
      console.error("Error: Invalid Discord bot token. Check your config.toml.");
    } else if (message.includes("ConnectTimeout") || message.includes("ETIMEDOUT") || message.includes("ECONNREFUSED")) {
      console.error("Error: Cannot connect to Discord API. Check your network or proxy settings.");
      console.error("Hint: Set HTTPS_PROXY=http://127.0.0.1:7890 if you need a proxy.");
    } else {
      console.error("Error: Failed to connect to Discord:", message);
    }
    process.exit(1);
  }
}
