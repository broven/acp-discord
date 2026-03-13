/**
 * MCP server providing Discord channel CRUD tools.
 * Runs as a stdio subprocess, injected into agent sessions.
 *
 * Required env vars:
 *   DISCORD_TOKEN  - Bot token for Discord REST API
 *   GUILD_ID       - Target guild ID
 *   IPC_SOCKET_PATH - Path to bot's Unix domain socket
 *   AGENT_NAME     - Name of the agent using these tools
 *   SOURCE_CHANNEL_ID - Channel where the agent was invoked
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { REST } from "discord.js";
import {
  Routes,
  ChannelType,
  type APIChannel,
  type APITextChannel,
  type RESTPostAPIGuildChannelJSONBody,
  type RESTPatchAPIChannelJSONBody,
} from "discord.js";
import { connect, type Socket } from "node:net";
import { z } from "zod/v4";

// --- Environment ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;
const IPC_SOCKET_PATH = process.env.IPC_SOCKET_PATH!;
const AGENT_NAME = process.env.AGENT_NAME ?? "unknown";
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID!;

const rest = new REST().setToken(DISCORD_TOKEN);

// --- IPC helpers ---

function ipcSend(msg: Record<string, unknown>): void {
  const sock = connect(IPC_SOCKET_PATH);
  sock.on("error", (err) => {
    console.error("IPC send error:", err.message);
  });
  sock.write(JSON.stringify(msg) + "\n");
  sock.end();
}

function ipcRequest(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(IPC_SOCKET_PATH);
    let buffer = "";

    sock.on("connect", () => {
      sock.write(JSON.stringify(msg) + "\n");
    });

    sock.on("data", (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        sock.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Invalid IPC response: ${line}`));
        }
      }
    });

    sock.on("error", (err) => reject(err));
    sock.on("close", () => {
      if (!buffer.includes("\n")) {
        reject(new Error("IPC connection closed before response"));
      }
    });
  });
}

async function requestConfirmation(description: string, details: string): Promise<boolean> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await ipcRequest({
    action: "confirm_action",
    requestId,
    sourceChannelId: SOURCE_CHANNEL_ID,
    description,
    details,
  });
  return response.approved === true;
}

// --- Guild validation helper ---

async function validateChannelInGuild(channelId: string): Promise<APITextChannel> {
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  if (!("guild_id" in channel) || channel.guild_id !== GUILD_ID) {
    throw new Error(`Channel ${channelId} does not belong to guild ${GUILD_ID}`);
  }
  return channel as APITextChannel;
}

// --- MCP Server ---

const server = new McpServer({
  name: "discord-channels",
  version: "1.0.0",
});

// Tool: list_channels
server.tool(
  "list_channels",
  "List all text channels in the Discord server",
  {},
  async () => {
    const channels = (await rest.get(Routes.guildChannels(GUILD_ID))) as APIChannel[];
    const textChannels = channels.filter(
      (ch) => ch.type === ChannelType.GuildText,
    ) as APITextChannel[];

    const result = textChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      topic: ch.topic ?? null,
      parent_id: ch.parent_id ?? null,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// Tool: create_channel
server.tool(
  "create_channel",
  "Create a new text channel in the Discord server (requires user approval)",
  {
    name: z.string().describe("Channel name (lowercase, hyphens, max 100 chars)"),
    topic: z.string().optional().describe("Channel topic/description"),
    category_id: z.string().optional().describe("Parent category ID"),
  },
  async ({ name, topic, category_id }) => {
    const details = [`Name: ${name}`, topic ? `Topic: ${topic}` : null, category_id ? `Category: ${category_id}` : null]
      .filter(Boolean)
      .join(", ");

    const approved = await requestConfirmation("Create channel", details);
    if (!approved) {
      return {
        content: [{ type: "text" as const, text: "Action rejected by user." }],
        isError: true,
      };
    }

    const body: RESTPostAPIGuildChannelJSONBody = {
      name,
      type: ChannelType.GuildText,
    };
    if (topic) body.topic = topic;
    if (category_id) body.parent_id = category_id;

    const channel = (await rest.post(Routes.guildChannels(GUILD_ID), { body })) as APITextChannel;

    // Register the new channel with the bot via IPC
    ipcSend({
      action: "register_channel",
      channelId: channel.id,
      agentName: AGENT_NAME,
      autoReply: true,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            id: channel.id,
            name: channel.name,
            url: `https://discord.com/channels/${GUILD_ID}/${channel.id}`,
            hint: "Use bind_channel to persist this binding to config.toml so it survives daemon restarts.",
          }),
        },
      ],
    };
  },
);

// Tool: delete_channel
server.tool(
  "delete_channel",
  "Delete a text channel from the Discord server (requires user approval)",
  {
    channel_id: z.string().describe("ID of the channel to delete"),
  },
  async ({ channel_id }) => {
    const channel = await validateChannelInGuild(channel_id);

    const approved = await requestConfirmation(
      "Delete channel",
      `Channel: #${channel.name} (${channel_id})`,
    );
    if (!approved) {
      return {
        content: [{ type: "text" as const, text: "Action rejected by user." }],
        isError: true,
      };
    }

    await rest.delete(Routes.channel(channel_id));

    // Unbind the channel persistently (removes from config.toml)
    const unbindRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ipcRequest({
      action: "unbind_channel",
      requestId: unbindRequestId,
      channelId: channel_id,
      guildId: GUILD_ID,
    }).catch(() => {
      // Best-effort: channel may not have been bound
    });

    return {
      content: [{ type: "text" as const, text: `Deleted channel #${channel.name} (${channel_id})` }],
    };
  },
);

// Tool: update_channel
server.tool(
  "update_channel",
  "Update a text channel's name or topic (requires user approval)",
  {
    channel_id: z.string().describe("ID of the channel to update"),
    name: z.string().optional().describe("New channel name"),
    topic: z.string().optional().describe("New channel topic"),
  },
  async ({ channel_id, name, topic }) => {
    const channel = await validateChannelInGuild(channel_id);

    const changes = [name ? `Name: ${name}` : null, topic !== undefined ? `Topic: ${topic}` : null]
      .filter(Boolean)
      .join(", ");

    const approved = await requestConfirmation(
      "Update channel",
      `Channel: #${channel.name} (${channel_id}), Changes: ${changes}`,
    );
    if (!approved) {
      return {
        content: [{ type: "text" as const, text: "Action rejected by user." }],
        isError: true,
      };
    }

    const body: RESTPatchAPIChannelJSONBody = {};
    if (name) body.name = name;
    if (topic !== undefined) body.topic = topic;

    const updated = (await rest.patch(Routes.channel(channel_id), { body })) as APITextChannel;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ id: updated.id, name: updated.name, topic: updated.topic }),
        },
      ],
    };
  },
);

// Tool: bind_channel
server.tool(
  "bind_channel",
  "Bind a Discord channel to an agent. Persists to config.toml so the binding survives daemon restarts.",
  {
    channel_id: z.string().describe("ID of the channel to bind"),
    agent: z.string().describe("Name of the agent to bind to"),
    cwd: z.string().optional().describe("Working directory override for this channel"),
    auto_reply: z.boolean().optional().describe("Respond to all messages, not just @mentions (default: true)"),
    discord_tools: z.boolean().optional().describe("Enable Discord channel management tools for this channel"),
  },
  async ({ channel_id, agent, cwd, auto_reply, discord_tools }) => {
    // Validate channel belongs to this guild
    await validateChannelInGuild(channel_id);

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await ipcRequest({
      action: "bind_channel",
      requestId,
      channelId: channel_id,
      agentName: agent,
      cwd,
      autoReply: auto_reply ?? true,
      discordTools: discord_tools,
      guildId: GUILD_ID,
    });

    if (response.success) {
      return {
        content: [{ type: "text" as const, text: `Channel ${channel_id} bound to agent "${agent}". Binding persisted to config.toml.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Failed to bind channel: ${response.error}` }],
      isError: true,
    };
  },
);

// Tool: unbind_channel
server.tool(
  "unbind_channel",
  "Remove a channel binding. The channel will no longer be monitored by any agent.",
  {
    channel_id: z.string().describe("ID of the channel to unbind"),
  },
  async ({ channel_id }) => {
    // Validate channel belongs to this guild
    await validateChannelInGuild(channel_id);

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await ipcRequest({
      action: "unbind_channel",
      requestId,
      channelId: channel_id,
      guildId: GUILD_ID,
    });

    if (response.success) {
      return {
        content: [{ type: "text" as const, text: `Channel ${channel_id} unbound. Binding removed from config.toml.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Failed to unbind channel: ${response.error}` }],
      isError: true,
    };
  },
);

// Tool: list_bindings
server.tool(
  "list_bindings",
  "List all channel bindings with their configurations",
  {},
  async () => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await ipcRequest({
      action: "list_bindings",
      requestId,
      guildId: GUILD_ID,
    });

    if (response.success) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.bindings, null, 2) }],
      };
    }
    return {
      content: [{ type: "text" as const, text: "Failed to list bindings" }],
      isError: true,
    };
  },
);

// Tool: send_message
server.tool(
  "send_message",
  "Send a message to a Discord channel",
  {
    channel_id: z.string().describe("ID of the channel to send to"),
    content: z.string().describe("Message content (max 2000 chars)"),
  },
  async ({ channel_id, content }) => {
    await validateChannelInGuild(channel_id);

    await rest.post(Routes.channelMessages(channel_id), {
      body: { content: content.slice(0, 2000) },
    });

    return {
      content: [{ type: "text" as const, text: `Message sent to <#${channel_id}>` }],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("discord-channels MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in MCP server:", err);
  process.exit(1);
});
