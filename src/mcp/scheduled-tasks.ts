/**
 * MCP server providing scheduled task CRUD tools.
 * Runs as a stdio subprocess, injected into agent sessions.
 *
 * Required env vars:
 *   IPC_SOCKET_PATH    - Path to bot's Unix domain socket
 *   AGENT_NAME         - Name of the agent using these tools
 *   SOURCE_CHANNEL_ID  - Channel where the agent was invoked
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect, type Socket } from "node:net";
import { z } from "zod/v4";

// --- Environment ---
const IPC_SOCKET_PATH = process.env.IPC_SOCKET_PATH!;
const AGENT_NAME = process.env.AGENT_NAME ?? "unknown";
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID!;

// --- IPC helpers ---

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

// --- MCP Server ---

const server = new McpServer({
  name: "scheduled-tasks",
  version: "1.0.0",
});

// --- Helper: wrap tool handler with IPC error catching ---

function mcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// Tool: list_scheduled_tasks
server.tool(
  "list_scheduled_tasks",
  "List all scheduled tasks for this channel",
  {},
  async () => {
    try {
      const response = await ipcRequest({
        action: "list_tasks",
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channelId: SOURCE_CHANNEL_ID,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.tasks ?? [], null, 2) }],
      };
    } catch (err) {
      return mcpError(`Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Tool: create_scheduled_task
server.tool(
  "create_scheduled_task",
  "Create a new scheduled task that will run on a schedule (requires user approval)",
  {
    prompt: z.string().describe("The prompt text to send to the agent when the task fires"),
    schedule_type: z.enum(["once", "cron", "interval"]).describe("Schedule type: 'once' (ISO datetime), 'cron' (cron expression), or 'interval' (seconds)"),
    schedule_value: z.string().describe("Schedule value: ISO datetime for once, cron expression for cron, or seconds for interval"),
    description: z.string().optional().describe("Human-readable description of what this task does"),
    notify: z.enum(["always", "on_error", "never"]).optional().describe("When to post results to Discord channel (default: on_error)"),
  },
  async ({ prompt, schedule_type, schedule_value, description, notify }) => {
    try {
      const details = [
        `Type: ${schedule_type}`,
        `Schedule: ${schedule_value}`,
        `Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
        description ? `Description: ${description}` : null,
        notify ? `Notify: ${notify}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const approved = await requestConfirmation("Create scheduled task", details);
      if (!approved) {
        return mcpError("Action rejected by user.");
      }

      const response = await ipcRequest({
        action: "create_task",
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channelId: SOURCE_CHANNEL_ID,
        agentName: AGENT_NAME,
        prompt,
        scheduleType: schedule_type,
        scheduleValue: schedule_value,
        description: description ?? undefined,
        notify: notify ?? undefined,
      });

      if (response.error) {
        return mcpError(`Error: ${response.error}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.task, null, 2) }],
      };
    } catch (err) {
      return mcpError(`Failed to create task: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Tool: update_scheduled_task
server.tool(
  "update_scheduled_task",
  "Update an existing scheduled task (requires user approval)",
  {
    task_id: z.string().describe("ID of the task to update"),
    status: z.enum(["active", "paused"]).optional().describe("New task status"),
    prompt: z.string().optional().describe("New prompt text"),
    schedule_type: z.enum(["once", "cron", "interval"]).optional().describe("New schedule type"),
    schedule_value: z.string().optional().describe("New schedule value"),
    notify: z.enum(["always", "on_error", "never"]).optional().describe("New notification setting"),
    description: z.string().optional().describe("New description"),
  },
  async ({ task_id, status, prompt, schedule_type, schedule_value, notify, description }) => {
    try {
      const changes = [
        status ? `Status: ${status}` : null,
        prompt ? `Prompt: ${prompt.slice(0, 100)}` : null,
        schedule_type ? `Type: ${schedule_type}` : null,
        schedule_value ? `Schedule: ${schedule_value}` : null,
        notify ? `Notify: ${notify}` : null,
        description ? `Description: ${description}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      const approved = await requestConfirmation(
        "Update scheduled task",
        `Task: ${task_id}\nChanges: ${changes}`,
      );
      if (!approved) {
        return mcpError("Action rejected by user.");
      }

      const response = await ipcRequest({
        action: "update_task",
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: task_id,
        channelId: SOURCE_CHANNEL_ID,
        updates: {
          ...(status !== undefined && { status }),
          ...(prompt !== undefined && { prompt }),
          ...(schedule_type !== undefined && { schedule_type }),
          ...(schedule_value !== undefined && { schedule_value }),
          ...(notify !== undefined && { notify }),
          ...(description !== undefined && { description }),
        },
      });

      if (response.error) {
        return mcpError(`Error: ${response.error}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.task, null, 2) }],
      };
    } catch (err) {
      return mcpError(`Failed to update task: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Tool: delete_scheduled_task
server.tool(
  "delete_scheduled_task",
  "Delete a scheduled task (requires user approval)",
  {
    task_id: z.string().describe("ID of the task to delete"),
  },
  async ({ task_id }) => {
    try {
      const approved = await requestConfirmation(
        "Delete scheduled task",
        `Task ID: ${task_id}`,
      );
      if (!approved) {
        return mcpError("Action rejected by user.");
      }

      const response = await ipcRequest({
        action: "delete_task",
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: task_id,
        channelId: SOURCE_CHANNEL_ID,
      });

      if (response.error) {
        return mcpError(`Error: ${response.error}`);
      }

      return {
        content: [{ type: "text" as const, text: `Task ${task_id} deleted.` }],
      };
    } catch (err) {
      return mcpError(`Failed to delete task: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Tool: get_task_logs
server.tool(
  "get_task_logs",
  "Get execution history for scheduled tasks",
  {
    task_id: z.string().optional().describe("Filter logs to a specific task ID"),
  },
  async ({ task_id }) => {
    try {
      const response = await ipcRequest({
        action: "get_task_logs",
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: task_id ?? undefined,
        channelId: SOURCE_CHANNEL_ID,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.logs ?? [], null, 2) }],
      };
    } catch (err) {
      return mcpError(`Failed to get task logs: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("scheduled-tasks MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in MCP server:", err);
  process.exit(1);
});
