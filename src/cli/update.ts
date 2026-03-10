import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isDaemonRunning, readPid, removePid } from "./pid.js";

declare const __VERSION__: string;

const CONFIG_DIR = join(homedir(), ".acp-discord");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch("https://registry.npmjs.org/acp-discord/latest");
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const data = (await res.json()) as { version: string };
  return data.version;
}

function stopDaemon(): void {
  const pid = readPid(PID_PATH);
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
    removePid(PID_PATH);
    console.log(`Stopped daemon (PID: ${pid})`);
  } catch {
    removePid(PID_PATH);
  }
}

export function makeUpdateCommand(): Command {
  return new Command("update")
    .description("Update acp-discord to the latest version")
    .action(async () => {
      const current = __VERSION__;

      console.log(`Current version: v${current}`);
      console.log("Checking for updates...");

      let latest: string;
      try {
        latest = await fetchLatestVersion();
      } catch (err) {
        console.error("Failed to check for updates:", (err as Error).message);
        process.exit(1);
      }

      if (current === latest) {
        console.log(`Already up to date (v${current})`);
        return;
      }

      console.log(`Update available: v${current} → v${latest}`);

      const wasRunning = isDaemonRunning(PID_PATH);
      if (wasRunning) {
        console.log("Stopping daemon...");
        stopDaemon();
      }

      // Use npx with @latest to fetch the new version and start the daemon
      // We must delegate to the new version's code, not the current process
      console.log("Downloading latest version and restarting daemon...");
      try {
        execFileSync("npx", ["--yes", "acp-discord@latest", "daemon", "start"], {
          stdio: "inherit",
        });
      } catch {
        console.error("Failed to start daemon with new version.");
        console.error("You can try manually: npx acp-discord@latest daemon start");
        process.exit(1);
      }

      console.log(`Updated to v${latest}`);
    });
}
