import { Command } from "commander";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";
import { detectInstalledAgents } from "../shared/detect-agents.js";
import { parseConfig } from "../shared/config.js";
import { getVersion } from "../shared/version.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

// Only auto-allow writes to the config directory during setup
const SAFE_WRITE_PREFIX = CONFIG_DIR;

const INIT_SYSTEM_PROMPT = `You are a setup assistant for acp-discord, a Discord bot that connects Discord channels to ACP coding agents.

Your job is to help the user configure ~/.acp-discord/config.toml interactively.

You need to collect:
1. Discord Bot Token (guide them to https://discord.com/developers/applications if needed)
2. Default working directory (the project path the agent will work on)
3. Channel IDs to bind (explain how to get channel IDs: right-click channel → Copy Channel ID)
4. Reply mode per channel: ask whether the bot should respond to ALL messages in the channel (auto_reply = true) or only when @mentioned (auto_reply = false, the default)

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
auto_reply = false  # true = respond to all messages; false = only @mentions
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
          const title = params.toolCall.title ?? "Unknown";
          const kind = params.toolCall.kind ?? "other";

          // Auto-allow only safe file writes within the config directory,
          // validated against actual tool locations (not spoofable title) (#2)
          const isSafeWrite = kind === "write_text_file" || kind === "fs" || kind === "edit";
          if (isSafeWrite && params.toolCall.locations?.length) {
            const allPathsSafe = params.toolCall.locations.every(
              (loc: { path: string }) => {
                const resolved = resolve(loc.path);
                return resolved.startsWith(SAFE_WRITE_PREFIX + "/") || resolved === SAFE_WRITE_PREFIX;
              },
            );
            if (allPathsSafe) {
              const allowOption = params.options.find((o: { kind: string }) => o.kind === "allow_once");
              if (allowOption) {
                return { outcome: { outcome: "selected" as const, optionId: allowOption.optionId } };
              }
            }
          }

          // For all other operations, ask the user
          console.log(`\n--- Permission Request ---`);
          console.log(`Tool: ${title}`);
          console.log(`Type: ${kind}`);
          console.log(`Options:`);
          for (let i = 0; i < params.options.length; i++) {
            const opt = params.options[i];
            console.log(`  ${i + 1}. ${opt.name} (${opt.kind})`);
          }

          const answer = await askUser(`Choose option (1-${params.options.length}, or 'c' to cancel): `);
          if (answer.toLowerCase() === "c") {
            const rejectOption = params.options.find((o: { kind: string }) => o.kind === "reject_once");
            if (rejectOption) {
              return { outcome: { outcome: "selected" as const, optionId: rejectOption.optionId } };
            }
            return { outcome: { outcome: "cancelled" as const } };
          }

          const idx = parseInt(answer, 10) - 1;
          if (idx >= 0 && idx < params.options.length) {
            return { outcome: { outcome: "selected" as const, optionId: params.options[idx].optionId } };
          }

          // Invalid input — default to reject
          const rejectOption = params.options.find((o: { kind: string }) => o.kind === "reject_once");
          if (rejectOption) {
            return { outcome: { outcome: "selected" as const, optionId: rejectOption.optionId } };
          }
          return { outcome: { outcome: "cancelled" as const } };
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
          terminal: false,
        },
        clientInfo: { name: "acp-discord-init", title: "ACP Discord Init", version: getVersion() },
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

      // Check if config was already written during the initial prompt
      if (existsSync(CONFIG_PATH)) {
        try {
          const content = readFileSync(CONFIG_PATH, "utf-8");
          parseConfig(content);
          console.log("\n\nSetup complete! Config written to", CONFIG_PATH);
          console.log("Run `npx acp-discord daemon start` to begin.");
          rl.close();
          proc.kill();
          process.exit(0);
        } catch {
          // config not valid yet, continue to interactive loop
        }
      }

      // Interactive loop
      while (true) {
        const input = await askUser("\n> ");
        if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") break;

        const result = await connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: input }],
        });

        if (result.stopReason === "end_turn" && existsSync(CONFIG_PATH)) {
          // Validate the written config is structurally valid (#9)
          try {
            const content = readFileSync(CONFIG_PATH, "utf-8");
            parseConfig(content); // throws if invalid
            console.log("\n\nSetup complete! Config written to", CONFIG_PATH);
            console.log("Run `npx acp-discord daemon start` to begin.");
            break;
          } catch {
            // config not valid yet, continue
          }
        }
      }

      rl.close();
      proc.kill();
      process.exit(0);
    });
}
