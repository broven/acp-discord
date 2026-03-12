import { Command } from "commander";
import { makeDaemonCommand } from "./daemon.js";
import { makeInitCommand } from "./init.js";
import { makeUpdateCommand } from "./update.js";
import { getVersion } from "../shared/version.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("acp-discord")
    .description("Discord bot for ACP coding agents")
    .version(getVersion());

  program.addCommand(makeInitCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeUpdateCommand());

  return program;
}
