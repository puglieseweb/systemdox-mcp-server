/**
 * What the server tells every session (docs-company ADR-223,
 * specs/archive/session-brief/contract.md).
 *
 * `instructions` in the `initialize` answer reach a session's system prompt with
 * no tool call. So a computer that only has this server connected still knows
 * what its team uses: the backend's `sessionBrief.text`, plus what this computer
 * lacks. The local server looks at the disk and writes nothing; the hosted server
 * cannot see one, and says how to check. Whatever goes wrong, the server connects
 * and says so: a session that was told why is better than a server that died.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemDoxApiClient } from "./api-client.js";
import { MANIFEST_FILE, defaultSkillDir } from "./skills.js";
import { homeDir } from "./team-setup-files.js";
import type { TeamSetup } from "./team-setup-types.js";

/** Claude Code cuts a server's instructions at 2,048 characters in older versions and 4,096 now: this fits both. */
export const INSTRUCTIONS_MAX = 2000;
/**
 * The read that a session's start waits for, at most. Sessions start rarely, so
 * the read is usually a cold one: in prod on 2026-11-04 the team setup function's
 * cold start alone took 2 to 2.9 s, before the authoriser and the network, while a
 * warm read took 0.65 s. A bound that fits only a warm read would fail the common
 * case.
 */
export const BRIEF_TIMEOUT_MS = 8000;
/** What the local server sends when this computer has no key: the API refuses it. */
export const NO_KEY = "no-key-on-this-computer";

const SETUP_COMMAND = "npx -y @systemdox/mcp-server setup";

const REFUSED =
  "SystemDox refused this computer's key, so the team's rules and skills cannot be read and every SystemDox tool fails. " +
  `Tell the person once: a new key comes from the SystemDox console, Settings › API keys, and \`${SETUP_COMMAND}\` in their own terminal stores it.`;

const NOT_CHECKED =
  "SystemDox could not be read when this session started, so the team's skills were not checked. " +
  "Call get_team_setup to check again before relying on them.";

const CANNOT_SEE =
  "This server cannot see this computer's disk. For each skill listed under Team skills: if ~/.claude/skills/<name>/ is absent, or its .systemdox-skill.json names another version than get_team_setup lists, " +
  "call install_skill with that version and write what it returns, unless the latest team plugin carries it. Leave a folder with no such file alone. " +
  "If a file there differs from the hash that file holds for it, it was edited: ask the person before replacing it.";

function noKey(reason: string): string {
  return (
    `This computer has no SystemDox key it can use (${reason}), so the team's rules and skills cannot be read and every SystemDox tool fails. ` +
    `Tell the person once: \`${SETUP_COMMAND}\` in their own terminal asks for one.`
  );
}

/**
 * The reason a key could not be loaded, as words of our own. The error's message
 * goes to the server's log: it can hold a path on this computer, a long list of
 * workspaces or a value from the environment, and none of that belongs in a system
 * prompt.
 */
export function keyReason(message: string): string {
  if (/holds keys for/.test(message)) return "keys for several workspaces are stored; set SYSTEMDOX_WORKSPACE to the one to use";
  if (/holds no key for/.test(message)) return "SYSTEMDOX_WORKSPACE names a workspace with no stored key";
  if (/No SystemDox key/.test(message)) return "none is stored";
  return "the stored keys could not be read";
}

function olderApi(setup: TeamSetup): string {
  return (
    `SystemDox workspace ${setup.workspace}. Before writing code in one of its repositories, call get_context with the task and the files you expect to touch, and obey what it returns. ` +
    "get_team_setup lists the team setup."
  );
}

export interface ComputerState {
  missing: string[];
  behind: { name: string; here: number; latest: number }[];
  notFromSystemDox: string[];
  pluginInstalled: boolean;
  pluginVersion?: string;
}

async function readJsonQuietly(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The team skills against this computer's folders. Reads only. */
export async function computerState(setup: TeamSetup): Promise<ComputerState> {
  const id = `${setup.workspace}-setup@systemdox-${setup.workspace}`;
  const installed = (await readJsonQuietly(join(homeDir(), ".claude", "plugins", "installed_plugins.json"))) as
    | { plugins?: Record<string, { scope?: string; version?: string }[]> }
    | undefined;
  const entries = installed?.plugins?.[id];
  // A project-scope entry is some other checkout's. `setup` installs at user scope.
  const entry = Array.isArray(entries) ? entries.find((e) => (e?.scope ?? "user") === "user") : undefined;
  const state: ComputerState = {
    missing: [],
    behind: [],
    notFromSystemDox: [],
    pluginInstalled: !!entry,
    pluginVersion: entry?.version,
  };
  // The marketplace names version n as "n.0.0". An installed version stays until
  // the member accepts a new one (ADR-217 Am.1), so a plugin that is not the latest
  // does not carry a skill added since.
  const pluginCurrent = !!entry && !!setup.plugin && entry.version === `${setup.plugin.version}.0.0`;
  for (const skill of setup.sessionBrief?.skills ?? []) {
    const dir = defaultSkillDir(skill.name);
    if (!existsSync(dir)) {
      if (!(pluginCurrent && setup.plugin?.skills?.[skill.name] !== undefined)) state.missing.push(skill.name);
      continue;
    }
    const manifest = (await readJsonQuietly(join(dir, MANIFEST_FILE))) as { version?: unknown } | undefined;
    if (typeof manifest?.version !== "number" || !Number.isInteger(manifest.version)) {
      state.notFromSystemDox.push(skill.name);
    } else if (manifest.version !== skill.latestVersion) {
      // Not just older: a skill deleted and published again starts from 1.
      state.behind.push({ name: skill.name, here: manifest.version, latest: skill.latestVersion });
    }
  }
  return state;
}

/** Whether `setup` would add anything: a skill outside the default space is in no plugin. */
export function hasPersonParts(setup: TeamSetup): boolean {
  return (
    Object.keys(setup.parts ?? {}).length > 0 ||
    (setup.memory ?? []).length > 0 ||
    (setup.sessionBrief?.heldSkills ?? []).some((h) => h.reason === "not-plain")
  );
}

const MORE = (n: number) => `${n} more (get_team_setup lists them)`;
/** The least a list can take: its count and where to find it. */
const LIST_MIN = `all ${MORE(100)}`.length;

/** `items` joined, as many as `room` holds; the rest are counted. */
function listWithin(items: string[], room: number): string {
  const whole = items.join(", ");
  if (whole.length <= room) return whole;
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i - 1;
    const cost = items[i].length + (kept.length ? 2 : 0);
    if (used + cost + ` and ${MORE(rest)}`.length > room) break;
    kept.push(items[i]);
    used += cost;
  }
  return kept.length ? `${kept.join(", ")} and ${MORE(items.length - kept.length)}` : `all ${MORE(items.length)}`;
}

/**
 * What the local server adds, within `room`: nothing when this computer lacks
 * nothing. The sentences are fixed and the lists take what is left, so a sentence
 * is never cut. If the fixed sentences do not fit, the least urgent line goes whole.
 */
export function localSection(setup: TeamSetup, state: ComputerState, room: number): string {
  const rest = hasPersonParts(setup) ? ` and that \`${SETUP_COMMAND}\` in their own terminal adds the rest of the team setup` : "";
  // The version is named so the session installs what was checked as this session
  // started, not whatever is latest by the time it gets to it.
  const latest = new Map((setup.sessionBrief?.skills ?? []).map((s) => [s.name, s.latestVersion]));
  const lines: { head: string; items: string[]; tail: string }[] = [];
  if (state.missing.length) {
    lines.push({
      head: "On this computer, missing: ",
      items: state.missing.map((name) => `${name} version ${latest.get(name)}`),
      tail:
        `. Install each now with install_skill at that version, before your first answer. Then tell the person what you installed${rest}. ` +
        "When a skill's line matches the request and it is not loaded yet, read ~/.claude/skills/<name>/SKILL.md and follow it.",
    });
  }
  if (state.behind.length) {
    lines.push({
      head: "On this computer, behind: ",
      items: state.behind.map((b) => `${b.name} (version ${b.here} here, latest ${b.latest})`),
      tail: ". install_skill updates each to that latest version; if it refuses because files were edited, tell the person and leave them.",
    });
  }
  if (state.notFromSystemDox.length) {
    lines.push({ head: "Not from SystemDox, left alone: ", items: state.notFromSystemDox, tail: "." });
  }
  const fixed = () => lines.reduce((n, l) => n + l.head.length + l.tail.length + LIST_MIN, 0) + Math.max(0, lines.length - 1);
  while (lines.length && fixed() > room) lines.pop();
  if (!lines.length) return "";
  const share = Math.floor((room - fixed()) / lines.length) + LIST_MIN;
  return lines.map((l) => `${l.head}${listWithin(l.items, share)}${l.tail}`).join("\n");
}

/** The text and its section; never a sentence cut, and never past the limit. */
function fit(text: string, section: string): string {
  const whole = section ? `${text}\n\n${section}` : text;
  if (whole.length <= INSTRUCTIONS_MAX) return whole;
  return text.length <= INSTRUCTIONS_MAX ? text : `${text.slice(0, INSTRUCTIONS_MAX - 1)}…`;
}

export interface BriefOptions {
  localFiles?: boolean;
  /** Why the local server has no key, when it has none. */
  keyProblem?: string;
  timeoutMs?: number;
}

/** The team setup, or what to tell a session about why it could not be read. */
export async function readTeamSetup(
  apiClient: Pick<SystemDoxApiClient, "getOwnTeamSetup">,
  { keyProblem, timeoutMs = BRIEF_TIMEOUT_MS }: BriefOptions = {}
): Promise<{ setup: TeamSetup } | { problem: string }> {
  if (keyProblem) return { problem: noKey(keyProblem) };
  try {
    const setup = await apiClient.getOwnTeamSetup(AbortSignal.timeout(timeoutMs));
    return typeof setup?.workspace === "string" ? { setup } : { problem: NOT_CHECKED };
  } catch (err) {
    // By status, not by class: each build entry bundles its own copy of the class.
    const status = (err as { status?: unknown })?.status;
    return { problem: status === 401 || status === 403 ? REFUSED : NOT_CHECKED };
  }
}

/** The `instructions` of an `initialize` answer. Never throws. */
export async function sessionInstructions(
  apiClient: Pick<SystemDoxApiClient, "getOwnTeamSetup">,
  options: BriefOptions = {}
): Promise<string> {
  const read = await readTeamSetup(apiClient, options);
  if ("problem" in read) return read.problem;
  const text = read.setup.sessionBrief?.text ?? olderApi(read.setup);
  try {
    if (!options.localFiles) return fit(text, read.setup.sessionBrief?.skills?.length ? CANNOT_SEE : "");
    const room = INSTRUCTIONS_MAX - text.length - 2;
    return fit(text, localSection(read.setup, await computerState(read.setup), room));
  } catch {
    return fit(text, "");
  }
}

export { CANNOT_SEE, SETUP_COMMAND };
