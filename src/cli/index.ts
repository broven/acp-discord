import { Command } from "commander";
import { makeDaemonCommand } from "./daemon.js";
import { makeInitCommand } from "./init.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("acp-discord")
    .description("Discord bot for ACP coding agents")
    .version("0.1.0");

  program.addCommand(makeInitCommand());
  program.addCommand(makeDaemonCommand());

  return program;
}
