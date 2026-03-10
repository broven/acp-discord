import { Command } from "commander";
import { makeDaemonCommand } from "./daemon.js";
import { makeInitCommand } from "./init.js";
import { makeUpdateCommand } from "./update.js";

declare const __VERSION__: string;

export function createCli(): Command {
  const program = new Command();

  program
    .name("acp-discord")
    .description("Discord bot for ACP coding agents")
    .version(__VERSION__);

  program.addCommand(makeInitCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeUpdateCommand());

  return program;
}
