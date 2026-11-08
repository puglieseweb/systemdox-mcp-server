/**
 * `systemdox-mcp-server sync-memory [--project <name>] [--dir <folder>]
 * [--import <folder>]... [--dry-run]`, the core of the local MCP tool
 * `sync_memory`, and `sync-memory --hook <workspace>`, the run the team plugin
 * makes at the start and the end of a session (ADR-217 §2.3 with Amendments 2
 * and 3, specs/changes/team-setup/contract.md "sync-memory and the MCP tool
 * sync_memory").
 *
 * 1. Pull: the team's latest version (`getMemory`), the base (state.json; with
 *    none, the empty manifest, while the push names the team's latest version)
 *    and the local folder.
 * 2. People: every value in the shared files, grouped; `lookupValues`; in a
 *    terminal only, one question per unanswered value, then one y/N over the
 *    whole rewrite. Without a terminal nothing is asked or rewritten, and a
 *    file still holding a value is skipped and listed.
 * 3. The merge (lib/memory-sync.ts), written to the local folder.
 * 4. The push on the base; on 409 SYD-K010 pull, merge again and retry once.
 *    state.json takes the new base only after the push succeeds.
 *
 * Exit codes: 0 synced; 1 usage, no key, or the API refused; 2 the push was
 * refused twice on a stale base. `--hook` always exits 0: it syncs only the
 * projects this computer synced before, asks nothing, prints one line per
 * project (and a line for conflict copies and one for waiting files), appends
 * the full report to the workspace's sync-memory.log, holds sync.lock, keeps
 * to a 20-second budget and never holds a session up.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SystemDoxApiClient, type SystemDoxApiError } from "./lib/api-client.js";
import {
  addShareFalse,
  collectValues,
  decideAll,
  groupKey,
  INDEX_FILE,
  isFilePath,
  isShareable,
  lineDiff,
  localDate,
  personToken,
  planMerge,
  rewriteValues,
  conflictCopyName,
  type Manifest,
  type MergePlan,
  type ValueGroup,
} from "./lib/memory-sync.js";
import { findPersonValues, findSecrets, HOME_PATH, normalise } from "./lib/person-values.js";
import {
  apiKeyFor,
  apiUrlFrom,
  isWorkspace,
  localApiKey,
  readState,
  syncLockPath,
  syncLogPath,
  updateState,
  workspaceDir,
  type CommandIo,
} from "./lib/team-setup-files.js";
import type { FoundValue, ValueAnswer } from "./lib/team-setup-types.js";

export const SYNC_MEMORY_USAGE =
  "Usage: systemdox-mcp-server sync-memory [--project <name>] [--dir <folder>] [--import <folder>]... [--dry-run]\n" +
  "       systemdox-mcp-server sync-memory --hook <workspace>";
/** The hook run's budget, lock staleness and log size (contract.md "--hook"). */
export const HOOK_BUDGET_MS = 20_000;
export const HOOK_LOCK_STALE_MS = 60_000;
export const HOOK_LOG_MAX_BYTES = 1024 * 1024;
export const SYNC_MEMORY_COMMAND = "npx -y @systemdox/mcp-server sync-memory";

export type SyncClient = Pick<
  SystemDoxApiClient,
  | "getOwnTeamSetup"
  | "getMemory"
  | "readBlobs"
  | "findMissingBlobs"
  | "uploadBlobs"
  | "pushMemoryVersion"
  | "lookupValues"
  | "answerValues"
  | "fileMemoryPeople"
>;

export interface SyncMemoryArgs {
  project?: string;
  dir?: string;
  /** Folders to import on this sync, in order (`--import`, repeatable). */
  importDirs?: string[];
  dryRun: boolean;
  /** `--hook <workspace>`: the run the team plugin makes. */
  hook?: string;
}

/** What a sync came to, for the hook run's one line (never a value). */
export interface SyncSummary {
  outcome: "synced" | "moved-on" | "failed";
  /** For `failed`: why, in a few words. */
  reason?: string;
  version: number;
  pulled: number;
  pushed: number;
  deleted: number;
  /** The `.local-<date>.md` copies this run wrote. */
  conflictCopies: string[];
  /**
   * The files held back for the member at a terminal (a value nobody answered
   * for, a value to rewrite, the vault not answering), sorted. A secret or a
   * refusal is not here: it is in the log.
   */
  waiting: string[];
}

export interface SyncMemoryOptions extends SyncMemoryArgs {
  client: SyncClient;
  /** Each argument is one line of the report. */
  out: (...lines: string[]) => void;
  /** A person at a terminal. Absent for the MCP tool, a hook or CI: then
   * nothing is asked and nothing is rewritten. */
  ask?: (question: string) => Promise<string>;
  now?: () => Date;
  /** Told what the sync came to, once, at its end. */
  summary?: (summary: SyncSummary) => void;
  /** The workspace the run is for (`--hook <workspace>`): a key for another one syncs nothing. */
  workspace?: string;
  /** Epoch ms: past it, nothing more is written or sent (the hook's budget). */
  deadline?: number;
  /** A hook run: a project the team no longer serves is left as it is. */
  unattended?: boolean;
}

/** A usage error or a refusal: exit 1 with the message. */
class SyncFailed extends Error {}

/** A run that stopped on purpose, with the reason the hook's line gives. */
class SyncStopped extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

/** The reason a failed run gives, in a few words; never a value. */
function failureReason(e: unknown): string {
  if (e instanceof SyncStopped) return e.reason;
  const { status, code } = refusal(e);
  if (status !== undefined) return code ? `SystemDox refused it, ${code}` : "SystemDox refused it";
  const err = e as NodeJS.ErrnoException & { cause?: { code?: string } };
  const net = err?.cause?.code ?? err?.code ?? "";
  if (e instanceof TypeError || /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR)/.test(net)) {
    return "SystemDox could not be reached";
  }
  return "it could not finish";
}

/** Write a file whole or not at all: a temporary file beside it, then a rename. */
async function writeWhole(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** A refused API call's status and SYD code. Read from the error rather than
 * by `instanceof`: each entry point bundles its own copy of the client, so
 * the class a caller's client throws need not be this module's. */
function refusal(e: unknown): { status?: number; code?: string } {
  if (!(e instanceof Error)) return {};
  const { status, code } = e as Partial<SystemDoxApiError>;
  return { status: typeof status === "number" ? status : undefined, code: typeof code === "string" ? code : undefined };
}

export function parseSyncMemoryArgs(argv: string[]): SyncMemoryArgs {
  const args: SyncMemoryArgs = { dryRun: false, importDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--project" || a === "--dir" || a === "--import" || a === "--hook") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new SyncFailed(`${a} needs a value\n${SYNC_MEMORY_USAGE}`);
      if (a === "--project") {
        if (!isWorkspace(value)) throw new SyncFailed(`${value} is not a project name (lower case letters, digits and -)`);
        args.project = value;
      } else if (a === "--hook") {
        if (!isWorkspace(value)) throw new SyncFailed(`${value} is not a workspace name (lower case letters, digits and -)`);
        args.hook = value;
      } else if (a === "--dir") args.dir = value;
      else args.importDirs!.push(value);
    } else throw new SyncFailed(`Unexpected argument ${a}\n${SYNC_MEMORY_USAGE}`);
  }
  if (args.hook && (args.project || args.dir || args.importDirs!.length || args.dryRun)) {
    throw new SyncFailed(`--hook takes no other option\n${SYNC_MEMORY_USAGE}`);
  }
  return args;
}

// ── The local folder ────────────────────────────────────────────────────────

const toPath = (root: string, rel: string) => join(root, ...rel.split("/"));

/** A temporary file `writeWhole` leaves behind when a run is killed between
 * the write and the rename: `<name>.<pid>.<random>.tmp`. */
const LEFT_TEMP_RE = /\.\d+\.[a-z0-9]+\.tmp$/;

/** Every `*.md` file under `root` with its text (hidden entries left out),
 * and every file name there (lower case). */
async function readFolder(root: string): Promise<{ files: Record<string, string>; names: Set<string>; temps: string[] }> {
  const files: Record<string, string> = {};
  const names = new Set<string>();
  const temps: string[] = [];
  async function walk(dir: string, prefix: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else if (e.isFile()) {
        names.add(rel.toLowerCase());
        if (LEFT_TEMP_RE.test(e.name)) temps.push(rel);
        if (e.name.endsWith(".md")) files[rel] = await readFile(join(dir, e.name), "utf8");
      }
    }
  }
  if (existsSync(root)) await walk(root, "");
  return { files, names, temps };
}

// ── The team ────────────────────────────────────────────────────────────────

interface TeamVersion {
  version: number;
  manifest: Manifest;
  exists: boolean;
}

async function pullTeam(client: SyncClient, ws: string, project: string): Promise<TeamVersion> {
  try {
    const latest = await client.getMemory(ws, project);
    return {
      version: latest.version,
      manifest: Object.fromEntries(Object.entries(latest.files).map(([p, f]) => [p, f.sha256])),
      exists: true,
    };
  } catch (e) {
    if (refusal(e).status === 404) return { version: 0, manifest: {}, exists: false };
    throw e;
  }
}

/** `{sha256: text}` for `hashes`; a hash no kept version names any more
 * (404) is left out. */
async function readTexts(client: SyncClient, ws: string, project: string, hashes: string[]) {
  const texts: Record<string, string> = {};
  const one = async (batch: string[]) => {
    let left = batch;
    while (left.length) {
      const got = await client.readBlobs(ws, project, left);
      for (const b of got.blobs) texts[b.sha256] = b.content;
      if (!got.blobs.length) break;
      left = got.remaining;
    }
  };
  for (let i = 0; i < hashes.length; i += 1000) {
    const batch = hashes.slice(i, i + 1000);
    try {
      await one(batch);
    } catch (e) {
      if (!(refusal(e).status === 404)) throw e;
      for (const h of batch) {
        try {
          await one([h]);
        } catch (err) {
          if (!(refusal(err).status === 404)) throw err;
        }
      }
    }
  }
  return texts;
}

// ── The report ──────────────────────────────────────────────────────────────

interface Answered {
  kind: string;
  answer: string;
  label?: string;
  personId?: string;
  files?: number;
}

class Report {
  pulled = new Set<string>();
  pushed = new Set<string>();
  deletedHere = new Set<string>();
  deletedFromTeam = new Set<string>();
  conflicts: string[] = [];
  /** The conflict copies written this run, by name. */
  copies = new Set<string>();
  skipped = new Map<string, string>();
  /** Skipped files a sync in the member's terminal can send: held for a value, or for the vault. */
  waiting = new Set<string>();
  people: Answered[] = [];
  toAnswer = new Map<string, number>();

  add(plan: MergePlan) {
    plan.pulled.forEach((p) => this.pulled.add(p));
    plan.pushed.forEach((p) => this.pushed.add(p));
    plan.deletedHere.forEach((p) => this.deletedHere.add(p));
    plan.deletedFromTeam.forEach((p) => this.deletedFromTeam.add(p));
    for (const c of plan.conflicts) {
      this.conflicts.push(`${c.path}: the team's text; yours is beside it as ${c.copy}`);
      this.copies.add(c.copy);
    }
    for (const line of plan.indexTeamLines) this.conflicts.push(`${INDEX_FILE}: your line was kept; the team's was: ${line}`);
  }

  skip(path: string, reason: string) {
    if (!this.skipped.has(path)) this.skipped.set(path, reason);
  }

  /** Skipped, and waiting for the member at a terminal. */
  wait(path: string, reason: string) {
    this.skip(path, reason);
    this.waiting.add(path);
  }

  summary(outcome: SyncSummary["outcome"], version: number, reason?: string): SyncSummary {
    return {
      outcome,
      ...(reason ? { reason } : {}),
      version,
      pulled: this.pulled.size,
      pushed: this.pushed.size,
      deleted: this.deletedHere.size + this.deletedFromTeam.size,
      conflictCopies: [...this.copies].sort(),
      waiting: [...this.waiting].sort(),
    };
  }

  lines(summary: string, dryRun: boolean): string[] {
    const out = [summary];
    const section = (title: string, items: string[]) => {
      if (items.length) out.push("", `${title}:`, ...items.map((i) => `- ${i}`));
    };
    const sorted = (s: Set<string>) => [...s].sort();
    section(dryRun ? "Would pull" : "Pulled", sorted(this.pulled));
    section(dryRun ? "Would push" : "Pushed", sorted(this.pushed));
    section(dryRun ? "Would delete" : "Deleted", [
      ...sorted(this.deletedHere).map((p) => `${p} (here: the team deleted it)`),
      ...sorted(this.deletedFromTeam).map((p) => `${p} (from the team: you deleted it)`),
    ]);
    section("Conflicts", this.conflicts);
    section(
      "Skipped",
      [...this.skipped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, why]) => `${p}: ${why}`)
    );
    section(
      "People",
      this.people.map((a) =>
        [a.kind, a.answer, a.label, a.personId && `\`${a.personId}\``, a.files !== undefined && `${a.files} files`]
          .filter(Boolean)
          .join(", ")
      )
    );
    if (this.toAnswer.size) {
      out.push(
        "",
        `Values still to answer: ${[...this.toAnswer.entries()].map(([kind, n]) => `${n} ${kind}`).join(", ")}.`
      );
    }
    return out;
  }
}

const ANSWER_WORDS: Record<string, string> = {
  member: "a member's contact",
  person: "someone else",
  ours: "ours, not a person",
};

// ── People ──────────────────────────────────────────────────────────────────

interface PeopleResult {
  /** The shared files after the answers and the rewrite. */
  files: Record<string, string>;
  /** Paths held back this run (skipped and listed). */
  held: Set<string>;
  /** Paths written `share: false` this run. */
  leftOut: Set<string>;
}

function labelProblem(label: string): string | undefined {
  if (!label) return "a label is needed";
  if (label.length > 60) return "a label is at most 60 characters";
  if (findPersonValues(label).length) return "a label is a role, never a phone number, an email address or a path";
  return undefined;
}

async function askLabel(ask: (q: string) => Promise<string>, out: (l: string) => void, question: string, optional: boolean) {
  for (;;) {
    const label = (await ask(question)).trim();
    if (optional && !label) return undefined;
    const problem = labelProblem(label);
    if (!problem) return label;
    out(`  ${problem}.`);
  }
}

async function people(
  opts: SyncMemoryOptions,
  ws: string,
  files: Record<string, string>,
  report: Report,
  hint: string
): Promise<PeopleResult> {
  const { client, out, ask, dryRun } = opts;
  const terminal = !!ask && !dryRun;
  const held = new Set<string>();
  const leftOut = new Set<string>();
  const current = { ...files };

  for (const [path, text] of Object.entries(current)) {
    const secret = findSecrets(text)[0];
    if (secret) {
      held.add(path);
      report.skip(path, `a secret (${secret.kind}) on line ${secret.line}: remove it, then sync again`);
    }
  }

  const { groups, findings } = collectValues(current);
  const answers = new Map<string, ValueAnswer>();
  for (let i = 0; i < groups.length; i += 500) {
    const batch = groups.slice(i, i + 500);
    const got = await client.lookupValues(ws, batch.map((g) => ({ kind: g.kind, value: g.value })));
    batch.forEach((g, j) => {
      const a = got.answers[j];
      if (a && a.answer !== "unanswered") answers.set(groupKey(g.kind, g.normalised), a);
    });
  }

  const vaultDown = new Set<string>();
  if (terminal) {
    const filed: { groups: ValueGroup[]; label: string }[] = [];
    for (const g of groups) {
      const key = groupKey(g.kind, g.normalised);
      if (answers.has(key)) continue;
      let choices = ["m", "p", "o", "x", "s"];
      for (;;) {
        const question = [
          `${g.value} (${g.kind}) is in ${g.files.length} file${g.files.length === 1 ? "" : "s"}. First line it appears on, in ${g.first.path}:`,
          `  ${g.first.text}`,
          [
            choices.includes("m") && "[m] a member's contact",
            "[p] someone else",
            "[o] ours, not a person",
            "[x] leave these files out",
            "[s] skip for now",
          ]
            .filter(Boolean)
            .join("  "),
          `Answer (${choices.join("/")}): `,
        ].join("\n");
        const answer = (await ask!(question)).trim().toLowerCase();
        if (!choices.includes(answer)) continue;
        if (answer === "s") break;
        if (answer === "x") {
          for (const path of g.files) {
            if (leftOut.has(path)) continue;
            current[path] = addShareFalse(current[path]);
            await writeWhole(toPath(opts.dir!, path), current[path]);
            leftOut.add(path);
          }
          report.people.push({ kind: g.kind, answer: "left out (share: false)", files: g.files.length });
          break;
        }
        if (answer === "p") {
          const label = (await askLabel(ask!, out, "Their role, as a label (e.g. reseller, sales; never a name): ", false))!;
          let entry = filed.length
            ? await (async () => {
                const list = filed.map((f, i) => `  ${i + 1}. ${f.label}: ${f.groups.map((x) => x.value).join(", ")}`);
                for (;;) {
                  const same = (
                    await ask!(["The same person as one filed above?", ...list, "Number, or Enter for a new person: "].join("\n"))
                  ).trim();
                  if (!same) return undefined;
                  const n = Number(same);
                  if (Number.isInteger(n) && n >= 1 && n <= filed.length && filed[n - 1].groups.length < 4) return filed[n - 1];
                }
              })()
            : undefined;
          if (!entry) {
            entry = { groups: [], label };
            filed.push(entry);
          }
          entry.groups.push(g);
          break;
        }
        const label = answer === "m" ? await askLabel(ask!, out, "A role label for it (e.g. owner, business mobile), or Enter for none: ", true) : undefined;
        let result;
        try {
          result = await client.answerValues(ws, [
            { kind: g.kind, value: g.value, answer: answer === "m" ? "member" : "ours", ...(label ? { label } : {}) },
          ]);
        } catch (e) {
          if (refusal(e).code === "SYD-K019") {
            vaultDown.add(key);
            out("  The vault did not answer (SYD-K019): the files holding it wait for the next sync.");
            break;
          }
          throw e;
        }
        if (result.stored[0]) {
          answers.set(key, result.stored[0]);
          report.people.push({ kind: g.kind, answer: ANSWER_WORDS[result.stored[0].answer], label: result.stored[0].label, personId: result.stored[0].personId });
          break;
        }
        const refused = result.refused[0];
        if (refused?.code === "SYD-K021") {
          out(`  ${refused.detail}. Add them in Staff first, or answer p to file them.`);
          choices = choices.filter((c) => c !== "m");
        } else if (refused) out(`  ${refused.detail}`);
      }
    }

    for (let i = 0; i < filed.length; i += 50) {
      const batch = filed.slice(i, i + 50);
      let result;
      try {
        result = await client.fileMemoryPeople(
          ws,
          batch.map((f) => ({ values: f.groups.map((g) => ({ kind: g.kind, value: g.value })), label: f.label }))
        );
      } catch (e) {
        if (refusal(e).code === "SYD-K019") {
          out("Contacts did not answer (SYD-K019): the files holding those values wait for the next sync.");
          batch.forEach((f) => f.groups.forEach((g) => vaultDown.add(groupKey(g.kind, g.normalised))));
          continue;
        }
        throw e;
      }
      for (const stored of result.stored) {
        let key: string;
        try {
          key = groupKey(stored.kind, normalise(stored.kind, stored.value));
        } catch {
          continue;
        }
        answers.set(key, stored);
      }
      for (const r of result.refused) {
        out(`  ${batch[r.index]?.label ?? ""}: ${r.detail}`);
      }
      for (const f of batch) {
        const a = answers.get(groupKey(f.groups[0].kind, f.groups[0].normalised));
        if (a?.answer === "person") {
          for (const g of f.groups) report.people.push({ kind: g.kind, answer: ANSWER_WORDS.person, label: a.label, personId: a.personId });
        }
      }
    }
  }

  // The rewrite: a member or person value becomes its token, a home path ~,
  // an ours value stays as written.
  const rewritten: Record<string, string> = {};
  for (const [path, text] of Object.entries(current)) {
    if (leftOut.has(path) || held.has(path)) continue;
    const next = rewriteValues(text, findings[path] ?? [], (f) => {
      if (f.kind === HOME_PATH) return "~";
      const a = answers.get(groupKey(f.kind, f.normalised));
      return a && (a.answer === "member" || a.answer === "person") && a.personId ? personToken(a.personId, a.label) : undefined;
    });
    if (next !== text) rewritten[path] = next;
  }
  const paths = Object.keys(rewritten).sort();
  if (paths.length && terminal) {
    out("", "The rewrite:");
    for (const path of paths) out(path, ...lineDiff(current[path], rewritten[path]).map((l) => `  ${l}`));
    const yes = /^y(es)?$/i.test((await ask!(`Rewrite ${paths.length} file${paths.length === 1 ? "" : "s"} as shown? [y/N] `)).trim());
    if (yes) {
      for (const path of paths) {
        await writeWhole(toPath(opts.dir!, path), rewritten[path]);
        current[path] = rewritten[path];
      }
    }
  }

  // A file still holding a value (not ours) or a home path is held back.
  for (const [path, text] of Object.entries(current)) {
    if (leftOut.has(path) || held.has(path)) continue;
    const pending = findPersonValues(text).filter((f) => {
      if (f.kind === HOME_PATH) return true;
      return answers.get(groupKey(f.kind, f.normalised))?.answer !== "ours";
    });
    if (!pending.length) continue;
    held.add(path);
    const keys = pending.filter((f) => f.kind !== HOME_PATH).map((f) => groupKey(f.kind, f.normalised));
    if (keys.some((k) => vaultDown.has(k))) {
      report.wait(path, "the vault did not answer (SYD-K019) for a value in it; it syncs once the value is filed");
    } else if (keys.some((k) => !answers.has(k))) {
      report.wait(path, `it holds a value nobody has answered for: run \`${hint}\` in a terminal`);
    } else {
      report.wait(path, `it holds a value to rewrite as its identifier or ~: run \`${hint}\` in a terminal`);
    }
  }

  for (const g of groups) {
    const key = groupKey(g.kind, g.normalised);
    if (!answers.has(key) && g.files.some((p) => !leftOut.has(p))) {
      report.toAnswer.set(g.kind, (report.toAnswer.get(g.kind) ?? 0) + 1);
    }
  }

  return { files: current, held, leftOut };
}

// ── The sync ────────────────────────────────────────────────────────────────

/** Remove the temporary files an earlier, killed run left in the folder. */
async function removeLeftTemps(dir: string, temps: string[]) {
  for (const rel of temps) await rm(toPath(dir, rel), { force: true });
}

/** Write the merge into the folder, each file whole or not at all, so a run
 * stopped part way never leaves half a file for the next sync to push. */
async function applyPlan(dir: string, plan: MergePlan) {
  for (const [path, text] of Object.entries(plan.writes)) await writeWhole(toPath(dir, path), text);
  for (const path of plan.deletes) await rm(toPath(dir, path), { force: true });
}

const sameManifest = (a: Manifest, b: Manifest) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([p, h]) => b[p] === h);

/** Upload what the team lacks; a refused blob's path keeps the team's entry
 * and is listed as skipped with the server's reason. */
async function upload(client: SyncClient, ws: string, project: string, plan: MergePlan, team: Manifest, report: Report) {
  const byHash = new Map<string, string[]>();
  for (const path of Object.keys(plan.upload)) {
    const h = plan.manifest[path];
    byHash.set(h, [...(byHash.get(h) ?? []), path]);
  }
  const hashes = [...byHash.keys()];
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += 10000) {
    missing.push(...(await client.findMissingBlobs(ws, project, hashes.slice(i, i + 10000))).missing);
  }
  const blobs = missing.map((h) => ({ sha256: h, content: plan.upload[byHash.get(h)![0]] }));
  let batch: typeof blobs = [];
  let bytes = 0;
  const send = async () => {
    if (!batch.length) return;
    const result = await client.uploadBlobs(ws, project, batch);
    for (const r of result.refused) {
      for (const path of byHash.get(r.sha256) ?? []) {
        if (team[path]) plan.manifest[path] = team[path];
        else delete plan.manifest[path];
        plan.pushed = plan.pushed.filter((p) => p !== path);
        report.pushed.delete(path);
        report.skip(path, `refused by SystemDox, ${r.detail.startsWith(r.code) ? r.detail : `${r.code}: ${r.detail}`}`);
      }
    }
    batch = [];
    bytes = 0;
  };
  for (const blob of blobs) {
    const size = Buffer.byteLength(blob.content, "utf8");
    if (batch.length === 100 || (batch.length && bytes + size > 5 * 1024 * 1024 - 64 * 1024)) await send();
    batch.push(blob);
    bytes += size;
  }
  await send();
}

/**
 * Sync one project's team memory. Returns the exit code; every line of the
 * report goes to `opts.out`.
 */
export async function syncMemory(opts: SyncMemoryOptions): Promise<number> {
  const { client, out } = opts;
  const now = opts.now?.() ?? new Date();
  try {
    const checkDeadline = () => {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        throw new SyncStopped("took too long", "Stopped: the sync's time ran out before anything more was written or sent.");
      }
    };
    const own = await client.getOwnTeamSetup();
    const ws = own.workspace;
    if (opts.workspace && ws !== opts.workspace) {
      throw new SyncStopped(
        "the key is for another workspace",
        `The key is for ${ws}, not ${opts.workspace}: nothing was synced. Set SYSTEMDOX_API_KEY to a key of ${opts.workspace}, or unset it.`
      );
    }
    const project = opts.project ?? (own.memory.length === 1 ? own.memory[0].project : undefined);
    if (!project) {
      throw new SyncFailed(
        own.memory.length
          ? `${ws} has ${own.memory.length} team memories (${own.memory.map((m) => m.project).join(", ")}): name one with --project.`
          : `${ws} has no team memory yet: name the project to start with --project.`
      );
    }
    const dir = resolve(opts.dir ?? join(workspaceDir(ws), "memory", project));
    const run: SyncMemoryOptions = { ...opts, dir };
    const hint = [SYNC_MEMORY_COMMAND, `--project ${project}`, opts.dir ? `--dir "${opts.dir}"` : ""].filter(Boolean).join(" ");
    const report = new Report();
    const date = localDate(now);

    const stored = (await readState(ws)).memory?.[project];
    let team = await pullTeam(client, ws, project);
    if (opts.unattended && stored && !team.exists) {
      // A project this computer synced that the team no longer serves (gone, or
      // no longer readable): merging against nothing would delete every file
      // here with nobody at the terminal. Leave it for the member.
      throw new SyncStopped(
        "the team memory could not be read",
        `${ws}/${project} could not be read from SystemDox: nothing was changed. Run sync-memory in your terminal to see why.`
      );
    }
    // With no base in state.json (a first sync) the merge's base is the empty
    // manifest, so every file on either side is an addition and nothing is
    // deleted; the push still names the team's latest version (proposal item 23).
    let base: TeamVersion = stored
      ? { version: stored.version, manifest: stored.manifest, exists: true }
      : { version: 0, manifest: {}, exists: false };

    // The local folder, and the other folder when importing.
    const folder = await readFolder(dir);
    const shared: Record<string, string> = {};
    const notShared = new Set<string>();
    for (const [path, text] of Object.entries(folder.files)) {
      if (!isShareable(path, text)) notShared.add(path);
      else if (!isFilePath(path)) {
        notShared.add(path);
        report.skip(path, "its name has characters a team memory path cannot hold (letters, digits, '.', '_', '-')");
      } else shared[path] = text;
    }
    // The folders to import, in order, after the local folder: a path already
    // present (here, or from an earlier folder) with different text becomes a
    // conflict pair, the later copy taking the .local- name.
    const importWrites: Record<string, string> = {};
    const current: Record<string, string> = { ...folder.files };
    const taken = new Set(folder.names);
    for (const importDir of opts.importDirs ?? []) {
      const other = await readFolder(resolve(importDir));
      for (const [path, text] of Object.entries(other.files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!isShareable(path, text) || !isFilePath(path)) continue;
        const here = current[path];
        if (here === undefined) {
          shared[path] = text;
          current[path] = text;
          importWrites[path] = text;
          taken.add(path.toLowerCase());
        } else if (here !== text) {
          const copy = conflictCopyName(path, date, taken);
          taken.add(copy.toLowerCase());
          importWrites[copy] = text;
          report.conflicts.push(`${path}: this folder's text; the imported one is beside it as ${copy}`);
          report.copies.add(copy);
        }
      }
    }
    folder.names = taken;
    if (!opts.dryRun) {
      checkDeadline();
      for (const [path, text] of Object.entries(importWrites)) await writeWhole(toPath(dir, path), text);
    }

    const found = await people(run, ws, shared, report, hint);
    for (const path of found.leftOut) {
      delete found.files[path];
      notShared.add(path);
    }
    const excluded = new Set([...found.held, ...notShared]);
    for (const path of found.held) delete found.files[path];

    // Merge, write, push; on a stale base pull, merge again and retry once.
    for (let attempt = 1; ; attempt++) {
      const input = { base: base.manifest, team: team.manifest, local: found.files, excluded, taken: folder.names, date };
      const { rows, needed } = decideAll(input);
      const texts = needed.length ? await readTexts(client, ws, project, needed) : {};
      const plan = planMerge(input, rows, texts);
      report.add(plan);

      if (opts.dryRun) {
        const skipped = report.skipped.size;
        out(
          ...report.lines(
            `Dry run of ${ws}/${project} against version ${team.version}: would pull ${report.pulled.size}, push ${report.pushed.size} and delete ${report.deletedHere.size + report.deletedFromTeam.size}; ${report.conflicts.length} conflicts, ${skipped} skipped. Nothing was asked, written or sent.`,
            true
          )
        );
        return 0;
      }

      checkDeadline();
      if (attempt === 1) await removeLeftTemps(dir, folder.temps);
      await applyPlan(dir, plan);
      let version = team.version;
      if (!sameManifest(plan.manifest, team.manifest)) {
        checkDeadline();
        await upload(client, ws, project, plan, team.manifest, report);
      }
      if (!sameManifest(plan.manifest, team.manifest)) {
        checkDeadline();
        try {
          version = (await client.pushMemoryVersion(ws, project, { baseVersion: team.version, manifest: plan.manifest })).version;
        } catch (e) {
          if (!(refusal(e).status === 409 && refusal(e).code === "SYD-K010")) throw e;
          if (attempt === 2) {
            out(
              ...report.lines(
                `Not pushed: ${ws}/${project} moved on twice while this sync merged. Your folder holds the merge; run sync-memory again.`,
                false
              )
            );
            opts.summary?.(report.summary("moved-on", team.version, "moved on twice"));
            return 2;
          }
          // The folder now holds the merge with `team`: that is the new base.
          base = team;
          for (const p of plan.pushed) report.pushed.delete(p);
          const again = await readFolder(dir);
          folder.names = again.names;
          found.files = {};
          for (const [path, text] of Object.entries(again.files)) {
            if (excluded.has(path) || !isShareable(path, text) || !isFilePath(path)) continue;
            found.files[path] = text;
          }
          team = await pullTeam(client, ws, project);
          continue;
        }
      }
      await updateState(ws, (state) => {
        state.memory = { ...state.memory, [project]: { version, manifest: plan.manifest } };
      });
      out(
        ...report.lines(
          `Synced ${ws}/${project} at version ${version}: ${report.pulled.size} pulled, ${report.pushed.size} pushed, ${report.deletedHere.size + report.deletedFromTeam.size} deleted, ${report.conflicts.length} conflicts, ${report.skipped.size} skipped.`,
          false
        )
      );
      opts.summary?.(report.summary("synced", version));
      return 0;
    }
  } catch (e) {
    out((e as Error).message);
    opts.summary?.({
      outcome: "failed",
      reason: failureReason(e),
      version: 0,
      pulled: 0,
      pushed: 0,
      deleted: 0,
      conflictCopies: [],
      waiting: [],
    });
    return 1;
  }
}

// ── The hook run ────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many waiting files the hook's line names before it says "and n more". */
export const HOOK_WAITING_NAMED = 5;

/** The first names, then "and n more" (contract.md "--hook", item 30). */
function firstNames(names: string[]): string {
  const shown = names.slice(0, HOOK_WAITING_NAMED).join(", ");
  const rest = names.length - HOOK_WAITING_NAMED;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * The lines the hook prints for one project (contract.md "--hook"): files and
 * counts, never a value. A run that did not finish says only that the next
 * session tries again: a push refused twice leaves the merge in the folder,
 * so the files are not always as they were.
 */
export function hookLines(ws: string, project: string, folder: string, s: SyncSummary): string[] {
  if (s.outcome !== "synced") {
    return [`Team memory ${ws}/${project}: not synced (${s.reason ?? "it did not finish"}); the next session tries again.`];
  }
  const lines = [`Team memory ${ws}/${project}: version ${s.version}, ${s.pulled} pulled, ${s.pushed} pushed, ${s.deleted} deleted.`];
  if (s.conflictCopies.length) {
    lines.push(`  ${plural(s.conflictCopies.length, "conflict copy", "conflict copies")} to tidy in ${folder}: ${s.conflictCopies.join(", ")}`);
  }
  if (s.waiting.length) {
    lines.push(
      `  ${plural(s.waiting.length, "file waits", "files wait")} for you (${firstNames(s.waiting)}): ` +
        `run \`${SYNC_MEMORY_COMMAND} --project ${project}\` in your terminal.`
    );
  }
  return lines;
}

/** Append a run's report to the workspace's log; the file is started again past its size. */
async function appendLog(ws: string, lines: string[]): Promise<void> {
  const path = syncLogPath(ws);
  await mkdir(dirname(path), { recursive: true });
  try {
    if ((await stat(path)).size > HOOK_LOG_MAX_BYTES) await writeFile(path, "", "utf8");
  } catch {
    // no log yet
  }
  await appendFile(path, lines.join("\n") + "\n", "utf8");
}

export interface HookIo extends CommandIo {
  client?: SyncClient;
  now?: () => Date;
  /** The budget and the lock's staleness, for tests. */
  budgetMs?: number;
  lockStaleMs?: number;
  /** Epoch ms the budget counts from: the process start for the CLI (npx and
   * loading count against Claude Code's 30 seconds too), now otherwise. */
  startedAt?: number;
}

/** Take the workspace's lock: created only if absent; a lock older than its
 * staleness is removed and taken once more. True when this run holds it. */
async function takeLock(lock: string, staleMs: number, now: Date): Promise<boolean> {
  await mkdir(dirname(lock), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: now.toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(body, "utf8");
      } catch (err) {
        await handle.close();
        await rm(lock, { force: true }); // an empty lock would hold every hook back
        throw err;
      }
      await handle.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let seen;
      try {
        seen = await stat(lock);
      } catch {
        continue; // released between the two calls: try again
      }
      if (Date.now() - seen.mtimeMs < staleMs || attempt === 1) return false;
      // Remove it only if it is still the lock judged stale: another run may
      // have taken it over in between.
      try {
        const now2 = await stat(lock);
        if (now2.ino !== seen.ino || now2.mtimeMs !== seen.mtimeMs) return false;
      } catch {
        continue;
      }
      await rm(lock, { force: true });
    }
  }
  return false;
}

/** Release the lock only if this process holds it. */
async function releaseLock(lock: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lock, "utf8")) as { pid?: number };
    if (held.pid === process.pid) await rm(lock, { force: true });
  } catch {
    // gone already, or not ours to read
  }
}

/**
 * `sync-memory --hook <workspace>`: the run the team plugin makes at the start
 * and the end of a session. Every project this computer has synced before, in
 * its default folder; never a first sync; one line per project on stdout (plus
 * a line for conflict copies and one for waiting files), the full report in
 * the log; one run at a time per workspace; a budget; exit 0 whatever happens.
 */
export async function runHookSync(workspace: string, io: HookIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    return await hookSync(workspace, io, env);
  } catch (e) {
    // Exit 0 whatever happens: a session is never held up by its memory.
    try {
      io.err(`sync-memory --hook: ${(e as Error).message}`);
    } catch {
      // nowhere to say it
    }
    return 0;
  }
}

async function hookSync(workspace: string, io: HookIo, env: NodeJS.ProcessEnv): Promise<number> {
  if (!isWorkspace(workspace)) {
    io.err(`sync-memory --hook: ${JSON.stringify(workspace)} is not a workspace name`);
    return 0;
  }
  const now = io.now?.() ?? new Date();
  const deadline = (io.startedAt ?? Date.now()) + (io.budgetMs ?? HOOK_BUDGET_MS);
  let client = io.client;
  if (!client) {
    let apiKey: string | undefined;
    let apiUrl: string;
    try {
      apiKey = await apiKeyFor(workspace, env);
      apiUrl = apiUrlFrom(env);
    } catch {
      return 0;
    }
    if (!apiKey) return 0;
    client = new SystemDoxApiClient({ apiKey, apiUrl, cacheTtlMs: 0, defaultOrg: undefined });
  }
  let projects: string[];
  try {
    projects = Object.keys((await readState(workspace)).memory ?? {}).sort();
  } catch {
    return 0;
  }
  if (!projects.length) return 0;

  const lock = syncLockPath(workspace);
  if (!(await takeLock(lock, io.lockStaleMs ?? HOOK_LOCK_STALE_MS, now))) {
    io.out(`Team memory ${workspace}: a sync is already running.`);
    return 0;
  }
  try {
    for (const project of projects) {
      const folder = join(workspaceDir(workspace), "memory", project);
      const report: string[] = [];
      let summary: SyncSummary | undefined;
      const left = deadline - Date.now();
      if (left > 0) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), left);
        });
        const run = syncMemory({
          project,
          dryRun: false,
          client,
          workspace,
          deadline,
          unattended: true,
          out: (...lines) => report.push(...lines),
          summary: (s) => (summary = s),
          now: io.now,
        });
        const won = await Promise.race([run.then(() => "done" as const), timeout]);
        if (timer) clearTimeout(timer);
        if (won === "timeout") summary = undefined;
      }
      const result: SyncSummary = summary ?? {
        outcome: "failed",
        reason: "took too long",
        version: 0,
        pulled: 0,
        pushed: 0,
        deleted: 0,
        conflictCopies: [],
        waiting: [],
      };
      const lines = hookLines(workspace, project, folder, result);
      lines.forEach((l) => io.out(l));
      try {
        await appendLog(workspace, [`--- ${now.toISOString()} ${workspace}/${project}`, ...lines, ...report]);
      } catch (e) {
        io.err(`sync-memory --hook: the log could not be written: ${(e as Error).message}`);
      }
    }
  } finally {
    await releaseLock(lock);
  }
  return 0;
}

/** The command: parse, find the key, sync. */
export async function runSyncMemory(
  argv: string[],
  io: HookIo & { ask?: (question: string) => Promise<string> },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let args: SyncMemoryArgs;
  let client = io.client;
  try {
    args = parseSyncMemoryArgs(argv);
  } catch (e) {
    if (argv.includes("--hook")) {
      // A hook never holds a session up, even on a usage error: one line, exit 0.
      io.err(`sync-memory --hook: ${(e as Error).message.split("\n")[0]}`);
      return 0;
    }
    io.err((e as Error).message);
    return 1;
  }
  if (args.hook) return runHookSync(args.hook, io, env);
  try {
    if (!client) {
      const apiUrl = apiUrlFrom(env);
      const apiKey = await localApiKey(env);
      client = new SystemDoxApiClient({ apiKey, apiUrl, cacheTtlMs: 0, defaultOrg: undefined });
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  return syncMemory({ ...args, client, out: (...lines) => lines.forEach((l) => io.out(l)), ask: io.ask, now: io.now });
}
