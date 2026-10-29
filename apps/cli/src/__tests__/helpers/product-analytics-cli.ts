import { Command } from "commander";
import { registerProjectCommands } from "../../commands/project.js";

export function createAnalyticsCliProgram(serverUrl: string): Command {
  const program = new Command().exitOverride();
  registerProjectCommands(program, () => serverUrl);
  return program;
}
