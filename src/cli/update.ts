import { Command } from "commander";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { isDaemonRunning, readPid, removePid } from "./pid.js";
import { isAutostartEnabled, enableAutostart } from "./autostart.js";
import { getVersion } from "../shared/version.js";

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

function restartViaServiceManager(): void {
  const os = platform();
  if (os === "linux") {
    console.log("Restarting via systemd...");
    try {
      execSync("systemctl --user restart acp-discord", { stdio: "inherit" });
    } catch {
      console.error("Failed to restart systemd service.");
      console.error("You can try manually: systemctl --user restart acp-discord");
      process.exit(1);
    }
  } else if (os === "darwin") {
    console.log("Restarting via launchd...");
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.acp-discord.plist");
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "inherit" }); } catch { /* not loaded */ }
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
    } catch {
      console.error("Failed to restart launchd service.");
      process.exit(1);
    }
  }
}

function startDaemonViaNpx(): void {
  try {
    execFileSync("npx", ["--yes", "acp-discord@latest", "daemon", "start"], {
      stdio: "inherit",
    });
  } catch {
    console.error("Failed to start daemon with new version.");
    console.error("You can try manually: npx acp-discord@latest daemon start");
    process.exit(1);
  }
}

export function makeUpdateCommand(): Command {
  return new Command("update")
    .description("Update acp-discord to the latest version")
    .action(async () => {
      const current = getVersion();

      console.log(`Current version: v${current}`);
      console.log("Checking for updates...");

      let latest: string;
      try {
        latest = await fetchLatestVersion();
      } catch (err) {
        console.error("Failed to check for updates:", (err as Error).message);
        process.exit(1);
      }

      const upToDate = current === latest;
      if (upToDate) {
        console.log(`Already up to date (v${current})`);
      } else {
        console.log(`Update available: v${current} → v${latest}`);
      }

      if (upToDate) {
        // No new version — but if daemon is running, refresh the npx cache
        // and restart to pick up any stale cache entries
        const daemonRunning = isDaemonRunning(PID_PATH);
        if (!daemonRunning) return;

        // Force npx to re-resolve @latest so the restarted daemon uses it
        console.log("Refreshing npx cache...");
        try {
          execFileSync("npx", ["--yes", "acp-discord@latest", "--version"], {
            stdio: "inherit",
          });
        } catch {
          // Cache refresh failed — not fatal, daemon may still be fine
          console.warn("Warning: failed to refresh npx cache.");
        }

        console.log("Restarting daemon to ensure it runs the latest cached version...");
        if (isAutostartEnabled()) {
          enableAutostart();
          restartViaServiceManager();
        } else {
          stopDaemon();
          startDaemonViaNpx();
        }
        console.log("Daemon restarted.");
        return;
      }

      // New version available — download and restart/start daemon
      console.log("Downloading latest version...");
      try {
        execFileSync("npx", ["--yes", "acp-discord@latest", "--version"], {
          stdio: "inherit",
        });
      } catch {
        console.error("Failed to download latest version.");
        console.error("You can try manually: npx acp-discord@latest daemon start");
        process.exit(1);
      }

      const autostart = isAutostartEnabled();

      if (autostart) {
        console.log("Updating autostart configuration...");
        enableAutostart();
        restartViaServiceManager();
      } else {
        const wasRunning = isDaemonRunning(PID_PATH);
        if (wasRunning) {
          console.log("Stopping daemon...");
          stopDaemon();
        }
        console.log("Starting daemon with new version...");
        startDaemonViaNpx();
      }

      console.log(`Updated to v${latest}`);
    });
}
