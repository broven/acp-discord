import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDaemonRunning, readPid, removePid } from "./pid.js";
import { enableAutostart, disableAutostart } from "./autostart.js";

const CONFIG_DIR = join(homedir(), ".acp-discord");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");
const LOG_PATH = join(CONFIG_DIR, "daemon.log");
const ERR_LOG_PATH = join(CONFIG_DIR, "daemon.error.log");

export function makeDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the acp-discord daemon");

  daemon
    .command("start")
    .description("Start the daemon (background)")
    .action(async () => {
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon already running (PID: ${pid})`);
        process.exit(1);
      }
      removePid(PID_PATH); // clean stale

      // In the bundled output, both index.js and daemon.js are in dist/
      const thisDir = fileURLToPath(new URL(".", import.meta.url));
      const daemonEntry = join(thisDir, "daemon.js");
      const outFd = openSync(LOG_PATH, "a");
      const errFd = openSync(ERR_LOG_PATH, "a");
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: ["ignore", outFd, errFd],
        env: { ...process.env, ACP_DISCORD_DAEMON: "1" },
      });

      child.unref();
      closeSync(outFd);
      closeSync(errFd);

      // Wait briefly and verify the daemon wrote its PID file (#11)
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon started (PID: ${pid})`);
        process.exit(0);
      } else {
        console.error(`Daemon failed to start (forked PID: ${child.pid}).`);
        console.error(`Check logs: ${ERR_LOG_PATH}`);
        process.exit(1);
      }
    });

  daemon
    .command("run")
    .description("Run the daemon in foreground (for service managers)")
    .action(async () => {
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon already running (PID: ${pid})`);
        process.exit(1);
      }
      // Import and run directly in this process
      const { runDaemon } = await import("../daemon/index.js");
      await runDaemon();
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const pid = readPid(PID_PATH);
      if (pid === null) {
        console.log("Daemon is not running");
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        removePid(PID_PATH);
        console.log(`Daemon stopped (PID: ${pid})`);
      } catch {
        removePid(PID_PATH);
        console.log("Daemon was not running (stale PID removed)");
      }
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      if (isDaemonRunning(PID_PATH)) {
        const pid = readPid(PID_PATH);
        console.log(`Daemon is running (PID: ${pid})`);
      } else {
        removePid(PID_PATH);
        console.log("Daemon is not running");
      }
    });

  daemon
    .command("enable")
    .description("Enable auto-start on boot")
    .action(async () => {
      enableAutostart();
    });

  daemon
    .command("disable")
    .description("Disable auto-start on boot")
    .action(async () => {
      disableAutostart();
    });

  return daemon;
}
