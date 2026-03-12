import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../shared/types.js";
import { createAcpClient, type AcpEventHandlers } from "./acp-client.js";

interface ManagedSession {
  channelId: string;
  process: ChildProcess;
  connection: ClientSideConnection;
  sessionId: string;
  lastActivity: number;
  idleTimer: NodeJS.Timeout;
  prompting: boolean;
  queue: Array<{ text: string; requestorId: string }>;
  /** Set only when executePrompt begins — stable for the duration of the prompt */
  activePromptRequestorId: string;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private handlers: AcpEventHandlers;

  constructor(handlers: AcpEventHandlers) {
    this.handlers = handlers;
  }

  async prompt(channelId: string, text: string, agentConfig: AgentConfig, requestorId: string): Promise<string> {
    const session = await this.getOrCreate(channelId, agentConfig, requestorId);
    session.lastActivity = Date.now();
    this.resetIdleTimer(session, agentConfig.idle_timeout);

    if (session.prompting) {
      session.queue.push({ text, requestorId });
      return "queued";
    }

    return this.executePrompt(session, text, requestorId, agentConfig);
  }

  private async executePrompt(session: ManagedSession, text: string, requestorId: string, agentConfig: AgentConfig): Promise<string> {
    session.prompting = true;
    session.activePromptRequestorId = requestorId;
    try {
      const result = await session.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.handlers.onPromptComplete(session.channelId, result.stopReason);
      return result.stopReason;
    } finally {
      session.prompting = false;
      // Process queue — await and catch to prevent unhandled rejections (#3)
      const next = session.queue.shift();
      if (next) {
        this.executePrompt(session, next.text, next.requestorId, agentConfig).catch((err) => {
          console.error(`Queued prompt failed for channel ${session.channelId}:`, err);
        });
      }
    }
  }

  cancel(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (session) {
      session.connection.cancel({ sessionId: session.sessionId });
    }
  }

  private async getOrCreate(channelId: string, agentConfig: AgentConfig, requestorId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(channelId);
    if (existing) return existing;
    return this.createSession(channelId, agentConfig, requestorId);
  }

  private async createSession(channelId: string, config: AgentConfig, requestorId: string): Promise<ManagedSession> {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: config.cwd,
    });

    // Handle spawn errors (ENOENT, permission denied, etc.) (#4)
    proc.on("error", (err) => {
      console.error(`Agent process error for channel ${channelId}:`, err);
      const session = this.sessions.get(channelId);
      if (session?.process === proc) {
        clearTimeout(session.idleTimer);
        this.sessions.delete(channelId);
      }
    });

    proc.on("exit", (code) => {
      const session = this.sessions.get(channelId);
      if (session?.process === proc) {
        clearTimeout(session.idleTimer);
        this.sessions.delete(channelId);
        if (code !== 0 && code !== null) {
          console.warn(`Agent process for channel ${channelId} exited with code ${code}`);
        }
      }
    });

    // Wrap initialize/newSession in try/catch to clean up process on failure (#5)
    let connection: ClientSideConnection;
    let sessionId: string;
    try {
      const stream = ndJsonStream(
        Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );

      const client = createAcpClient(channelId, this.handlers, () => {
        return this.sessions.get(channelId)?.activePromptRequestorId ?? requestorId;
      });
      connection = new ClientSideConnection((_agent) => client, stream);

      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: {
          name: "acp-discord",
          title: "ACP Discord Bot",
          version: "0.1.0",
        },
      });

      const result = await connection.newSession({
        cwd: config.cwd,
        mcpServers: [],
      });
      sessionId = result.sessionId;
    } catch (err) {
      proc.kill();
      throw err;
    }

    const managed: ManagedSession = {
      channelId,
      process: proc,
      connection,
      sessionId,
      lastActivity: Date.now(),
      idleTimer: this.startIdleTimer(channelId, config.idle_timeout),
      prompting: false,
      queue: [],
      activePromptRequestorId: requestorId,
    };

    this.sessions.set(channelId, managed);
    return managed;
  }

  private startIdleTimer(channelId: string, timeoutSec: number): NodeJS.Timeout {
    return setTimeout(() => this.teardown(channelId), timeoutSec * 1000);
  }

  private resetIdleTimer(session: ManagedSession, timeoutSec: number): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = this.startIdleTimer(session.channelId, timeoutSec);
  }

  teardown(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.process.kill();
    this.sessions.delete(channelId);
  }

  teardownAll(): void {
    for (const channelId of this.sessions.keys()) {
      this.teardown(channelId);
    }
  }

  isPrompting(channelId: string): boolean {
    return this.sessions.get(channelId)?.prompting ?? false;
  }

  getActiveRequestorId(channelId: string): string | null {
    const session = this.sessions.get(channelId);
    if (!session?.prompting) return null;
    return session.activePromptRequestorId;
  }

  getActiveChannels(): string[] {
    return Array.from(this.sessions.keys());
  }
}
