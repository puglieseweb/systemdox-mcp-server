import { createInterface } from "node:readline";
import { API_URL_DEFAULT } from "./lib/config.js";
import { runMarketplaceAuth } from "./lib/team-setup-files.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// CLI entry point
const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  // The MCP server step first (the key goes to credentials.json, never into
  // the AI tool's config); then the team setup (ADR-217) for the key's
  // workspace, when it has anything published.
  Promise.all([import("./setup-team.js"), import("./setup-mcp.js")])
    .then(async ([{ parseSetupArgs, runTeamSetupCommand }, { setupMcpServer }]) => {
      let teamArgs: ReturnType<typeof parseSetupArgs>;
      try {
        teamArgs = parseSetupArgs(args.slice(1));
      } catch (err) {
        console.error(`\n  Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
      const step = await setupMcpServer({
        out: console.log,
        err: console.error,
        ask: (question: string) => prompt(question),
      });
      if (step.code !== 0) return step.code;
      return runTeamSetupCommand(teamArgs, step, {
        out: console.log,
        ask: (question: string) => prompt(question),
        terminal: !!process.stdin.isTTY,
      });
    })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  Error: ${err.message}\n`);
      process.exit(1);
    });
} else if (command === "install-skill") {
  // ADR-216: what the console's Install button copies.
  import("./install-skill.js")
    .then(({ runInstallSkill }) =>
      runInstallSkill(args.slice(1), { out: console.log, err: console.error })
    )
    .then((code) => process.exit(code));
} else if (command === "marketplace-auth") {
  // ADR-217: the team marketplace's headersHelper. Claude Code runs it with
  // CLAUDE_CODE_MARKETPLACE_URL set; no network call, nothing written.
  runMarketplaceAuth({ out: console.log, err: console.error }).then((code) => process.exit(code));
} else if (command === "plugin-path") {
  // ADR-217 Am.1: the team plugin's command source, run once per session.
  import("./plugin-path.js")
    .then(({ runPluginPath }) =>
      runPluginPath(args.slice(1), { out: console.log, err: console.error })
    )
    .then((code) => process.exit(code));
} else if (command === "sync-memory") {
  // ADR-217 §2.3 with Amendment 2: the team memory's sync. Questions about a
  // person's details are asked only of a person at a terminal.
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  import("./sync-memory.js")
    .then(({ runSyncMemory }) =>
      runSyncMemory(args.slice(1), {
        out: console.log,
        err: console.error,
        ask: terminal ? (question: string) => prompt(question) : undefined,
      })
    )
    .then((code) => process.exit(code));
} else if (command === "--help" || command === "-h") {
  console.log(`
  SystemDox MCP Server

  Usage:
    systemdox-mcp-server          Start the MCP server (stdio transport)
    systemdox-mcp-server setup [--project <name>] [--dir <checkout>] [--yes] [--overwrite]
                                  Configure the MCP server in your AI coding tool,
                                  then your team's setup: the team instructions,
                                  the plugin's marketplace and the project's team
                                  memory (shown first; nothing changes until you
                                  answer y)
    systemdox-mcp-server install-skill <name> [--version n] [--target dir] [--overwrite]
                                  Install a skill published to SystemDox
                                  (default folder: ~/.claude/skills/<name>)
    systemdox-mcp-server plugin-path <workspace> --version <n> --sha256 <hash>
                                  Print the folder of your team's plugin version,
                                  downloading and checking it first when needed
                                  (Claude Code runs it)
    systemdox-mcp-server marketplace-auth
                                  Print the header for your team's marketplace
                                  (Claude Code runs it)
    systemdox-mcp-server sync-memory [--project <name>] [--dir <folder>]
                                  [--import <folder>] [--dry-run]
                                  Sync a project's team memory with SystemDox
                                  (default folder:
                                  ~/.claude/systemdox/<workspace>/memory/<project>)
    systemdox-mcp-server --help   Show this help message

  Environment variables:
    SYSTEMDOX_API_KEY             Your SystemDox API key. When it is not set, every
                                  command reads ~/.claude/systemdox/credentials.json,
                                  where setup stores the key (and nowhere else: not
                                  in your AI tool's MCP config)
    SYSTEMDOX_WORKSPACE           The workspace whose key to use when
                                  credentials.json holds several
    SYSTEMDOX_API_URL             API URL (default: ${API_URL_DEFAULT})
    SYSTEMDOX_CACHE_TTL           Cache TTL in seconds (default: 300)
    SYSTEMDOX_DEFAULT_ORG         Default GitHub org
`);
} else if (!command) {
  // No command — start the MCP server
  import("./index.js");
} else {
  console.error(`  Unknown command: ${command}\n  Run 'systemdox-mcp-server --help' for usage.`);
  process.exit(1);
}
