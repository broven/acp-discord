import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../shared/types.js";
import type { McpServerConfig } from "./session-manager.js";

export interface TaskRunResult {
  output: string;
  stopReason: string;
  error: string | null;
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) { proc.kill(); return; }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  }
  setTimeout(() => {
    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already dead */ }
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }, 5000).unref();
}

export async function runTask(
  agentConfig: AgentConfig,
  prompt: string,
  mcpServers: McpServerConfig[],
): Promise<TaskRunResult> {
  const proc = spawn(agentConfig.command, agentConfig.args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: agentConfig.cwd,
    detached: true,
  });

  let output = "";
  let error: string | null = null;

  try {
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );

    const client: Client = {
      async requestPermission(): Promise<RequestPermissionResponse> {
        // Auto-cancel permission requests in scheduled tasks
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            output += update.content.text;
          }
        }
      },
    };

    const connection = new ClientSideConnection((_agent) => client, stream);

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: "acp-discord-task-runner",
        title: "ACP Discord Task Runner",
        version: "0.1.0",
      },
    });

    const { sessionId } = await connection.newSession({
      cwd: agentConfig.cwd,
      mcpServers,
    });

    const result = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    killProcessTree(proc);
    return { output, stopReason: result.stopReason, error: null };
  } catch (err) {
    killProcessTree(proc);
    error = err instanceof Error ? err.message : String(err);
    return { output, stopReason: "error", error };
  }
}
