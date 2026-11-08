/**
 * The team setup that `systemdox-mcp-server setup [--project <name>]
 * [--dir <checkout>] [--import <folder>]... [--yes] [--overwrite]` runs after
 * it has written the MCP server into an AI tool's config (ADR-217 with
 * Amendments 1 to 3, specs/changes/team-setup/contract.md "setup").
 *
 * 1. Check: `GET /team-setup` names the workspace; `claude --version` must be
 *    at least `minClaudeCodeVersion` (exit 3 otherwise, nothing changed).
 * 2. Show, then ask once (y/N). On an update only what changed is shown, with
 *    a line diff for hooks and instructions. `--yes` without a terminal goes
 *    no further than what the member accepted before (exit 4 otherwise).
 * 3. Do, in this order, stopping at a failed step: credentials.json; the team
 *    instructions (exit 2 if the member edited them, unless --overwrite); the
 *    import block in ~/.claude/CLAUDE.md; the marketplace in
 *    ~/.claude/settings.json; the project's `autoMemoryDirectory` in
 *    <checkout>/.claude/settings.local.json, then its sync. On the project's
 *    first sync on this computer, the sync imports the memory Claude Code kept
 *    for the checkout (`~/.claude/projects/<slug>/memory/`, for the checkout's
 *    path and, inside a Git repository, the repository's top folder) and each
 *    folder `--import` names, every one shown with its file count first
 *    (Amendment 3).
 * 4. Finish: the two steps a person must take in Claude Code.
 *
 * It never runs `claude plugin marketplace add` and never sets
 * `enabledPlugins`. The key is written to credentials.json only (the MCP
 * server step, setup-mcp.ts, has stored it there already).
 *
 * Exit codes: 0 done; 1 usage, no key or the API refused; 2 an edited team
 * CLAUDE.md would be replaced; 3 Claude Code missing or too old; 4 not
 * confirmed.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { SystemDoxApiClient } from "./lib/api-client.js";
import { isShareable, lineDiff } from "./lib/memory-sync.js";
import {
  homeDir,
  isWorkspace,
  pluginRoot,
  readCredentials,
  readState,
  removeFolder,
  shouldStoreKey,
  updateState,
  workspaceDir,
  writeCredentials,
  type KeySource,
} from "./lib/team-setup-files.js";
import type { PluginVersion, TeamSetup } from "./lib/team-setup-types.js";
import { refusal, syncMemory, type SyncClient } from "./sync-memory.js";

export const SETUP_USAGE =
  "Usage: systemdox-mcp-server setup [--project <name>] [--dir <checkout>] [--import <folder>]... [--yes] [--overwrite]";
export const HEADERS_HELPER = "npx -y @systemdox/mcp-server marketplace-auth";

export interface TeamSetupArgs {
  project?: string;
  dir?: string;
  /** Folders to import on the project's first sync on this computer (`--import`, repeatable). */
  importDirs?: string[];
  yes: boolean;
  overwrite: boolean;
}

export type TeamSetupClient = SyncClient & Pick<SystemDoxApiClient, "getPartVersion" | "getPlugin">;

export interface TeamSetupOptions extends TeamSetupArgs {
  client: TeamSetupClient;
  apiKey: string;
  /** Where the key came from: a key read from credentials.json is not written back. */
  keySource: KeySource;
  out: (line: string) => void;
  /** Asks the member a question. Absent: nobody can answer. */
  ask?: (question: string) => Promise<string>;
  /** stdin is a terminal (`--yes` counts only when it is not). */
  terminal: boolean;
  /** The checkout when `--dir` is absent. */
  cwd?: string;
  /** `claude --version`'s output, or undefined when Claude Code is not found. */
  claudeVersion?: () => Promise<string | undefined>;
  /** The top folder of the Git repository holding `dir`, or undefined outside one. */
  gitTop?: (dir: string) => Promise<string | undefined>;
  now?: () => Date;
}

/** A usage error or a refusal: exit 1 with the message. */
class SetupFailed extends Error {}

export function parseSetupArgs(argv: string[]): TeamSetupArgs {
  const args: TeamSetupArgs = { yes: false, overwrite: false, importDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") args.yes = true;
    else if (a === "--overwrite") args.overwrite = true;
    else if (a === "--project" || a === "--dir" || a === "--import") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${a} needs a value\n${SETUP_USAGE}`);
      if (a === "--project") {
        if (!isWorkspace(value)) throw new Error(`${value} is not a project name (lower case letters, digits and -)`);
        args.project = value;
      } else if (a === "--dir") args.dir = value;
      else args.importDirs!.push(value);
    } else throw new Error(`Unexpected argument ${a}\n${SETUP_USAGE}`);
  }
  return args;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ── Claude Code's version ───────────────────────────────────────────────────

const run = promisify(execFile);

/** `claude --version`'s output, or undefined when it cannot be run. On
 * Windows through the shell, so `claude.cmd` (npm) and `claude.exe` both resolve. */
export async function claudeCodeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run("claude", ["--version"], {
      shell: process.platform === "win32",
      timeout: 30_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** The top folder of the Git repository holding `dir`, or undefined outside one. */
export async function gitTopFolder(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 10_000, windowsHide: true });
    const top = stdout.trim();
    return top ? resolve(top) : undefined;
  } catch {
    return undefined;
  }
}

// ── The memory Claude Code kept for a checkout (Amendment 3) ────────────────

/** `~/.claude/projects/<slug>/memory/` for an absolute path: Claude Code's slug
 * replaces every character that is not a letter or a digit with `-`
 * (`/home/jo/git` → `-home-jo-git`; `C:\Users\jo\git` → `C--Users-jo-git`). */
export function claudeMemoryFolder(path: string): string {
  return join(homeDir(), ".claude", "projects", path.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

/** How many files of a folder a sync would share (hidden entries left out):
 * the `feedback`, `project` and `reference` memories and `MEMORY.md`. A `user`
 * memory, a `share: false` file and a conflict copy stay where they are, so
 * they are not counted. 0 when the folder is missing. */
export async function countMemoryFiles(folder: string): Promise<number> {
  let count = 0;
  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          if (isShareable(rel, await readFile(join(dir, e.name), "utf8"))) count++;
        } catch {
          // unreadable: not counted, and the sync will say so
        }
      }
    }
  }
  await walk(folder, "");
  return count;
}

export interface MemoryImport {
  folder: string;
  files: number;
  /** Named by `--import`, as opposed to found for the checkout. */
  named: boolean;
}

/**
 * The folders a project's first sync imports (contract.md "setup", step 3.5):
 * the memory Claude Code kept for the checkout's own path and, inside a Git
 * repository, for the repository's top folder, each when it holds a file and
 * is not the team folder itself; then each folder `--import` names.
 */
export async function memoryImports(
  checkout: string,
  teamFolder: string,
  named: string[],
  gitTop: (dir: string) => Promise<string | undefined> = gitTopFolder
): Promise<MemoryImport[]> {
  const candidates = [resolve(checkout)];
  const top = await gitTop(checkout);
  if (top && !candidates.includes(top)) candidates.push(top);
  const out: MemoryImport[] = [];
  for (const path of candidates) {
    const folder = claudeMemoryFolder(path);
    if (resolve(folder) === resolve(teamFolder)) continue;
    const files = await countMemoryFiles(folder);
    if (files) out.push({ folder, files, named: false });
  }
  for (const dir of named) {
    const folder = resolve(dir);
    if (out.some((i) => i.folder === folder)) continue;
    out.push({ folder, files: await countMemoryFiles(folder), named: true });
  }
  return out;
}

function parseVersion(text: string | undefined): number[] | undefined {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function olderThan(have: number[], need: number[]): boolean {
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] < need[i];
  return false;
}

// ── Files the member owns: one entry, one block ─────────────────────────────

function skipSpace(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function skipString(t: string, i: number): number {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === '"') return i + 1;
  }
  return i;
}

function skipValue(t: string, i: number): number {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] === "{" || t[i] === "[") {
    let depth = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '"') {
        i = skipString(t, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < t.length && !/[\s,}\]]/.test(t[i])) i++;
  return i;
}

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** The members of the (valid JSON) object whose `{` is at `open`. */
function objectMembers(t: string, open: number): { members: Member[]; close: number } {
  const members: Member[] = [];
  let i = skipSpace(t, open + 1);
  if (t[i] === "}") return { members, close: i };
  for (;;) {
    i = skipSpace(t, i);
    const keyStart = i;
    const keyEnd = skipString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd)) as string;
    i = skipSpace(t, skipSpace(t, keyEnd) + 1);
    const valueEnd = skipValue(t, i);
    members.push({ key, keyStart, valueStart: i, valueEnd });
    i = skipSpace(t, valueEnd);
    if (t[i] === ",") i++;
    else return { members, close: i };
  }
}

/** The whitespace that starts the line holding `pos`. */
function lineIndent(t: string, pos: number): string {
  const start = t.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(t.slice(start))![0];
}

/**
 * `text` (a JSON object) with `keys` set to `value`, every other byte kept:
 * an existing value is replaced in place, a missing member is added after the
 * last one in the file's own indentation and line ending.
 */
export function setJsonMember(text: string, keys: string[], value: unknown): string {
  const root = JSON.parse(text) as unknown;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("it does not hold a JSON object");
  const compact = !text.trimEnd().includes("\n");
  const unit = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const render = (v: unknown, indent: string) =>
    compact ? JSON.stringify(v) : JSON.stringify(v, null, unit).split("\n").join(eol + indent);
  const nest = (from: number) => keys.slice(from).reduceRight<unknown>((acc, k) => ({ [k]: acc }), value);

  let open = skipSpace(text, 0);
  for (let k = 0; k < keys.length; k++) {
    const { members, close } = objectMembers(text, open);
    const found = members.filter((m) => m.key === keys[k]).at(-1);
    if (found) {
      if (k < keys.length - 1 && text[found.valueStart] === "{") {
        open = found.valueStart;
        continue;
      }
      return text.slice(0, found.valueStart) + render(nest(k + 1), lineIndent(text, found.keyStart)) + text.slice(found.valueEnd);
    }
    const name = JSON.stringify(keys[k]);
    if (compact) {
      const member = `${name}:${render(nest(k + 1), "")}`;
      if (members.length) return text.slice(0, members.at(-1)!.valueEnd) + "," + member + text.slice(members.at(-1)!.valueEnd);
      return text.slice(0, open + 1) + member + text.slice(close);
    }
    if (members.length) {
      const last = members.at(-1)!;
      const indent = lineIndent(text, last.keyStart);
      return text.slice(0, last.valueEnd) + `,${eol}${indent}${name}: ${render(nest(k + 1), indent)}` + text.slice(last.valueEnd);
    }
    const outer = lineIndent(text, open);
    const indent = outer + unit;
    return text.slice(0, open + 1) + `${eol}${indent}${name}: ${render(nest(k + 1), indent)}${eol}${outer}` + text.slice(close);
  }
  return text;
}

function jsonAt(value: unknown, keys: string[]): unknown {
  let v = value;
  for (const k of keys) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

/** Set `keys` to `value` in the JSON file at `path`, creating it when absent;
 * nothing is written when it already holds that value. */
export async function setInJsonFile(path: string, keys: string[], value: unknown): Promise<void> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let next: string;
  if (text === undefined || !text.trim()) {
    next = JSON.stringify(keys.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value), null, 2) + "\n";
  } else {
    let current: unknown;
    try {
      current = JSON.parse(text);
    } catch {
      throw new SetupFailed(`${path} is not valid JSON: fix it, then run setup again.`);
    }
    if (JSON.stringify(jsonAt(current, keys)) === JSON.stringify(value)) return;
    try {
      next = setJsonMember(text, keys, value);
    } catch (e) {
      throw new SetupFailed(`${path}: ${(e as Error).message}; fix it, then run setup again.`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

export function importBlock(workspace: string, eol = "\n"): string {
  return [
    `<!-- systemdox:${workspace} -->`,
    `@~/.claude/systemdox/${workspace}/CLAUDE.md`,
    `<!-- /systemdox:${workspace} -->`,
  ].join(eol);
}

/** `text` with the workspace's marked block added at the end, or replaced
 * where it is; nothing outside the block changes. */
export function withImportBlock(text: string, workspace: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = importBlock(workspace, eol);
  const open = `<!-- systemdox:${workspace} -->`;
  const close = `<!-- /systemdox:${workspace} -->`;
  const start = text.indexOf(open);
  const end = start >= 0 ? text.indexOf(close, start) : -1;
  if (start >= 0 && end >= 0) return text.slice(0, start) + block + text.slice(end + close.length);
  if (!text) return block + eol;
  return text + (text.endsWith("\n") ? "" : eol) + block + eol;
}

async function readJsonQuietly(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

// ── What setup shows ────────────────────────────────────────────────────────

interface Item {
  /** What the member is told needs them (exit 4's list). */
  name: string;
  /** Shown before the question. */
  lines: string[];
  /** What the member accepts: the SHA-256 of what was shown. */
  sha256: string;
}

const item = (name: string, lines: string[], diff?: string[]): Item => ({
  name,
  lines: diff ?? lines,
  sha256: sha256(`${name}\n${lines.join("\n")}`),
});

const hookLines = (p: PluginVersion) => p.hookCommands ?? [];
const mcpLines = (p: PluginVersion) =>
  (p.mcpServers ?? []).map((s) => `${s.name}: ${s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ")}`);

/** The plan's last line when the workspace has no team memory and none was named (contract.md, item 31). */
export const NO_TEAM_MEMORY_LINE = "No team memory: run setup again with --project <name> to start one.";

/** The plan's last line when the key may not push the project (contract.md, item 31). */
export const keyCannotSyncLine = (project: string) =>
  `The key cannot sync the team memory ${project}: create a key in Settings › API keys with Developer or ` +
  "Architect access on All spaces, with Allow changes ticked, then run setup again.";

async function chooseProject(own: TeamSetup, opts: TeamSetupOptions, canAsk: boolean): Promise<string | undefined> {
  if (opts.project) return opts.project;
  if (own.memory.length === 0) {
    // The workspace's first team memory needs a name: a member at a terminal
    // is asked for it; an invalid one is asked once more, then counts as none.
    if (!canAsk || !opts.terminal) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await opts.ask!(
          `${own.workspace} has no team memory yet. Name one for this checkout (lower case letters, digits and -), or press Enter for none: `
        )
      ).trim();
      if (!answer) return undefined;
      if (isWorkspace(answer)) return answer;
      opts.out(`${answer} is not a project name (lower case letters, digits and -).`);
    }
    return undefined;
  }
  if (own.memory.length === 1) return own.memory[0].project;
  const names = own.memory.map((m) => m.project);
  const usage = `${own.workspace} has ${names.length} team memories (${names.join(", ")}): name this checkout's with --project.`;
  if (!canAsk) throw new SetupFailed(usage);
  const answer = (await opts.ask!(`Which team memory is this checkout's? (${names.join(", ")}) `)).trim();
  if (!names.includes(answer)) throw new SetupFailed(usage);
  return answer;
}

/**
 * Whether the key may push `project`: `blobs/missing` with no hashes reads and
 * stores nothing. Only SYD-A001 (no build:write on the project's space) and
 * SYD-K016 (a space the key cannot read) say no; any other answer lets the
 * memory go ahead, and its first sync reports its own errors.
 */
async function keyMayPush(client: TeamSetupClient, ws: string, project: string): Promise<boolean> {
  try {
    await client.findMissingBlobs(ws, project, []);
  } catch (e) {
    const { status, code } = refusal(e);
    if ((status === 403 && code === "SYD-A001") || (status === 404 && code === "SYD-K016")) return false;
  }
  return true;
}

/**
 * The team setup for the key's workspace. Returns the exit code; every line
 * goes to `opts.out`.
 */
export async function runTeamSetup(opts: TeamSetupOptions): Promise<number> {
  const { client, out } = opts;
  try {
    // 1. Check.
    const own = await client.getOwnTeamSetup();
    const ws = own.workspace;
    if (!isWorkspace(ws)) throw new SetupFailed(`SystemDox named the workspace ${JSON.stringify(ws)}, which is not a workspace name.`);
    const instructionsVersion = own.parts.instructions;
    if (!own.plugin && instructionsVersion === undefined && !own.memory.length && !opts.project) return 0;

    const need = parseVersion(own.minClaudeCodeVersion);
    const have = parseVersion(await (opts.claudeVersion ?? claudeCodeVersion)());
    if (need && (!have || olderThan(have, need))) {
      out(
        have
          ? `Claude Code ${own.minClaudeCodeVersion} or later is needed for the team setup; this computer has ${have.join(".")}.`
          : `Claude Code ${own.minClaudeCodeVersion} or later is needed for the team setup; it was not found on this computer.`
      );
      out("Update it with: claude update");
      out("Then run setup again. Nothing was changed.");
      return 3;
    }

    const home = homeDir();
    const userSettings = join(home, ".claude", "settings.json");
    const userClaudeMd = join(home, ".claude", "CLAUDE.md");
    const teamClaudeMd = join(workspaceDir(ws), "CLAUDE.md");
    const checkout = resolve(opts.dir ?? opts.cwd ?? process.cwd());
    const localSettings = join(checkout, ".claude", "settings.local.json");
    const state = await readState(ws);
    const accepted = new Set(state.accepted ?? []);
    const update = accepted.size > 0;
    const canAsk = !!opts.ask && !(opts.yes && !opts.terminal);
    let project = await chooseProject(own, opts, canAsk);
    let memoryNote: string | undefined = !project && !own.memory.length ? NO_TEAM_MEMORY_LINE : undefined;
    let memoryLeftOut = false;
    if (project && !(await keyMayPush(opts.client, ws, project))) {
      // A key that may not push (a Reader key, the console's default): the
      // memory is left out, and the plugin and the instructions go ahead.
      memoryNote = keyCannotSyncLine(project);
      project = undefined;
      memoryLeftOut = true;
    }

    // 2. What it will add, and what of it the member has not accepted yet.
    const marketplaceName = `systemdox-${ws}`;
    const marketplace = { source: { source: "url", url: own.marketplaceUrl, headersHelper: HEADERS_HELPER } };
    const items: Item[] = [];
    items.push(
      item(`the marketplace ${marketplaceName} in ${userSettings} (extraKnownMarketplaces)`, [
        `"${marketplaceName}": ${JSON.stringify(marketplace)}`,
      ])
    );

    const plugin = own.plugin;
    let previousPlugin: PluginVersion | undefined;
    if (plugin) {
      const hooks = hookLines(plugin);
      const hooksName = `the hook commands of ${ws}-setup`;
      const hooksItem = item(hooksName, hooks);
      if (update && hooks.length && !accepted.has(hooksItem.sha256)) {
        // The last hooks the member accepted, from the plugin's history.
        const versions = (await client.getPlugin(ws)).versions.filter((v) => v.version !== plugin.version);
        previousPlugin = versions
          .sort((a, b) => b.version - a.version)
          .find((v) => accepted.has(item(hooksName, hookLines(v)).sha256));
      }
      items.push(item(`the plugin ${ws}-setup, version ${plugin.version}`, [`${ws}-setup, version ${plugin.version}`]));
      if (hooks.length) {
        items.push(
          item(
            hooksName,
            hooks,
            previousPlugin ? lineDiff(hookLines(previousPlugin).join("\n"), hooks.join("\n")) : undefined
          )
        );
      }
      const servers = mcpLines(plugin);
      if (servers.length) items.push(item(`the MCP servers of ${ws}-setup`, servers));
    }

    let instructions: { version: number; content: string } | undefined;
    if (instructionsVersion !== undefined) {
      const v = await client.getPartVersion(ws, "instructions", instructionsVersion);
      const file = v.files.find((f) => f.path === "CLAUDE.md") ?? v.files[0];
      instructions = { version: v.version, content: file?.content ?? "" };
      const name = `the team instructions, written to ${teamClaudeMd}`;
      const shown = item(name, instructions.content.split(/\r?\n/));
      let diff: string[] | undefined;
      const before = state.instructions;
      if (update && !accepted.has(shown.sha256) && before && before.version !== instructions.version) {
        const old = await client.getPartVersion(ws, "instructions", before.version);
        const oldFile = old.files.find((f) => f.path === "CLAUDE.md") ?? old.files[0];
        diff = lineDiff(oldFile?.content ?? "", instructions.content);
      }
      items.push({
        ...shown,
        lines: diff ?? [`version ${instructions.version}, ${instructions.content.split(/\r?\n/).length} lines`],
      });
      items.push(item(`the import block in ${userClaudeMd}`, importBlock(ws).split("\n")));
    }

    let memoryFolder: string | undefined;
    if (project) {
      memoryFolder = join(workspaceDir(ws), "memory", project);
      for (const m of own.memory) {
        const folder = join(workspaceDir(ws), "memory", m.project);
        const count = `${m.fileCount} file${m.fileCount === 1 ? "" : "s"}`;
        items.push({ ...item(`the team memory ${m.project}`, [folder]), lines: [`${m.project}: ${count}, synced into ${folder}`] });
      }
      if (!own.memory.some((m) => m.project === project)) {
        items.push({ ...item(`the team memory ${project}`, [memoryFolder]), lines: [`${project}: new, synced into ${memoryFolder}`] });
      }
      items.push(item(`autoMemoryDirectory in ${localSettings}`, [memoryFolder]));
    }

    // The project's first sync on this computer imports the memory Claude Code
    // kept for the checkout, and each folder --import names (Amendment 3).
    const imports: MemoryImport[] =
      project && memoryFolder && !state.memory?.[project]
        ? await memoryImports(checkout, memoryFolder, opts.importDirs ?? [], opts.gitTop)
        : [];
    for (const i of imports) {
      items.push(
        item(
          `${i.named ? "the folder --import names" : "the memories Claude Code kept for this checkout"}, imported into ${project} on its first sync`,
          [`${i.folder}: ${i.files} file${i.files === 1 ? "" : "s"} to share`]
        )
      );
    }

    const pending = items.filter((i) => !accepted.has(i.sha256));
    if (pending.length) {
      if (!canAsk) {
        out(`Not set up: ${pending.length === 1 ? "this needs" : "these need"} a person at a terminal (run setup without --yes):`);
        for (const i of pending) {
          out(`- ${i.name}:`);
          for (const l of i.lines) out(`    ${l}`);
        }
        if (memoryNote) out(memoryNote);
        return 4;
      }
      out(update ? `What changed in the team setup of ${ws}:` : `The team setup of ${ws} will add:`);
      for (const i of pending) {
        out(`- ${i.name}:`);
        for (const l of i.lines) out(`    ${l}`);
      }
      if (memoryNote) out(memoryNote);
      const answer = (await opts.ask!("Set this up? [y/N] ")).trim();
      if (!/^y(es)?$/i.test(answer)) {
        out("Nothing was changed.");
        return 4;
      }
    } else if (memoryNote) {
      out(memoryNote);
    }

    // 3. Do, in this order.
    if (shouldStoreKey(opts.keySource, (await readCredentials())[ws]?.apiKey, opts.apiKey)) {
      await writeCredentials(ws, opts.apiKey);
    }

    if (instructions) {
      const next = sha256(instructions.content);
      let current: string | undefined;
      try {
        current = await readFile(teamClaudeMd, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const currentSha = current === undefined ? undefined : sha256(current);
      if (currentSha !== undefined && currentSha !== next && currentSha !== state.instructions?.sha256 && !opts.overwrite) {
        out(`${teamClaudeMd} was edited since setup installed it, so it was not replaced by version ${instructions.version}.`);
        out("Keep your text elsewhere, then run setup --overwrite to replace it.");
        return 2;
      }
      if (currentSha !== next) {
        await mkdir(dirname(teamClaudeMd), { recursive: true });
        await writeFile(teamClaudeMd, instructions.content, "utf8");
      }
      await updateState(ws, (s) => {
        s.instructions = { version: instructions!.version, sha256: next };
      });

      let text = "";
      try {
        text = await readFile(userClaudeMd, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const withBlock = withImportBlock(text, ws);
      if (withBlock !== text) {
        await mkdir(dirname(userClaudeMd), { recursive: true });
        await writeFile(userClaudeMd, withBlock, "utf8");
      }
    }

    await setInJsonFile(userSettings, ["extraKnownMarketplaces", marketplaceName], marketplace);
    await removeOldPlugins(ws);

    if (project && memoryFolder) {
      await setInJsonFile(localSettings, ["autoMemoryDirectory"], memoryFolder);
    }
    await updateState(ws, (s) => {
      // A run that left the memory out never showed its items, so what the
      // member accepted of them earlier stays accepted.
      s.accepted = [...new Set([...(memoryLeftOut ? (s.accepted ?? []) : []), ...items.map((i) => i.sha256)])];
    });
    if (project) {
      const code = await syncMemory({
        project,
        dryRun: false,
        importDirs: imports.map((i) => i.folder),
        client,
        out: (...lines) => lines.forEach((l) => out(l)),
        ask: opts.terminal ? opts.ask : undefined,
        now: opts.now,
      });
      if (code !== 0) return 1;
    }

    // 4. Finish.
    if (plugin) {
      const pluginsDir = join(home, ".claude", "plugins");
      const id = `${ws}-setup@${marketplaceName}`;
      const installed = (await readJsonQuietly(join(pluginsDir, "installed_plugins.json"))) as
        | { plugins?: Record<string, unknown> }
        | undefined;
      if (!installed?.plugins?.[id]) {
        const known = (await readJsonQuietly(join(pluginsDir, "known_marketplaces.json"))) as Record<string, unknown> | undefined;
        const install = `Run \`claude plugin install ${id}\` in your own terminal and accept the command it shows.`;
        const steps =
          known && typeof known === "object" && known[marketplaceName]
            ? ["One step is left:", `1. ${install}`]
            : ["Two steps are left:", "1. Open Claude Code once in any folder, then close it.", `2. ${install}`];
        out("");
        steps.forEach((l) => out(l));
      }
    }
    return 0;
  } catch (e) {
    out((e as Error).message);
    return 1;
  }
}

/** Remove every unpacked plugin folder but the two newest, and their records. */
async function removeOldPlugins(workspace: string): Promise<void> {
  const root = pluginRoot(workspace);
  if (!existsSync(root)) return;
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => b - a);
  const old = versions.slice(2);
  if (!old.length) return;
  for (const v of old) await removeFolder(join(root, String(v)));
  await updateState(workspace, (s) => {
    for (const v of old) delete s.plugin?.[String(v)];
  });
}

/** The command, after the MCP server step: the key and URL that step took. */
export async function runTeamSetupCommand(
  args: TeamSetupArgs,
  key: { apiKey: string; apiUrl: string; keySource?: TeamSetupOptions["keySource"] },
  io: { out: (line: string) => void; ask?: (question: string) => Promise<string>; terminal: boolean }
): Promise<number> {
  const client = new SystemDoxApiClient({ apiKey: key.apiKey, apiUrl: key.apiUrl, cacheTtlMs: 0, defaultOrg: undefined });
  return runTeamSetup({ ...args, client, apiKey: key.apiKey, keySource: key.keySource ?? "prompt", ...io });
}
