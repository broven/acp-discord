import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../shared/config.js";
import { writePid, removePid } from "../cli/pid.js";
import { startDiscordBot } from "./discord-bot.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export async function runDaemon(): Promise<void> {
  // Load config first — if it fails, no stale PID file is left behind (#12)
  const config = loadConfig(CONFIG_PATH);

  writePid(PID_PATH, process.pid);
  process.on("exit", () => removePid(PID_PATH));

  console.log(`acp-discord daemon started (PID: ${process.pid})`);
  console.log(`Loaded config: ${Object.keys(config.channels).length} channel(s)`);

  await startDiscordBot(config);
}

if (process.env.ACP_DISCORD_DAEMON === "1") {
  runDaemon().catch((err) => {
    console.error("Daemon failed:", err);
    process.exit(1);
  });
}
