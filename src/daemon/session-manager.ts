import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../shared/types.js";
import { createAcpClient, type AcpEventHandlers } from "./acp-client.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

interface ManagedSession {
  channelId: string;
  agentName: string;
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

interface PersistedSession {
  sessionId: string;
  agentName: string;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private handlers: AcpEventHandlers;
  private sessionsPath: string;
  private pendingResumes = new Map<string, PersistedSession>();
  private maxConcurrentSessions: number;

  constructor(handlers: AcpEventHandlers, sessionsPath: string, maxConcurrentSessions = 1) {
    this.handlers = handlers;
    this.sessionsPath = sessionsPath;
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.loadSessionMap();
  }

  private loadSessionMap(): void {
    try {
      const data = readFileSync(this.sessionsPath, "utf-8");
      const map = JSON.parse(data) as Record<string, PersistedSession>;
      for (const [channelId, entry] of Object.entries(map)) {
        this.pendingResumes.set(channelId, entry);
      }
      if (this.pendingResumes.size > 0) {
        console.log(`Loaded ${this.pendingResumes.size} session(s) for lazy resume`);
      }
    } catch (err: unknown) {
      // ENOENT is expected on first run; log other errors for diagnosability
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      if (err instanceof SyntaxError) {
        console.warn("Corrupt sessions.json, starting fresh:", err.message);
      }
    }
  }

  saveSessionMap(): void {
    const map: Record<string, PersistedSession> = {};
    // Include unresumed pending sessions so they survive daemon restarts
    // where no messages were received for that channel
    for (const [channelId, entry] of this.pendingResumes) {
      map[channelId] = entry;
    }
    // Active sessions override any pending resume for the same channel
    for (const [channelId, session] of this.sessions) {
      map[channelId] = {
        sessionId: session.sessionId,
        agentName: session.agentName,
      };
    }
    try {
      mkdirSync(dirname(this.sessionsPath), { recursive: true });
      writeFileSync(this.sessionsPath, JSON.stringify(map, null, 2));
    } catch (err) {
      console.error("Failed to save session map:", err);
    }
  }

  async prompt(channelId: string, text: string, agentName: string, agentConfig: AgentConfig, requestorId: string, mcpServers?: McpServerConfig[]): Promise<string> {
    console.log(`[MCP] prompt: channel=${channelId} mcpServers=${mcpServers ? `[${mcpServers.length} server(s)]` : "undefined"}`);
    const session = await this.getOrCreate(channelId, agentName, agentConfig, requestorId, mcpServers);
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
    } catch (err) {
      // Connection broken or agent crashed — teardown to kill orphaned processes
      console.error(`Prompt error for channel ${session.channelId}, tearing down session:`, err);
      this.handlers.onPromptComplete(session.channelId, "error");
      this.teardown(session.channelId);
      throw err;
    } finally {
      session.prompting = false;
      // Process queue only if session is still alive (not torn down above)
      if (this.sessions.has(session.channelId)) {
        const next = session.queue.shift();
        if (next) {
          this.executePrompt(session, next.text, next.requestorId, agentConfig).catch((err) => {
            console.error(`Queued prompt failed for channel ${session.channelId}:`, err);
          });
        }
      }
    }
  }

  cancel(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (session) {
      session.connection.cancel({ sessionId: session.sessionId });
    }
  }

  private async getOrCreate(channelId: string, agentName: string, agentConfig: AgentConfig, requestorId: string, mcpServers?: McpServerConfig[]): Promise<ManagedSession> {
    const existing = this.sessions.get(channelId);
    if (existing) {
      console.log(`[MCP] getOrCreate: reusing existing session for channel=${channelId} (mcpServers passed but ignored: ${mcpServers ? mcpServers.length : 0} server(s))`);
      return existing;
    }

    // Check for a pending resume from a previous daemon run
    const pending = this.pendingResumes.get(channelId);
    if (pending && pending.agentName === agentName) {
      this.pendingResumes.delete(channelId);
      try {
        return await this.resumeSession(channelId, agentName, agentConfig, requestorId, pending.sessionId, mcpServers);
      } catch (err) {
        console.warn(`Session resume failed for channel ${channelId}, creating new session:`, err);
        // Fall through to create a new session
      }
    } else if (pending) {
      // Agent name changed since last run — discard stale resume
      this.pendingResumes.delete(channelId);
    }

    // Evict oldest idle session(s) if at capacity
    this.evictIfNeeded();

    console.log(`[MCP] getOrCreate: creating new session for channel=${channelId} with ${mcpServers?.length ?? 0} MCP server(s)`);
    return this.createSession(channelId, agentName, agentConfig, requestorId, mcpServers);
  }

  private evictIfNeeded(): void {
    while (this.sessions.size >= this.maxConcurrentSessions) {
      // Find the least-recently-active non-prompting session
      let oldest: ManagedSession | null = null;
      for (const session of this.sessions.values()) {
        if (session.prompting) continue;
        if (!oldest || session.lastActivity < oldest.lastActivity) {
          oldest = session;
        }
      }
      if (!oldest) {
        // All sessions are actively prompting — evict the oldest anyway
        for (const session of this.sessions.values()) {
          if (!oldest || session.lastActivity < oldest.lastActivity) {
            oldest = session;
          }
        }
      }
      if (oldest) {
        console.log(`Evicting session for channel ${oldest.channelId} (lastActivity=${new Date(oldest.lastActivity).toISOString()}) to make room`);
        this.teardown(oldest.channelId);
      } else {
        break;
      }
    }
  }

  private async createSession(channelId: string, agentName: string, config: AgentConfig, requestorId: string, mcpServers?: McpServerConfig[]): Promise<ManagedSession> {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: config.cwd,
      detached: true, // Create new process group so we can kill the entire tree
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

      const newSessionPayload = {
        cwd: config.cwd,
        mcpServers: mcpServers ?? [],
      };
      console.log(`[MCP] createSession: calling newSession for channel=${channelId}`, JSON.stringify({
        cwd: newSessionPayload.cwd,
        mcpServerCount: newSessionPayload.mcpServers.length,
        mcpServerNames: newSessionPayload.mcpServers.map(s => s.name),
      }));
      const result = await connection.newSession(newSessionPayload);
      sessionId = result.sessionId;
      console.log(`[MCP] createSession: newSession succeeded, sessionId=${sessionId}`);
    } catch (err) {
      this.killProcessTree(proc);
      throw err;
    }

    const managed: ManagedSession = {
      channelId,
      agentName,
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

  private async resumeSession(channelId: string, agentName: string, config: AgentConfig, requestorId: string, previousSessionId: string, mcpServers?: McpServerConfig[]): Promise<ManagedSession> {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: config.cwd,
      detached: true, // Create new process group so we can kill the entire tree
    });

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

      const initResult = await connection.initialize({
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

      // Check if agent supports session resume
      const supportsResume = !!initResult.agentCapabilities?.sessionCapabilities?.resume;
      if (!supportsResume) {
        this.killProcessTree(proc);
        throw new Error("Agent does not support session resume");
      }

      await connection.unstable_resumeSession({
        sessionId: previousSessionId,
        cwd: config.cwd,
        mcpServers: mcpServers ?? [],
      });
      sessionId = previousSessionId;
      console.log(`Resumed session ${sessionId} for channel ${channelId}`);
    } catch (err) {
      this.killProcessTree(proc);
      throw err;
    }

    const managed: ManagedSession = {
      channelId,
      agentName,
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
    this.pendingResumes.delete(channelId);
    const session = this.sessions.get(channelId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    // Kill process group to ensure MCP child processes are also terminated
    this.killProcessTree(session.process);
    this.sessions.delete(channelId);
  }

  private killProcessTree(proc: ChildProcess): void {
    if (!proc.pid) {
      proc.kill();
      return;
    }
    try {
      // Kill the entire process group (negative PID) to clean up MCP children
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // Process group kill failed (e.g. not a group leader) — fall back to direct kill
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }
    // Force-kill after 5s if still alive
    setTimeout(() => {
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already dead */ }
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5000).unref();
  }

  teardownAll(): void {
    this.saveSessionMap();
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
