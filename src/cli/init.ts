import { Command } from "commander";

export function makeInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup wizard")
    .action(async () => {
      console.log("TODO: init wizard");
    });
}
