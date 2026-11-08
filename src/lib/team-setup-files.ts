/**
 * The files the team setup keeps on a member's computer (ADR-217,
 * specs/changes/team-setup/contract.md "Files on a member's computer"):
 *
 * - `~/.claude/systemdox/credentials.json`: `{ "<workspace>": { "apiKey" } }`,
 *   readable by the member alone (mode 600; on Windows an ACL for the member
 *   alone);
 * - `~/.claude/systemdox/<workspace>/state.json`: the installed versions and
 *   hashes, each memory project's base manifest and version, the accepted
 *   SHA-256s. Never a value and never an answer about a person;
 * - `~/.claude/systemdox/<workspace>/plugin/<n>/`: plugin version n, unpacked;
 * - `~/.claude/systemdox/<workspace>/sync-memory.log` and `sync.lock`: the hook
 *   run's full report and its lock (ADR-217 Amendment 3).
 *
 * Every path starts at `homeDir()`, the one place the home folder is read, so
 * a test points HOME (USERPROFILE on Windows) at a temporary folder.
 *
 * Also here: the API key's order (SYSTEMDOX_API_KEY, then credentials.json for
 * the workspace; `setup` writes the key there and nowhere else, not into an AI
 * tool's MCP config) and `marketplace-auth`, the marketplace's `headersHelper`,
 * which reads only these files and the environment.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { API_URL_DEFAULT, loadConfig, requireHttpsApiUrl, type ServerConfig } from "./config.js";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A workspace is a tenant slug (openapi Slug): it names a folder, so nothing
 * else is accepted. */
export function isWorkspace(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SLUG_RE.test(value);
}

/** The member's home folder: `os.homedir()`, which reads HOME (USERPROFILE on
 * Windows) on every call. */
export function homeDir(): string {
  return homedir();
}

export function systemdoxDir(): string {
  return join(homeDir(), ".claude", "systemdox");
}

export function credentialsPath(): string {
  return join(systemdoxDir(), "credentials.json");
}

export function workspaceDir(workspace: string): string {
  if (!isWorkspace(workspace)) throw new Error(`${JSON.stringify(workspace)} is not a workspace name`);
  return join(systemdoxDir(), workspace);
}

export function statePath(workspace: string): string {
  return join(workspaceDir(workspace), "state.json");
}

/** `~/.claude/systemdox/<workspace>/sync-memory.log`: the full report of every
 * `sync-memory --hook` run, newest last (ADR-217 Amendment 3). */
export function syncLogPath(workspace: string): string {
  return join(workspaceDir(workspace), "sync-memory.log");
}

/** `~/.claude/systemdox/<workspace>/sync.lock`: held while a hook run syncs. */
export function syncLockPath(workspace: string): string {
  return join(workspaceDir(workspace), "sync.lock");
}

export function pluginRoot(workspace: string): string {
  return join(workspaceDir(workspace), "plugin");
}

export function pluginDir(workspace: string, version: number): string {
  return join(pluginRoot(workspace), String(version));
}

// ── Credentials ─────────────────────────────────────────────────────────────

export type Credentials = Record<string, { apiKey: string }>;

async function readJson<T>(path: string, empty: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not valid JSON: fix or remove it, then run this again`);
  }
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
async function writeJsonAtomically(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", mode === undefined ? "utf8" : { encoding: "utf8", mode });
  await rename(tmp, path);
}

export async function readCredentials(): Promise<Credentials> {
  return readJson<Credentials>(credentialsPath(), {});
}

const run = promisify(execFile);

/** Restrict `path` to the member alone: mode 600, and on Windows an ACL with
 * inheritance removed and one full-control entry for the current user. */
export async function restrictToMember(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform === "win32") {
    await run("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { windowsHide: true });
  }
}

/** Save the key for `workspace` in credentials.json, readable by the member alone. */
export async function writeCredentials(workspace: string, apiKey: string): Promise<void> {
  if (!isWorkspace(workspace)) throw new Error(`${JSON.stringify(workspace)} is not a workspace name`);
  if (!apiKey) throw new Error("an API key is required");
  const path = credentialsPath();
  const credentials = await readCredentials();
  credentials[workspace] = { apiKey };
  await writeJsonAtomically(path, credentials, 0o600);
  await restrictToMember(path);
}

/** The key for `workspace`, in the contract's order: SYSTEMDOX_API_KEY, then
 * credentials.json for the workspace. Undefined when neither has one. */
export async function apiKeyFor(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (env.SYSTEMDOX_API_KEY) return env.SYSTEMDOX_API_KEY;
  const entry = (await readCredentials())[workspace];
  return typeof entry?.apiKey === "string" && entry.apiKey ? entry.apiKey : undefined;
}

/**
 * The key for a command that is not told the workspace: the local MCP server
 * and `sync-memory`. SYSTEMDOX_API_KEY; then credentials.json: the key of
 * SYSTEMDOX_WORKSPACE when it is set, otherwise of the one workspace the file
 * holds. Throws, naming SYSTEMDOX_API_KEY and SYSTEMDOX_WORKSPACE, when that
 * names no key or several.
 */
export async function localApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SYSTEMDOX_API_KEY) return env.SYSTEMDOX_API_KEY;
  const keys = Object.entries(await readCredentials()).filter(
    (e): e is [string, { apiKey: string }] => typeof e[1]?.apiKey === "string" && e[1].apiKey.length > 0
  );
  const wanted = env.SYSTEMDOX_WORKSPACE;
  if (wanted) {
    const key = keys.find(([ws]) => ws === wanted)?.[1].apiKey;
    if (key) return key;
    throw new Error(
      `~/.claude/systemdox/credentials.json holds no key for ${wanted} (SYSTEMDOX_WORKSPACE). Set SYSTEMDOX_API_KEY, or run npx -y @systemdox/mcp-server setup.`
    );
  }
  if (keys.length === 1) return keys[0][1].apiKey;
  if (keys.length > 1) {
    throw new Error(
      `~/.claude/systemdox/credentials.json holds keys for ${keys.map(([ws]) => ws).join(", ")}: set SYSTEMDOX_WORKSPACE to the workspace to use, or SYSTEMDOX_API_KEY to its key.`
    );
  }
  throw new Error("No SystemDox key. Set SYSTEMDOX_API_KEY, or run npx -y @systemdox/mcp-server setup.");
}

/** The local (stdio) server's settings: `loadConfig` with the key from
 * `localApiKey`. The hosted server takes each request's key and never reads this. */
export async function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const apiKey = await localApiKey(env);
  return loadConfig(apiKey);
}

/** SYSTEMDOX_API_URL or the default, https only (throws otherwise). */
export function apiUrlFrom(env: NodeJS.ProcessEnv = process.env): string {
  return requireHttpsApiUrl(env.SYSTEMDOX_API_URL || API_URL_DEFAULT);
}

// ── state.json ──────────────────────────────────────────────────────────────

export interface TeamSetupState {
  /** Plugin versions unpacked under plugin/<n>/, keyed by n: the zip's SHA-256. */
  plugin?: Record<string, { sha256: string; installedAt: string }>;
  /** The team instructions as last installed (`setup`). */
  instructions?: { version: number; sha256: string };
  /** Each memory project's base: the version synced last and its manifest. */
  memory?: Record<string, { version: number; manifest: Record<string, string> }>;
  /** The SHA-256s the member accepted (`setup --yes`). */
  accepted?: string[];
}

export async function readState(workspace: string): Promise<TeamSetupState> {
  return readJson<TeamSetupState>(statePath(workspace), {});
}

export async function writeState(workspace: string, state: TeamSetupState): Promise<void> {
  await writeJsonAtomically(statePath(workspace), state);
}

/** Read, change and write state.json in one step. */
export async function updateState(
  workspace: string,
  change: (state: TeamSetupState) => void
): Promise<TeamSetupState> {
  const state = await readState(workspace);
  change(state);
  await writeState(workspace, state);
  return state;
}

/** Remove a folder this code made (a temporary unpack). */
export async function removeFolder(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

// ── marketplace-auth ────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The workspace a marketplace URL is for, or undefined when the key must not
 * go there: the URL must be https, on the origin of the API URL, with a path
 * `<api path>/v1/team-setup/<workspace>/marketplace.json`.
 */
export function marketplaceWorkspace(marketplaceUrl: string, apiUrl: string): string | undefined {
  let url: URL;
  let api: URL;
  try {
    url = new URL(marketplaceUrl);
    api = new URL(requireHttpsApiUrl(apiUrl));
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== api.origin || url.username || url.password) return undefined;
  const base = api.pathname.replace(/\/+$/, "");
  const m = new RegExp(`^${escapeRegExp(base)}/v1/team-setup/([^/]+)/marketplace\\.json$`).exec(url.pathname);
  return m && isWorkspace(m[1]) ? m[1] : undefined;
}

export interface CommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * `marketplace-auth`: Claude Code runs it with CLAUDE_CODE_MARKETPLACE_URL
 * set. On a SystemDox marketplace URL it prints exactly
 * `{"Authorization":"Bearer <key>"}` for that workspace and returns 0;
 * otherwise nothing on stdout, the URL on stderr, and 1. No network call,
 * nothing written.
 */
export async function runMarketplaceAuth(io: CommandIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = env.CLAUDE_CODE_MARKETPLACE_URL;
  if (!url) {
    io.err("marketplace-auth: CLAUDE_CODE_MARKETPLACE_URL is not set; Claude Code sets it when it fetches a marketplace.");
    return 1;
  }
  let apiUrl: string;
  try {
    apiUrl = apiUrlFrom(env);
  } catch (e) {
    io.err(`marketplace-auth: ${(e as Error).message}`);
    return 1;
  }
  const workspace = marketplaceWorkspace(url, apiUrl);
  if (!workspace) {
    io.err(
      `marketplace-auth: refusing to give a SystemDox key for ${url}: it is not a SystemDox team marketplace on ${apiUrl}`
    );
    return 1;
  }
  let key: string | undefined;
  try {
    key = await apiKeyFor(workspace, env);
  } catch (e) {
    io.err(`marketplace-auth: ${(e as Error).message}`);
    return 1;
  }
  if (!key) {
    io.err(
      `marketplace-auth: no SystemDox key for ${workspace}. Set SYSTEMDOX_API_KEY, or run npx -y @systemdox/mcp-server setup.`
    );
    return 1;
  }
  io.out(JSON.stringify({ Authorization: `Bearer ${key}` }));
  return 0;
}
