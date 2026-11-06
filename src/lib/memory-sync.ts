/**
 * The team memory's merge (ADR-217 §2.3, specs/changes/team-setup/contract.md
 * "sync-memory and the MCP tool sync_memory"), pure: no disk, no network.
 * `src/sync-memory.ts` reads the folders and calls the API around it.
 *
 * - **What is shared** (`isShareable`): a `*.md` file whose frontmatter `type`
 *   is `feedback`, `project` or `reference`, and `MEMORY.md`; never a file
 *   with `share: false` or a `<name>.local-<date>.md` conflict copy.
 * - **The merge** (`decide`, `planMerge`): three-way per path, with the base
 *   (the manifest of the last sync), the team's latest version and the local
 *   folder, row by row as the contract's table says.
 * - **`MEMORY.md`** (`mergeIndex`): line by line, keyed by the file each line
 *   links to; never a `.local-` copy.
 * - **People** (`collectValues`, `rewriteValues`, `personToken`): every value
 *   the detector finds, grouped by its normalised form, and the rewrite the
 *   member agrees to.
 */

import { createHash } from "node:crypto";
import { findPersonValues, HOME_PATH, type Finding, type ValueKind } from "./person-values.js";

export const INDEX_FILE = "MEMORY.md";
export const SHAREABLE_TYPES = ["feedback", "project", "reference"] as const;

/** `{path: sha256}` (openapi Manifest). */
export type Manifest = Record<string, string>;

/** openapi FilePath: relative, forward slashes, no `.` or `..` segment. */
const FILE_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** `<name>.local-<YYYY-MM-DD>.md`, or `-2`, `-3` … after the date. */
const CONFLICT_COPY_RE = /\.local-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isFilePath(path: string): boolean {
  return path.length <= 512 && FILE_PATH_RE.test(path) && !path.split("/").some((s) => s === "." || s === "..");
}

export function isConflictCopy(path: string): boolean {
  return CONFLICT_COPY_RE.test(path.split("/").pop() ?? path);
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

/** The leading `---` block, as the backend's common/frontmatter.py finds it. */
const BLOCK_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** YAML's (1.1, as PyYAML reads it) spellings of false. */
const YAML_FALSE = new Set(["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"]);

export interface Frontmatter {
  type?: string;
  /** True when the block says `share: false` (or another YAML false). */
  shareFalse: boolean;
}

/** The frontmatter's `type` and `share`, or undefined when the file has no
 * leading block. Only top-level `key: value` lines are read. */
export function readFrontmatter(text: string): Frontmatter | undefined {
  const m = BLOCK_RE.exec(text);
  if (!m) return undefined;
  const front: Frontmatter = { shareFalse: false };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].replace(/[ \t]+#.*$/, "");
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    const value = quoted ? quoted[2] : raw;
    if (kv[1] === "type") front.type = value.trim().toLowerCase();
    if (kv[1] === "share") front.shareFalse = quoted ? value.trim().toLowerCase() === "false" : YAML_FALSE.has(value);
  }
  return front;
}

/**
 * Shared with the team: `MEMORY.md` at the folder's root, or a `*.md` file
 * whose frontmatter `type` is feedback, project or reference. Never a file
 * with `share: false`, a `.local-` conflict copy, or anything else.
 */
export function isShareable(path: string, text: string): boolean {
  if (isConflictCopy(path) || !path.endsWith(".md")) return false;
  const front = readFrontmatter(text);
  if (front?.shareFalse) return false;
  if (path === INDEX_FILE) return true;
  return !!front && (SHAREABLE_TYPES as readonly string[]).includes(front.type ?? "");
}

/** `text` with `share: false` in its frontmatter: the line is added before the
 * block's closing `---` (or replaces a `share:` line), or a block is added. */
export function addShareFalse(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = BLOCK_RE.exec(text);
  if (!m) return `---${eol}share: false${eol}---${eol}${text}`;
  const lines = m[1].split(/\r?\n/).filter((l) => !/^share[ \t]*:/.test(l));
  lines.push("share: false");
  const closing = m[0].slice(m[0].lastIndexOf("---"));
  return `---${eol}${lines.join(eol)}${eol}${closing}${text.slice(m[0].length)}`;
}

// ── Conflict copies ─────────────────────────────────────────────────────────

/** The member's calendar date, `YYYY-MM-DD`. */
export function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** `a.md` → `a.local-<date>.md`, then `a.local-<date>-2.md`, `-3` … when the
 * name is taken. */
export function conflictCopyName(path: string, date: string, taken: Set<string>): string {
  const stem = path.replace(/\.md$/, "");
  for (let n = 1; ; n++) {
    const name = `${stem}.local-${date}${n === 1 ? "" : `-${n}`}.md`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// ── The merge ───────────────────────────────────────────────────────────────

/**
 * One path's row of the contract's table (base → team, base → local):
 * - `unchanged`: both sides hold the same (or neither holds it);
 * - `local`: the team did not change it and the member changed or added it;
 *   also a file the team deleted and the member changed (the member's text
 *   is kept, never lost);
 * - `delete-team`: the team did not change it and the member deleted it;
 * - `team`: the member did not change it and the team changed or added it;
 *   also a file the member deleted and the team changed (the team's text
 *   comes back, never lost);
 * - `delete-local`: the member did not change it and the team deleted it;
 * - `conflict`: both changed it differently;
 * - `index`: `MEMORY.md` changed on both sides, merged line by line.
 */
export type Row = "unchanged" | "local" | "delete-team" | "team" | "delete-local" | "conflict" | "index";

export function decide(
  path: string,
  base: string | undefined,
  team: string | undefined,
  local: string | undefined
): Row {
  if (team === local) return "unchanged";
  if (team === base) return local === undefined ? "delete-team" : "local";
  if (local === base) return team === undefined ? "delete-local" : "team";
  if (path === INDEX_FILE && team !== undefined && local !== undefined) return "index";
  if (team === undefined) return "local";
  if (local === undefined) return "team";
  return "conflict";
}

export interface MergeInput {
  base: Manifest;
  team: Manifest;
  /** The local folder's shared files, `{path: text}`. */
  local: Record<string, string>;
  /** Paths left as they are on both sides: a file held back this run, or a
   * local file that is not shared. The team's entry is kept; nothing is
   * written to the path. */
  excluded: Set<string>;
  /** Every file name in the folder (lower case), so a conflict copy never
   * takes a name in use. */
  taken: Set<string>;
  date: string;
}

/** The rows by path, and the team hashes whose text the plan needs. */
export function decideAll(input: Omit<MergeInput, "taken" | "date">): {
  rows: Record<string, Row>;
  needed: string[];
} {
  const localHashes: Manifest = Object.fromEntries(Object.entries(input.local).map(([p, t]) => [p, sha256(t)]));
  const paths = new Set([...Object.keys(input.base), ...Object.keys(input.team), ...Object.keys(localHashes)]);
  const rows: Record<string, Row> = {};
  const needed = new Set<string>();
  for (const path of [...paths].sort()) {
    if (input.excluded.has(path)) continue;
    const row = decide(path, input.base[path], input.team[path], localHashes[path]);
    rows[path] = row;
    if (row === "team" || row === "conflict" || row === "index") needed.add(input.team[path]);
    if (row === "index" && input.base[path]) needed.add(input.base[path]);
  }
  return { rows, needed: [...needed] };
}

export interface MergePlan {
  /** The manifest to push. */
  manifest: Manifest;
  /** The text of each path whose hash the team does not hold yet. */
  upload: Record<string, string>;
  /** Files to write in the local folder (pulled, conflict pairs, the index). */
  writes: Record<string, string>;
  /** Files to delete in the local folder. */
  deletes: string[];
  pulled: string[];
  pushed: string[];
  deletedHere: string[];
  deletedFromTeam: string[];
  conflicts: { path: string; copy: string }[];
  /** `MEMORY.md` lines the team changed where the member's line was kept. */
  indexTeamLines: string[];
}

/** The plan for the rows of `decideAll`, given the text of every hash it
 * named (`texts`, `{sha256: text}`). A base `MEMORY.md` no longer readable is
 * merged as if empty. */
export function planMerge(input: MergeInput, rows: Record<string, Row>, texts: Record<string, string>): MergePlan {
  const plan: MergePlan = {
    manifest: {},
    upload: {},
    writes: {},
    deletes: [],
    pulled: [],
    pushed: [],
    deletedHere: [],
    deletedFromTeam: [],
    conflicts: [],
    indexTeamLines: [],
  };
  const taken = new Set(input.taken);
  const teamText = (path: string) => {
    const text = texts[input.team[path]];
    if (text === undefined) throw new Error(`the team's ${path} could not be read`);
    return text;
  };

  for (const path of input.excluded) if (input.team[path]) plan.manifest[path] = input.team[path];

  for (const [path, row] of Object.entries(rows)) {
    const team = input.team[path];
    const local = input.local[path];
    switch (row) {
      case "unchanged":
        if (team) plan.manifest[path] = team;
        break;
      case "local":
        plan.manifest[path] = sha256(local);
        plan.upload[path] = local;
        plan.pushed.push(path);
        break;
      case "delete-team":
        plan.deletedFromTeam.push(path);
        break;
      case "team":
        plan.manifest[path] = team;
        plan.writes[path] = teamText(path);
        plan.pulled.push(path);
        break;
      case "delete-local":
        plan.deletes.push(path);
        plan.deletedHere.push(path);
        break;
      case "conflict": {
        const copy = conflictCopyName(path, input.date, taken);
        taken.add(copy.toLowerCase());
        plan.manifest[path] = team;
        plan.writes[path] = teamText(path);
        plan.writes[copy] = local;
        plan.conflicts.push({ path, copy });
        break;
      }
      case "index": {
        const base = input.base[path] ? texts[input.base[path]] : undefined;
        const merged = mergeIndex(base, teamText(path), local);
        const hash = sha256(merged.text);
        plan.manifest[path] = hash;
        if (merged.text !== local) {
          plan.writes[path] = merged.text;
          plan.pulled.push(path);
        }
        if (hash !== team) {
          plan.upload[path] = merged.text;
          plan.pushed.push(path);
        }
        plan.indexTeamLines.push(...merged.teamLines);
        break;
      }
    }
  }
  return plan;
}

// ── MEMORY.md ───────────────────────────────────────────────────────────────

/** The file a line links to: the target of its first Markdown link. */
const LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/;

interface Entry {
  key: string;
  line: string;
}

/** Each line keyed: a linked line by the file it links to, any other line by
 * its text; a repeated key by its occurrence. */
function entries(lines: string[]): Entry[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const link = LINK_RE.exec(line);
    const id = link ? `link:${link[1]}` : `text:${line}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return { key: n ? `${id}#${n}` : id, line };
  });
}

const splitLines = (text: string) => text.split(/\r?\n/);

/**
 * `MEMORY.md` merged line by line, keyed by the file each line links to
 * (ADR-217 §2.3.3):
 * - a team line for a new file is added under the same heading (after the
 *   line it follows in the team's copy);
 * - a line the team removed and the member did not change is removed;
 * - a line with no link takes the team's text unless the member changed it;
 * - when both changed the same line, the member's line is kept and the
 *   team's is returned in `teamLines`, to be listed.
 */
export function mergeIndex(
  base: string | undefined,
  team: string,
  local: string
): { text: string; teamLines: string[] } {
  const eol = local.includes("\r\n") ? "\r\n" : "\n";
  const b = new Map(entries(base === undefined ? [] : splitLines(base)).map((e) => [e.key, e.line]));
  const teamEntries = entries(splitLines(team));
  const t = new Map(teamEntries.map((e) => [e.key, e.line]));
  const localEntries = entries(splitLines(local));
  const result: Entry[] = [];
  const teamLines: string[] = [];

  for (const e of localEntries) {
    const was = b.get(e.key);
    const theirs = t.get(e.key);
    if (theirs === e.line || theirs === was) result.push(e);
    else if (e.line === was) {
      if (theirs !== undefined) result.push({ key: e.key, line: theirs });
    } else {
      result.push(e);
      if (theirs !== undefined) teamLines.push(theirs);
    }
  }

  // A line with no link is keyed by its text, so a changed one is a line
  // removed and one added in its place (after the same line). When the team
  // and the member both replaced it, the member's is kept and the team's
  // listed.
  const baseEntries = entries(base === undefined ? [] : splitLines(base));
  const localKeys = new Set(localEntries.map((e) => e.key));
  const replacedHere = new Map<string, string>(); // base key → the line before it
  baseEntries.forEach((e, i) => {
    if (e.key.startsWith("text:") && !t.has(e.key) && !localKeys.has(e.key)) {
      replacedHere.set(e.key, i ? baseEntries[i - 1].key : "");
    }
  });

  const inResult = (key: string) => result.findIndex((e) => e.key === key);
  teamEntries.forEach((e, i) => {
    if (inResult(e.key) !== -1) return;
    const was = b.get(e.key);
    const before = i ? teamEntries[i - 1].key : "";
    const both = e.key.startsWith("text:") && [...replacedHere].find(([, prev]) => prev === before);
    if (was === undefined && both) {
      replacedHere.delete(both[0]);
      teamLines.push(e.line);
    } else if (was === undefined) {
      // Added by the team: under the line it follows there.
      let at = -1;
      for (let j = i - 1; j >= 0 && at === -1; j--) at = inResult(teamEntries[j].key);
      result.splice(at + 1, 0, e);
    } else if (e.line !== was) {
      // The member removed a line the team changed: the removal stands.
      teamLines.push(e.line);
    }
  });
  return { text: result.map((e) => e.line).join(eol), teamLines };
}

// ── People ──────────────────────────────────────────────────────────────────

export interface ValueGroup {
  kind: ValueKind;
  /** As first written. */
  value: string;
  normalised: string;
  files: string[];
  /** Where it first appears: the file, the line number and the line. */
  first: { path: string; line: number; text: string };
}

export const groupKey = (kind: string, normalised: string) => `${kind}:${normalised}`;

/** Every phone number and email address in `files`, grouped by normalised
 * value in the order first found; and the files holding a home-folder path. */
export function collectValues(files: Record<string, string>): {
  groups: ValueGroup[];
  homePaths: string[];
  findings: Record<string, Finding[]>;
} {
  const groups = new Map<string, ValueGroup>();
  const homePaths: string[] = [];
  const findings: Record<string, Finding[]> = {};
  for (const path of Object.keys(files).sort()) {
    const found = findPersonValues(files[path]);
    findings[path] = found;
    for (const f of found) {
      if (f.kind === HOME_PATH) {
        if (!homePaths.includes(path)) homePaths.push(path);
        continue;
      }
      const key = groupKey(f.kind, f.normalised);
      const group = groups.get(key);
      if (group) {
        if (!group.files.includes(path)) group.files.push(path);
      } else {
        groups.set(key, {
          kind: f.kind as ValueKind,
          value: f.value,
          normalised: f.normalised,
          files: [path],
          first: { path, line: f.line, text: splitLines(files[path])[f.line - 1].trim() },
        });
      }
    }
  }
  return { groups: [...groups.values()], homePaths, findings };
}

/** `` `<personId>` (<label>) ``: the identifier exactly as the server
 * returned it, and the role label when there is one. */
export function personToken(personId: string, label?: string): string {
  return label ? `\`${personId}\` (${label})` : `\`${personId}\``;
}

/** `text` with each finding replaced as `replacement` says (undefined leaves
 * it as written). */
export function rewriteValues(
  text: string,
  findings: Finding[],
  replacement: (f: Finding) => string | undefined
): string {
  let out = "";
  let last = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    const to = replacement(f);
    if (to === undefined) continue;
    out += text.slice(last, f.start) + to;
    last = f.end;
  }
  return out + text.slice(last);
}

/** The lines that differ between two versions of a file, as `- old` and
 * `+ new` pairs, in order. */
export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out;
}
