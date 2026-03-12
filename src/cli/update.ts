import { Command } from "commander";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { isDaemonRunning, readPid, removePid } from "./pid.js";
import { isAutostartEnabled, enableAutostart } from "./autostart.js";

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

      // Pre-fetch the latest version into npx cache so subsequent runs use it
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
        // When managed by systemd/launchd, regenerate config and use the
        // service manager to restart — avoids conflicts with Restart=always.
        console.log("Updating autostart configuration...");
        enableAutostart();

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
          // Unload may fail if not currently loaded — that's fine
          try { execSync(`launchctl unload "${plistPath}"`, { stdio: "inherit" }); } catch { /* not loaded */ }
          try {
            execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
          } catch {
            console.error("Failed to restart launchd service.");
            process.exit(1);
          }
        }
      } else {
        // Manual daemon management — stop and restart directly
        const wasRunning = isDaemonRunning(PID_PATH);
        if (wasRunning) {
          console.log("Stopping daemon...");
          stopDaemon();
        }

        console.log("Restarting daemon...");
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

      console.log(`Updated to v${latest}`);
    });
}
