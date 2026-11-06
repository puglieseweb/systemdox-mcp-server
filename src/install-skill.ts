/**
 * `systemdox-mcp-server install-skill <name>` — what the console's Install
 * button copies (ADR-216 §2.3). Installs a published skill onto this computer
 * with no model in the loop, through the same code and the same edit check as
 * the stdio server's install_skill tool.
 *
 * Exit codes: 0 installed; 1 usage, no key, or the API refused; 2 refused
 * because files in the folder were edited since they were installed.
 */

import { basename, resolve } from "node:path";
import { SystemDoxApiClient } from "./lib/api-client.js";
import { loadConfig } from "./lib/config.js";
import {
  SkillInstallRefused,
  defaultSkillDir,
  describeInstall,
  installSkill,
  isValidName,
  type SkillVersionFiles,
} from "./lib/skills.js";

export const INSTALL_USAGE =
  "Usage: systemdox-mcp-server install-skill <name> [--version <n>] [--target <dir>] [--overwrite]";

export interface InstallArgs {
  name: string;
  version?: number;
  target?: string;
  overwrite: boolean;
}

export function parseInstallArgs(argv: string[]): InstallArgs {
  const args: Partial<InstallArgs> & { overwrite: boolean } = { overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--overwrite") args.overwrite = true;
    else if (a === "--version" || a === "--target") {
      const value = argv[++i];
      if (!value) throw new Error(`${a} needs a value\n${INSTALL_USAGE}`);
      if (a === "--target") args.target = value;
      else if (/^[1-9]\d*$/.test(value)) args.version = Number(value);
      else throw new Error(`--version must be a whole number, got ${value}`);
    } else if (a.startsWith("-")) throw new Error(`Unknown option ${a}\n${INSTALL_USAGE}`);
    else if (!args.name) args.name = a;
    else throw new Error(`Unexpected argument ${a}\n${INSTALL_USAGE}`);
  }
  if (!args.name) throw new Error(INSTALL_USAGE);
  if (!isValidName(args.name)) throw new Error(`${args.name} is not a skill name`);
  if (args.target && basename(resolve(args.target)) !== args.name) {
    throw new Error(`--target must be a folder named ${args.name} (e.g. .claude/skills/${args.name})`);
  }
  return args as InstallArgs;
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  client?: Pick<SystemDoxApiClient, "getFresh">;
}

export async function runInstallSkill(argv: string[], io: Io): Promise<number> {
  let args: InstallArgs;
  try {
    args = parseInstallArgs(argv);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  let client = io.client;
  if (!client) {
    try {
      client = new SystemDoxApiClient(loadConfig());
    } catch (e) {
      // Never prompt for the key: a key typed at a prompt ends up in shell history.
      io.err(
        `${(e as Error).message}\nSet SYSTEMDOX_API_KEY in your environment (create a key under Settings › API keys in SystemDox), then run this again.`
      );
      return 1;
    }
  }

  let version: SkillVersionFiles;
  try {
    version = await client.getFresh<SkillVersionFiles>(
      `/v1/standards/skills/${encodeURIComponent(args.name)}/versions/${args.version ?? "latest"}`
    );
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  try {
    const result = await installSkill(version, args.target ?? defaultSkillDir(version.name), {
      overwrite: args.overwrite,
    });
    io.out(describeInstall(version.name, result));
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof SkillInstallRefused ? 2 : 1;
  }
}
