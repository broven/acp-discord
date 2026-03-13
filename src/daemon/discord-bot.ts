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
  EmbedBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import { resolve as resolvePath, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../shared/types.js";
import { ChannelRouter } from "./channel-router.js";
import { SessionManager, type McpServerConfig } from "./session-manager.js";
import { sendPermissionRequest } from "./permission-ui.js";
import { splitMessage, formatToolSummary, formatDiff, type ToolStatus } from "./message-bridge.js";
import type { AcpEventHandlers, DiffContent } from "./acp-client.js";
import { IpcServer, DEFAULT_IPC_SOCKET_PATH } from "./ipc-server.js";
import { TaskScheduler } from "./task-scheduler.js";
import { runTask } from "./task-runner.js";

export async function startDiscordBot(config: AppConfig, sessionsPath: string): Promise<void> {
  const router = new ChannelRouter(config);

  // Per-channel state for display
  const toolStates = new Map<string, Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>>();
  const toolSummaryMessages = new Map<string, Message>();
  const replyBuffers = new Map<string, string>();
  const replyMessages = new Map<string, Message>();
  const flushTimers = new Map<string, NodeJS.Timeout>();
  // channelId -> toolCallId -> DiffContent[]
  const pendingDiffs = new Map<string, Map<string, DiffContent[]>>();
  // channelId -> Set of toolCallIds whose diffs were already shown at permission-request time
  const permissionDiffShown = new Map<string, Set<string>>();

  // Typing indicator state: channelId -> interval timer
  const typingIntervals = new Map<string, NodeJS.Timeout>();

  function startTyping(channelId: string) {
    if (typingIntervals.has(channelId)) return;
    // Set a placeholder immediately to prevent concurrent calls from creating duplicate intervals
    const placeholder = setTimeout(() => {}, 0);
    typingIntervals.set(channelId, placeholder);
    clearTimeout(placeholder);

    fetchChannel(channelId).then((channel) => {
      if (!channel) { typingIntervals.delete(channelId); return; }
      // Re-check: stopTyping may have been called while we awaited
      if (!typingIntervals.has(channelId)) return;
      channel.sendTyping().catch(() => {});
      const interval = setInterval(() => {
        channel.sendTyping().catch(() => {});
      }, 8000);
      typingIntervals.set(channelId, interval);
    }).catch(() => {
      typingIntervals.delete(channelId);
    });
  }

  function stopTyping(channelId: string) {
    const interval = typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(channelId);
    }
  }

  let discordClient: Client;

  // --- Confirmation UI for MCP tool actions ---

  // Pending confirmation requests from MCP servers (requestId -> { resolver, allowedUserId })
  const pendingConfirmations = new Map<string, { resolve: (approved: boolean) => void; allowedUserId: string | null }>();

  async function handleConfirmAction(sourceChannelId: string, description: string, details: string): Promise<boolean> {
    const channel = await fetchChannel(sourceChannelId);
    if (!channel) return false;

    // Only the user who triggered the current prompt can approve
    const allowedUserId = sessionManager.getActiveRequestorId(sourceChannelId);

    const requestId = `mcp_confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle(`Channel Action: ${description}`)
      .setDescription(details || "No additional details")
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mcp_approve_${requestId}`)
        .setLabel("\u2705 Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`mcp_reject_${requestId}`)
        .setLabel("\u274C Reject")
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        pendingConfirmations.delete(requestId);
        msg.delete().catch(() => msg.edit({ components: [] }).catch(() => {}));
        resolve(false);
      }, 5 * 60 * 1000); // 5 minute timeout

      pendingConfirmations.set(requestId, {
        resolve: (approved: boolean) => {
          clearTimeout(timeout);
          pendingConfirmations.delete(requestId);
          msg.delete().catch(() => msg.edit({ components: [] }).catch(() => {}));
          resolve(approved);
        },
        allowedUserId,
      });
    });
  }

  // --- IPC Server ---

  // --- Task Scheduler ---

  const taskScheduler = new TaskScheduler(async (task) => {
    const resolved = router.resolve(task.channel_id);
    if (!resolved) {
      console.error(`TaskScheduler: no resolved config for channel ${task.channel_id}`);
      taskScheduler.logRun(task.id, {
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 0,
        status: "error",
        output: "",
        error: `No resolved config for channel ${task.channel_id}`,
      });
      return;
    }

    const channel = await fetchChannel(task.channel_id);
    const guildId = channel?.guild?.id ?? null;
    const mcpServers = guildId ? buildMcpServers(task.channel_id, task.agent_name, guildId) : [];

    const startedAt = new Date();
    const result = await runTask(resolved.agent, task.prompt, mcpServers);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    taskScheduler.logRun(task.id, {
      startedAt,
      completedAt,
      durationMs,
      status: result.error ? "error" : "success",
      output: result.output,
      error: result.error,
    });

    const shouldNotify =
      task.notify === "always" ||
      (task.notify === "on_error" && result.error);

    if (shouldNotify && channel) {
      const text = result.error ?? result.output;
      const chunks = splitMessage(text || "(no output)");
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  });

  const ipcServer = new IpcServer(
    {
      registerChannel(channelId, agentName, autoReply) {
        router.registerDynamic(channelId, agentName, autoReply);
        console.log(`IPC: registered dynamic channel ${channelId} -> agent ${agentName}`);
      },
      unregisterChannel(channelId) {
        router.unregisterDynamic(channelId);
        console.log(`IPC: unregistered dynamic channel ${channelId}`);
      },
      confirmAction: handleConfirmAction,
      createTask(params) {
        try {
          const task = taskScheduler.createTask(params as Parameters<typeof taskScheduler.createTask>[0]);
          return { task };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      listTasks(channelId) {
        return { tasks: taskScheduler.listTasks(channelId) };
      },
      updateTask(taskId, updates, channelId) {
        const task = taskScheduler.updateTask(taskId, updates, channelId);
        if (!task) return { error: `Task ${taskId} not found` };
        return { task };
      },
      deleteTask(taskId, channelId) {
        const deleted = taskScheduler.deleteTask(taskId, channelId);
        if (!deleted) return { error: `Task ${taskId} not found` };
        return { deleted: true };
      },
      getTaskLogs(taskId, channelId) {
        return { logs: taskScheduler.getTaskLogs(taskId, channelId) };
      },
    },
    DEFAULT_IPC_SOCKET_PATH,
  );

  const handlers: AcpEventHandlers = {
    onToolCall(channelId, toolCallId, title, _kind, status, diffs, rawInput) {
      if (!toolStates.has(channelId)) toolStates.set(channelId, new Map());
      toolStates.get(channelId)!.set(toolCallId, { title, status: status as ToolStatus, rawInput });
      accumulateDiffs(channelId, toolCallId, diffs);
      updateToolSummaryMessage(channelId);
      if (status === "completed") sendDiffsForTool(channelId, toolCallId);
    },

    onToolCallUpdate(channelId, toolCallId, status, diffs, rawInput) {
      const tools = toolStates.get(channelId);
      const tool = tools?.get(toolCallId);
      if (tool) {
        tool.status = status as ToolStatus;
        if (rawInput && !tool.rawInput) tool.rawInput = rawInput;
        accumulateDiffs(channelId, toolCallId, diffs);
        updateToolSummaryMessage(channelId);
        if (status === "completed") sendDiffsForTool(channelId, toolCallId);
      }
    },

    onAgentMessageChunk(channelId, text) {
      startTyping(channelId);
      const current = replyBuffers.get(channelId) ?? "";
      replyBuffers.set(channelId, current + text);
      scheduleFlushReply(channelId);
    },

    async onPermissionRequest(channelId, requestorId, toolCall, options, diffs) {
      const channel = await fetchChannel(channelId);
      if (!channel) return { outcome: "cancelled" as const };
      const result = await sendPermissionRequest(channel, toolCall.title, toolCall.kind, options, requestorId, diffs);
      if (result.diffsSent) {
        if (!permissionDiffShown.has(channelId)) permissionDiffShown.set(channelId, new Set());
        permissionDiffShown.get(channelId)!.add(toolCall.toolCallId);
      }
      return result;
    },

    onPromptComplete(channelId, _stopReason) {
      stopTyping(channelId);
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
      permissionDiffShown.delete(channelId);
    },
  };

  const sessionManager = new SessionManager(handlers, sessionsPath);

  // --- MCP server config builder ---

  function buildMcpServers(channelId: string, agentName: string, guildId: string): McpServerConfig[] {
    const resolved = router.resolve(channelId);
    const discordToolsEnabled = resolved?.agent.discord_tools ?? false;
    const scheduledTasksEnabled = resolved?.agent.scheduled_tasks ?? false;
    console.log(`[MCP] buildMcpServers: channel=${channelId} agent=${agentName} discord_tools=${discordToolsEnabled} scheduled_tasks=${scheduledTasksEnabled}`);

    const mcpConfig: McpServerConfig[] = [];

    // Resolve the built MCP server script path relative to this package
    // import.meta.dirname is available in Node 21.2+; fall back to fileURLToPath for Node 18
    const currentDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

    if (discordToolsEnabled) {
      const mcpScriptPath = resolvePath(currentDir, "mcp-discord-channels.js");
      const scriptExists = existsSync(mcpScriptPath);

      console.log(`[MCP] buildMcpServers: mcpScriptPath=${mcpScriptPath} exists=${scriptExists}`);
      if (!scriptExists) {
        console.warn(`[MCP] WARNING: MCP script not found at ${mcpScriptPath} — Discord tools will not work`);
      }

      mcpConfig.push({
        name: "discord-channels",
        command: "node",
        args: [mcpScriptPath],
        env: [
          { name: "DISCORD_TOKEN", value: config.discord.token },
          { name: "GUILD_ID", value: guildId },
          { name: "IPC_SOCKET_PATH", value: DEFAULT_IPC_SOCKET_PATH },
          { name: "AGENT_NAME", value: agentName },
          { name: "SOURCE_CHANNEL_ID", value: channelId },
        ],
      });
    }

    if (scheduledTasksEnabled) {
      const tasksMcpPath = resolvePath(currentDir, "mcp-scheduled-tasks.js");
      const tasksScriptExists = existsSync(tasksMcpPath);

      console.log(`[MCP] buildMcpServers: tasksMcpPath=${tasksMcpPath} exists=${tasksScriptExists}`);
      if (!tasksScriptExists) {
        console.warn(`[MCP] WARNING: MCP script not found at ${tasksMcpPath} — Scheduled tasks tools will not work`);
      } else {
        mcpConfig.push({
          name: "scheduled-tasks",
          command: "node",
          args: [tasksMcpPath],
          env: [
            { name: "IPC_SOCKET_PATH", value: DEFAULT_IPC_SOCKET_PATH },
            { name: "AGENT_NAME", value: agentName },
            { name: "SOURCE_CHANNEL_ID", value: channelId },
          ],
        });
      }
    }

    console.log(`[MCP] buildMcpServers: returning ${mcpConfig.length} MCP server(s):`, JSON.stringify(mcpConfig.map(s => ({ name: s.name, command: s.command, args: s.args }))));
    return mcpConfig;
  }

  // --- Display helpers ---

  function accumulateDiffs(channelId: string, toolCallId: string, diffs: DiffContent[]) {
    if (diffs.length === 0) return;
    if (!pendingDiffs.has(channelId)) pendingDiffs.set(channelId, new Map());
    const channelDiffs = pendingDiffs.get(channelId)!;
    const existing = channelDiffs.get(toolCallId) ?? [];
    channelDiffs.set(toolCallId, existing.concat(diffs));
  }

  async function sendDiffsForTool(channelId: string, toolCallId: string) {
    // Skip if diffs were already shown at permission-request time
    const shownSet = permissionDiffShown.get(channelId);
    if (shownSet?.has(toolCallId)) {
      shownSet.delete(toolCallId);
      pendingDiffs.get(channelId)?.delete(toolCallId);
      return;
    }

    const channelDiffs = pendingDiffs.get(channelId);
    const diffs = channelDiffs?.get(toolCallId);
    if (!diffs || diffs.length === 0) return;

    const channel = await fetchChannel(channelId);
    if (!channel) return;

    const messages = formatDiff(diffs);
    for (const msg of messages) {
      await channel.send({ content: msg, allowedMentions: { parse: [] as const } });
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

    const noMentions = { parse: [] as const };
    const existing = toolSummaryMessages.get(channelId);
    if (existing) {
      await existing.edit({ content, components: [stopButton], allowedMentions: noMentions }).catch(() => {});
    } else {
      const msg = await channel.send({ content, components: [stopButton], allowedMentions: noMentions });
      toolSummaryMessages.set(channelId, msg);
    }
  }

  async function removeStopButton(channelId: string) {
    const msg = toolSummaryMessages.get(channelId);
    if (msg) {
      const tools = toolStates.get(channelId);
      const content = tools ? formatToolSummary(tools) : msg.content;
      await msg.edit({ content, components: [], allowedMentions: { parse: [] as const } }).catch(() => {});
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

  // --- Helper: resolve guild ID from a channel ---

  function getGuildId(message: Message): string | null {
    return message.guildId ?? null;
  }

  // --- Helper: prompt with MCP servers ---

  async function promptWithMcp(channelId: string, text: string, agentName: string, guildId: string | null, agentConfig: typeof config.agents[string], requestorId: string): Promise<void> {
    const mcpServers = guildId ? buildMcpServers(channelId, agentName, guildId) : undefined;
    await sessionManager.prompt(channelId, text, agentName, agentConfig, requestorId, mcpServers);
  }

  // --- Discord client setup ---

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.on("error", (err) => {
    console.error("Discord client error:", err);
  });

  discordClient.on("warn", (msg) => {
    console.warn("Discord client warning:", msg);
  });

  discordClient.on("shardDisconnect", (event, shardId) => {
    console.warn(`Shard ${shardId} disconnected (code: ${event.code})`);
  });

  discordClient.on("shardReconnecting", (shardId) => {
    console.log(`Shard ${shardId} reconnecting...`);
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
      await promptWithMcp(channelId, text, resolved.agentName, getGuildId(message), resolved.agent, message.author.id);
    } catch (err) {
      stopTyping(channelId);
      console.error(`Prompt failed for channel ${channelId}:`, err);
      await message.reply("An error occurred while processing your request.").catch(() => {});
    }
  });

  // Handle stop button clicks and MCP confirmation buttons
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

    // Handle MCP confirmation buttons
    if (interaction.customId.startsWith("mcp_approve_") || interaction.customId.startsWith("mcp_reject_")) {
      const approved = interaction.customId.startsWith("mcp_approve_");
      const requestId = interaction.customId.replace(/^mcp_(approve|reject)_/, "");
      const pending = pendingConfirmations.get(requestId);
      if (pending) {
        // Only the user who triggered the prompt can approve/reject
        if (pending.allowedUserId && interaction.user.id !== pending.allowedUserId) {
          await interaction.reply({ content: "Only the user who started this prompt can approve or reject.", ephemeral: true });
          return;
        }
        await interaction.deferUpdate();
        pending.resolve(approved);
      } else {
        await interaction.reply({ content: "This confirmation has expired.", ephemeral: true });
      }
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
      const guildId = interaction.guildId ?? null;
      await promptWithMcp(channelId, text, resolved.agentName, guildId, resolved.agent, interaction.user.id);
    } catch (err) {
      stopTyping(channelId);
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
    stopTyping(channelId);
    toolStates.delete(channelId);
    toolSummaryMessages.delete(channelId);
    replyBuffers.delete(channelId);
    replyMessages.delete(channelId);
    pendingDiffs.delete(channelId);
    permissionDiffShown.delete(channelId);
    const timer = flushTimers.get(channelId);
    if (timer) clearTimeout(timer);
    flushTimers.delete(channelId);

    await interaction.reply("Session cleared. Next message will start a fresh agent.");
  });

  // --- Start IPC server and task scheduler ---
  await ipcServer.start();
  taskScheduler.start();

  // Graceful shutdown
  process.on("SIGTERM", () => {
    for (const channelId of typingIntervals.keys()) stopTyping(channelId);
    taskScheduler.stop();
    ipcServer.stop();
    sessionManager.teardownAll();
    discordClient.destroy();
  });

  process.on("SIGINT", () => {
    for (const channelId of typingIntervals.keys()) stopTyping(channelId);
    taskScheduler.stop();
    ipcServer.stop();
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
    ipcServer.stop();
    process.exit(1);
  }
}
