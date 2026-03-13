import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_IPC_SOCKET_PATH = join(homedir(), ".acp-discord", "ipc.sock");

export interface TaskCrudResult {
  task?: unknown;
  tasks?: unknown[];
  logs?: unknown[];
  error?: string;
  deleted?: boolean;
}

export interface IpcHandler {
  registerChannel(channelId: string, agentName: string, autoReply: boolean): void;
  unregisterChannel(channelId: string): void;
  confirmAction(sourceChannelId: string, description: string, details: string): Promise<boolean>;
  createTask?(params: Record<string, unknown>): TaskCrudResult;
  listTasks?(channelId?: string): TaskCrudResult;
  updateTask?(taskId: string, updates: Record<string, unknown>, channelId?: string): TaskCrudResult;
  deleteTask?(taskId: string, channelId?: string): TaskCrudResult;
  getTaskLogs?(taskId?: string, channelId?: string): TaskCrudResult;
}

interface IpcMessage {
  action: string;
  requestId?: string;
  channelId?: string;
  agentName?: string;
  autoReply?: boolean;
  sourceChannelId?: string;
  description?: string;
  details?: string;
  // Task-related fields
  taskId?: string;
  prompt?: string;
  scheduleType?: string;
  scheduleValue?: string;
  notify?: string;
  updates?: Record<string, unknown>;
}

export class IpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handler: IpcHandler;
  private connections = new Set<Socket>();

  constructor(handler: IpcHandler, socketPath = DEFAULT_IPC_SOCKET_PATH) {
    this.handler = handler;
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
    mkdirSync(dirname(this.socketPath), { recursive: true });

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));

      this.server.on("error", (err) => {
        console.error("IPC server error:", err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Restrict socket to owner-only access
        chmodSync(this.socketPath, 0o600);
        console.log(`IPC server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      // Process newline-delimited JSON messages
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          this.processMessage(socket, line).catch((err) => {
            console.error("IPC message processing error:", err);
          });
        }
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
    });

    socket.on("error", (err) => {
      console.error("IPC connection error:", err);
      this.connections.delete(socket);
    });
  }

  private async processMessage(socket: Socket, raw: string): Promise<void> {
    let msg: IpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("IPC: invalid JSON:", raw);
      return;
    }

    switch (msg.action) {
      case "register_channel":
        if (msg.channelId && msg.agentName) {
          this.handler.registerChannel(msg.channelId, msg.agentName, msg.autoReply ?? true);
        }
        break;

      case "unregister_channel":
        if (msg.channelId) {
          this.handler.unregisterChannel(msg.channelId);
        }
        break;

      case "confirm_action":
        if (msg.requestId && msg.sourceChannelId && msg.description) {
          const approved = await this.handler.confirmAction(
            msg.sourceChannelId,
            msg.description,
            msg.details ?? "",
          );
          const response = JSON.stringify({ requestId: msg.requestId, approved }) + "\n";
          socket.write(response);
        }
        break;

      case "create_task": {
        if (!msg.requestId || !this.handler.createTask) break;
        try {
          const result = this.handler.createTask({
            channel_id: msg.channelId ?? msg.sourceChannelId ?? "",
            agent_name: msg.agentName ?? "unknown",
            prompt: msg.prompt ?? "",
            schedule_type: msg.scheduleType ?? "once",
            schedule_value: msg.scheduleValue ?? "",
            description: msg.description,
            notify: msg.notify,
            created_by: "agent",
          });
          socket.write(JSON.stringify({ requestId: msg.requestId, ...result }) + "\n");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          socket.write(JSON.stringify({ requestId: msg.requestId, error: errMsg }) + "\n");
        }
        break;
      }

      case "list_tasks": {
        if (!msg.requestId || !this.handler.listTasks) break;
        const listResult = this.handler.listTasks(msg.channelId);
        socket.write(JSON.stringify({ requestId: msg.requestId, ...listResult }) + "\n");
        break;
      }

      case "update_task": {
        if (!msg.requestId || !msg.taskId || !this.handler.updateTask) break;
        try {
          const updateResult = this.handler.updateTask(msg.taskId, msg.updates ?? {}, msg.channelId);
          socket.write(JSON.stringify({ requestId: msg.requestId, ...updateResult }) + "\n");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          socket.write(JSON.stringify({ requestId: msg.requestId, error: errMsg }) + "\n");
        }
        break;
      }

      case "delete_task": {
        if (!msg.requestId || !msg.taskId || !this.handler.deleteTask) break;
        const deleteResult = this.handler.deleteTask(msg.taskId, msg.channelId);
        socket.write(JSON.stringify({ requestId: msg.requestId, ...deleteResult }) + "\n");
        break;
      }

      case "get_task_logs": {
        if (!msg.requestId || !this.handler.getTaskLogs) break;
        const logsResult = this.handler.getTaskLogs(msg.taskId, msg.channelId);
        socket.write(JSON.stringify({ requestId: msg.requestId, ...logsResult }) + "\n");
        break;
      }

      default:
        console.error("IPC: unknown action:", msg.action);
    }
  }

  stop(): void {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // Clean up socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }
}
