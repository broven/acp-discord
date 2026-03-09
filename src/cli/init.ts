import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";
import { detectInstalledAgents } from "../shared/detect-agents.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

const INIT_SYSTEM_PROMPT = `You are a setup assistant for acp-discord, a Discord bot that connects Discord channels to ACP coding agents.

Your job is to help the user configure ~/.acp-discord/config.toml interactively.

You need to collect:
1. Discord Bot Token (guide them to https://discord.com/developers/applications if needed)
2. Default working directory (the project path the agent will work on)
3. Channel IDs to bind (explain how to get channel IDs: right-click channel → Copy Channel ID)

Once you have all info, write the config file using the write_text_file tool to ${CONFIG_PATH}.

Config format (TOML):
\`\`\`toml
[discord]
token = "<token>"

[agents.default]
command = "npx"
args = ["<acp-package>"]
cwd = "<working-directory>"
idle_timeout = 600

[channels.<channel-id>]
agent = "default"
\`\`\`

Be friendly and concise. Ask one question at a time.`;

export function makeInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup wizard")
    .action(async () => {
      console.log("Welcome to acp-discord setup!\n");

      // Detect agents
      console.log("Detecting ACP-compatible agents...");
      const agents = detectInstalledAgents();

      if (agents.length === 0) {
        console.error("No ACP-compatible agents found.");
        console.error("Install one of: claude-code, codex, opencode, pi");
        process.exit(1);
      }

      for (const agent of agents) {
        console.log(`  \u2713 ${agent.name} (found)`);
      }

      const selected = agents[0];
      console.log(`\nUsing: ${selected.name}\n`);
      console.log("Starting setup agent...\n");

      // Spawn ACP agent for interactive setup
      const proc = spawn(selected.command, [selected.acpPackage], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      const stream = ndJsonStream(
        Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );

      // Simple readline for user input
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const askUser = (prompt: string): Promise<string> =>
        new Promise((resolve) => rl.question(prompt, resolve));

      const client: Client = {
        async requestPermission(params) {
          // Auto-allow file writes during setup
          const allowOption = params.options.find((o: { kind: string }) => o.kind === "allow_once");
          return {
            outcome: {
              outcome: "selected" as const,
              optionId: allowOption?.optionId ?? params.options[0].optionId,
            },
          };
        },
        async sessionUpdate(params) {
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            process.stdout.write(update.content.text);
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
        clientInfo: { name: "acp-discord-init", title: "ACP Discord Init", version: "0.1.0" },
      });

      mkdirSync(CONFIG_DIR, { recursive: true });

      const { sessionId } = await connection.newSession({
        cwd: CONFIG_DIR,
        mcpServers: [],
      });

      // Initial prompt
      await connection.prompt({
        sessionId,
        prompt: [
          { type: "text", text: INIT_SYSTEM_PROMPT },
          { type: "text", text: `The ACP agent package is: ${selected.acpPackage}\nPlease start the setup.` },
        ],
      });

      // Interactive loop
      while (true) {
        const input = await askUser("\n> ");
        if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") break;

        const result = await connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: input }],
        });

        if (result.stopReason === "end_turn" && existsSync(CONFIG_PATH)) {
          // Check if config was written
          try {
            const content = readFileSync(CONFIG_PATH, "utf-8");
            if (content.includes("[discord]")) {
              console.log("\n\nSetup complete! Config written to", CONFIG_PATH);
              console.log("Run `npx acp-discord daemon start` to begin.");
              break;
            }
          } catch {
            // config not ready yet
          }
        }
      }

      rl.close();
      proc.kill();
    });
}
