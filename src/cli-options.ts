type Command = 'serve' | 'check-config' | 'doctor' | 'backup' | 'configure' | 'admin-reset';

interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly outputAgentPrompt: boolean;
  readonly takeover: boolean;
  readonly username: string | undefined;
  readonly passwordStdin: boolean;
}

const COMMANDS: readonly string[] = ['serve', 'check-config', 'doctor', 'backup', 'configure', 'admin-reset'];

export function parseCli(argv: readonly string[]): CliOptions {
  const [commandValue, ...argumentsList] = argv;
  if (commandValue === undefined || !isCommand(commandValue)) {
    throw new Error(usage());
  }
  let configPath: string | undefined;
  let outputAgentPrompt = false;
  let takeover = false;
  let username: string | undefined;
  let passwordStdin = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--output-agent-prompt' && commandValue === 'doctor' && !outputAgentPrompt) {
      outputAgentPrompt = true;
      continue;
    }
    if (argument === '--takeover' && commandValue === 'serve' && !takeover) {
      takeover = true;
      continue;
    }
    if (argument === '--password-stdin' && commandValue === 'admin-reset' && !passwordStdin) {
      passwordStdin = true;
      continue;
    }
    if (argument === '--username' && commandValue === 'admin-reset' && username === undefined) {
      username = argumentsList[index + 1];
      if (username === undefined || username.startsWith('--')) {
        throw new Error(usage());
      }
      index += 1;
      continue;
    }
    if (argument !== '--config' || configPath !== undefined) {
      throw new Error(usage());
    }
    configPath = argumentsList[index + 1];
    if (configPath === undefined || configPath.startsWith('--')) {
      throw new Error(usage());
    }
    index += 1;
  }
  if (configPath === undefined) {
    throw new Error(usage());
  }
  if (commandValue === 'admin-reset' && username === undefined) {
    throw new Error(usage());
  }
  return { command: commandValue, configPath, outputAgentPrompt, takeover, username, passwordStdin };
}

function isCommand(value: string): value is Command {
  return COMMANDS.includes(value);
}

function usage(): string {
  return 'Usage: plasticwan <serve|check-config|doctor|backup|configure|admin-reset> --config <path> [--output-agent-prompt] [--takeover] [--username <name>] [--password-stdin]';
}
