/**
 * `setup`'s first step: write the SystemDox MCP server into an AI tool's
 * config (Claude Code's project `.mcp.json` or `~/.claude.json`, Cursor's,
 * VS Code's). The team setup (`setup-team.ts`) follows it.
 *
 * The key is stored once (specs/changes/team-setup/contract.md "The API key",
 * proposal item 7): in `~/.claude/systemdox/credentials.json` for the key's
 * workspace, readable by the member alone. The server entry this step writes
 * carries no key; the local server reads it from SYSTEMDOX_API_KEY, then from
 * credentials.json (`loadLocalConfig`). A key an earlier `setup` wrote into
 * the entry is removed from it, and nothing else in that file changes.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SystemDoxApiClient } from "./lib/api-client.js";
import { API_URL_DEFAULT, requireHttpsApiUrl } from "./lib/config.js";
import { credentialsPath, homeDir, isWorkspace, readCredentials, writeCredentials } from "./lib/team-setup-files.js";
import type { TeamSetup } from "./lib/team-setup-types.js";
import { setInJsonFile } from "./setup-team.js";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfigTarget {
  name: string;
  path: string;
  detected: boolean;
}

export interface McpSetupOptions {
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string) => Promise<string>;
  /** The folder whose project configs are offered (default: the current folder). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Checks the key against the API (default: `GET /v1/health`). */
  validateKey?: (apiKey: string, apiUrl: string) => Promise<boolean>;
  /** Names the key's workspace (default: `GET /team-setup` with the key). */
  client?: (apiKey: string, apiUrl: string) => { getOwnTeamSetup(): Promise<TeamSetup> };
}

export type McpSetupResult =
  | { code: 0; apiKey: string; apiUrl: string; workspace: string }
  | { code: 1 };

/** A `${NAME}` reference to the member's own environment: not a key. */
const isReference = (value: unknown) => typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);

async function validateApiKey(apiKey: string, apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/health`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function findConfigTargets(cwd: string = process.cwd()): McpConfigTarget[] {
  const home = homeDir();
  return [
    // Claude Code: the project's .mcp.json, and ~/.claude.json (all projects)
    { name: "Claude Code (project)", path: join(cwd, ".mcp.json"), detected: true },
    { name: "Claude Code (user — all projects)", path: join(home, ".claude.json"), detected: true },
    { name: "Cursor (project)", path: join(cwd, ".cursor", "mcp.json"), detected: existsSync(join(cwd, ".cursor")) },
    { name: "VS Code (project)", path: join(cwd, ".vscode", "mcp.json"), detected: existsSync(join(cwd, ".vscode")) },
    { name: "Cursor (global)", path: join(home, ".cursor", "mcp.json"), detected: existsSync(join(home, ".cursor")) },
  ];
}

/**
 * The `systemdox` server entry: the command and args, and in `env` only
 * SYSTEMDOX_API_URL when it is not the default. Never the key. Other variables
 * the member set on an existing entry are kept, and so is a `${NAME}`
 * reference for SYSTEMDOX_API_KEY (the member's own environment, not a key).
 * `workspace` is set as SYSTEMDOX_WORKSPACE when credentials.json holds keys
 * for several workspaces, so the server knows which one to use.
 */
export function serverEntry(apiUrl: string, existing?: unknown, workspace?: string): McpServerEntry {
  const env: Record<string, string> = {};
  const old = existing && typeof existing === "object" ? (existing as { env?: unknown }).env : undefined;
  if (old && typeof old === "object" && !Array.isArray(old)) {
    for (const [name, value] of Object.entries(old)) {
      if (typeof value !== "string" || name === "SYSTEMDOX_API_URL" || name === "SYSTEMDOX_WORKSPACE") continue;
      if (name === "SYSTEMDOX_API_KEY" && !isReference(value)) continue;
      env[name] = value;
    }
  }
  if (apiUrl !== API_URL_DEFAULT) env.SYSTEMDOX_API_URL = apiUrl;
  if (workspace) env.SYSTEMDOX_WORKSPACE = workspace;
  const entry: McpServerEntry = { command: "npx", args: ["@systemdox/mcp-server"] };
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

/** The `systemdox` entry in the config at `path` now, or undefined. Throws
 * when the file is there but is not JSON: it is the member's, so it is never
 * replaced. */
function currentEntry(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (!text.trim()) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON: fix it, then run setup again.`);
  }
  const servers = config && typeof config === "object" ? (config as { mcpServers?: unknown }).mcpServers : undefined;
  return servers && typeof servers === "object" ? (servers as Record<string, unknown>).systemdox : undefined;
}

/**
 * Set the `systemdox` entry in the config at `path`, creating the file when
 * absent; every other byte of an existing file is kept. Returns true when the
 * entry held a key, which it no longer does.
 */
export async function writeServerEntry(path: string, apiUrl: string, workspace?: string): Promise<boolean> {
  const existing = currentEntry(path);
  const env = existing && typeof existing === "object" ? (existing as { env?: unknown }).env : undefined;
  const heldKey =
    !!env && typeof env === "object" && "SYSTEMDOX_API_KEY" in env && !isReference((env as Record<string, unknown>).SYSTEMDOX_API_KEY);
  await setInJsonFile(path, ["mcpServers", "systemdox"], serverEntry(apiUrl, existing, workspace));
  return heldKey;
}

/** The key's workspace: `GET /team-setup` names it; when that fails,
 * SYSTEMDOX_WORKSPACE, or the member types it. */
async function keyWorkspace(opts: McpSetupOptions, apiKey: string, apiUrl: string): Promise<string | undefined> {
  const client =
    opts.client?.(apiKey, apiUrl) ?? new SystemDoxApiClient({ apiKey, apiUrl, cacheTtlMs: 0, defaultOrg: undefined });
  try {
    const { workspace } = await client.getOwnTeamSetup();
    if (isWorkspace(workspace)) return workspace;
    opts.out(`  SystemDox named the workspace ${JSON.stringify(workspace)}, which is not a workspace name.`);
  } catch (e) {
    opts.out(`  SystemDox did not name your key's workspace (${(e as Error).message}).`);
  }
  const fromEnv = (opts.env ?? process.env).SYSTEMDOX_WORKSPACE;
  if (isWorkspace(fromEnv)) return fromEnv;
  const typed = (await opts.ask("  Your workspace (acme in acme.systemdox.com): ")).trim().toLowerCase();
  return isWorkspace(typed) ? typed : undefined;
}

/**
 * The first step of `setup`. Every line goes to `opts.out` / `opts.err`;
 * code 1 means nothing was changed.
 */
export async function setupMcpServer(opts: McpSetupOptions): Promise<McpSetupResult> {
  const { out, err, ask } = opts;
  out("\n  SystemDox MCP Server Setup\n");

  // 1. The key and the API URL.
  const apiKey = (await ask("  Enter your SystemDox API key: ")).trim();
  if (!apiKey) {
    err("\n  Error: API key is required.\n  Generate one at your SystemDox settings page.\n");
    return { code: 1 };
  }
  const apiUrl = (await ask(`  API URL [${API_URL_DEFAULT}]: `)).trim() || API_URL_DEFAULT;

  // Fail closed on a non-https API URL: the key is sent as a bearer token, so an
  // http:// URL would leak it in cleartext. Reject before writing/validating.
  try {
    requireHttpsApiUrl(apiUrl);
  } catch (e) {
    err(`\n  Error: ${(e as Error).message}\n`);
    return { code: 1 };
  }

  // 2. Validate, and name the key's workspace (where credentials.json keeps it).
  out("\n  Validating API key...");
  if (!(await (opts.validateKey ?? validateApiKey)(apiKey, apiUrl))) {
    err("\n  Error: Invalid API key or cannot reach the SystemDox API.\n  Check your key and try again.\n");
    return { code: 1 };
  }
  out("  API key validated successfully.\n");
  const workspace = await keyWorkspace(opts, apiKey, apiUrl);
  if (!workspace) {
    err("\n  Error: that is not a workspace name (lower case letters, digits and -). Nothing was changed.\n");
    return { code: 1 };
  }

  // 3. Which configs.
  const detected = findConfigTargets(opts.cwd).filter((t) => t.detected);
  out("  Available targets:");
  detected.forEach((t, i) => out(`    ${i + 1}. ${t.name} (${t.path})`));
  const choice = (await ask(`\n  Which target? [1-${detected.length}, or 'all']: `)).trim();
  let selected: McpConfigTarget[];
  if (choice.toLowerCase() === "all") {
    selected = detected;
  } else {
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= detected.length) {
      err("\n  Invalid selection.\n");
      return { code: 1 };
    }
    selected = [detected[idx]];
  }

  // 4. The key, once: credentials.json. Then the server entries, without it.
  try {
    if ((await readCredentials())[workspace]?.apiKey !== apiKey) await writeCredentials(workspace, apiKey);
    // Claude Code watches a skills folder only if it existed when the session
    // started. Made now, a new computer's first session loads a skill as soon
    // as it installs one.
    await mkdir(join(homeDir(), ".claude", "skills"), { recursive: true });
    const several = Object.keys(await readCredentials()).length > 1;
    for (const target of selected) {
      const removed = await writeServerEntry(target.path, apiUrl, several ? workspace : undefined);
      out(`  Configured: ${target.name}`);
      if (removed) out(`  The key now lives in ~/.claude/systemdox/credentials.json and was removed from ${target.path}.`);
    }
  } catch (e) {
    err(`\n  Error: ${(e as Error).message}\n`);
    return { code: 1 };
  }

  out(
    `\n  Your key for ${workspace} is in ${credentialsPath()} (readable by you alone), not in these configs.\n` +
      "\n  Done! Restart your AI coding tool to activate the SystemDox MCP server.\n" +
      "  The server provides 25 tools: get_context, get_team_setup, get_checks,\n" +
      "  get_project_rules, get_prompt_templates, get_specs, get_docs,\n" +
      "  get_tech_stack, get_planning_context, get_plan_board, get_change,\n" +
      "  get_document_links, trace_document_path, get_graph_stats,\n" +
      "  create_check, create_project_rule, create_prompt_template,\n" +
      "  update_spec, report_decision, publish_skill, list_skills,\n" +
      "  install_skill, publish_setup_part, resolve_person, sync_memory.\n\n" +
      "  get_guardrails and create_guardrail remain registered as deprecated\n" +
      "  aliases of get_checks and create_check — existing configs keep working.\n"
  );
  return { code: 0, apiKey, apiUrl, workspace };
}
