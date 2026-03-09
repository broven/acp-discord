import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../shared/config.js";
import { writePid } from "../cli/pid.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export async function runDaemon(): Promise<void> {
  writePid(PID_PATH, process.pid);

  const config = loadConfig(CONFIG_PATH);
  console.log(`acp-discord daemon started (PID: ${process.pid})`);
  console.log(`Watching ${Object.keys(config.channels).length} channel(s)`);

  // TODO: Task 12 will add Discord client + session manager here

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    process.exit(0);
  });
}

// When run as forked child
if (process.env.ACP_DISCORD_DAEMON === "1") {
  runDaemon().catch((err) => {
    console.error("Daemon failed:", err);
    process.exit(1);
  });
}
