import { Command } from "commander";

export function makeDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the acp-discord daemon");

  daemon
    .command("start")
    .description("Start the daemon")
    .action(async () => {
      console.log("TODO: daemon start");
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      console.log("TODO: daemon stop");
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      console.log("TODO: daemon status");
    });

  daemon
    .command("enable")
    .description("Enable auto-start on boot")
    .action(async () => {
      console.log("TODO: daemon enable");
    });

  daemon
    .command("disable")
    .description("Disable auto-start on boot")
    .action(async () => {
      console.log("TODO: daemon disable");
    });

  return daemon;
}
