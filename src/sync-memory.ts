/**
 * `systemdox-mcp-server sync-memory [--project <name>] [--dir <folder>]
 * [--import <folder>] [--dry-run]`, and the core of the local MCP tool
 * `sync_memory` (ADR-217 §2.3 with Amendment 2,
 * specs/changes/team-setup/contract.md "sync-memory and the MCP tool
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
 * refused twice on a stale base.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  apiUrlFrom,
  isWorkspace,
  localApiKey,
  readState,
  updateState,
  workspaceDir,
  type CommandIo,
} from "./lib/team-setup-files.js";
import type { FoundValue, ValueAnswer } from "./lib/team-setup-types.js";

export const SYNC_MEMORY_USAGE =
  "Usage: systemdox-mcp-server sync-memory [--project <name>] [--dir <folder>] [--import <folder>] [--dry-run]";
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
  importDir?: string;
  dryRun: boolean;
}

export interface SyncMemoryOptions extends SyncMemoryArgs {
  client: SyncClient;
  /** Each argument is one line of the report. */
  out: (...lines: string[]) => void;
  /** A person at a terminal. Absent for the MCP tool, a hook or CI: then
   * nothing is asked and nothing is rewritten. */
  ask?: (question: string) => Promise<string>;
  now?: () => Date;
}

/** A usage error or a refusal: exit 1 with the message. */
class SyncFailed extends Error {}

/** A refused API call's status and SYD code. Read from the error rather than
 * by `instanceof`: each entry point bundles its own copy of the client, so
 * the class a caller's client throws need not be this module's. */
function refusal(e: unknown): { status?: number; code?: string } {
  if (!(e instanceof Error)) return {};
  const { status, code } = e as Partial<SystemDoxApiError>;
  return { status: typeof status === "number" ? status : undefined, code: typeof code === "string" ? code : undefined };
}

export function parseSyncMemoryArgs(argv: string[]): SyncMemoryArgs {
  const args: SyncMemoryArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--project" || a === "--dir" || a === "--import") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new SyncFailed(`${a} needs a value\n${SYNC_MEMORY_USAGE}`);
      if (a === "--project") {
        if (!isWorkspace(value)) throw new SyncFailed(`${value} is not a project name (lower case letters, digits and -)`);
        args.project = value;
      } else if (a === "--dir") args.dir = value;
      else args.importDir = value;
    } else throw new SyncFailed(`Unexpected argument ${a}\n${SYNC_MEMORY_USAGE}`);
  }
  return args;
}

// ── The local folder ────────────────────────────────────────────────────────

const toPath = (root: string, rel: string) => join(root, ...rel.split("/"));

/** Every `*.md` file under `root` with its text (hidden entries left out),
 * and every file name there (lower case). */
async function readFolder(root: string): Promise<{ files: Record<string, string>; names: Set<string> }> {
  const files: Record<string, string> = {};
  const names = new Set<string>();
  async function walk(dir: string, prefix: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else if (e.isFile()) {
        names.add(rel.toLowerCase());
        if (e.name.endsWith(".md")) files[rel] = await readFile(join(dir, e.name), "utf8");
      }
    }
  }
  if (existsSync(root)) await walk(root, "");
  return { files, names };
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
  skipped = new Map<string, string>();
  people: Answered[] = [];
  toAnswer = new Map<string, number>();

  add(plan: MergePlan) {
    plan.pulled.forEach((p) => this.pulled.add(p));
    plan.pushed.forEach((p) => this.pushed.add(p));
    plan.deletedHere.forEach((p) => this.deletedHere.add(p));
    plan.deletedFromTeam.forEach((p) => this.deletedFromTeam.add(p));
    for (const c of plan.conflicts) this.conflicts.push(`${c.path}: the team's text; yours is beside it as ${c.copy}`);
    for (const line of plan.indexTeamLines) this.conflicts.push(`${INDEX_FILE}: your line was kept; the team's was: ${line}`);
  }

  skip(path: string, reason: string) {
    if (!this.skipped.has(path)) this.skipped.set(path, reason);
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
            await writeFile(toPath(opts.dir!, path), current[path], "utf8");
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
        await writeFile(toPath(opts.dir!, path), rewritten[path], "utf8");
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
      report.skip(path, "the vault did not answer (SYD-K019) for a value in it; it syncs once the value is filed");
    } else if (keys.some((k) => !answers.has(k))) {
      report.skip(path, `it holds a value nobody has answered for: run \`${hint}\` in a terminal`);
    } else {
      report.skip(path, `it holds a value to rewrite as its identifier or ~: run \`${hint}\` in a terminal`);
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

async function applyPlan(dir: string, plan: MergePlan) {
  for (const [path, text] of Object.entries(plan.writes)) {
    const full = toPath(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  }
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
    const own = await client.getOwnTeamSetup();
    const ws = own.workspace;
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
    const importWrites: Record<string, string> = {};
    if (opts.importDir) {
      const other = await readFolder(resolve(opts.importDir));
      const taken = new Set(folder.names);
      for (const [path, text] of Object.entries(other.files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!isShareable(path, text) || !isFilePath(path)) continue;
        const here = folder.files[path];
        if (here === undefined) {
          shared[path] = text;
          importWrites[path] = text;
          taken.add(path.toLowerCase());
        } else if (here !== text) {
          const copy = conflictCopyName(path, date, taken);
          taken.add(copy.toLowerCase());
          importWrites[copy] = text;
          report.conflicts.push(`${path}: this folder's text; the imported one is beside it as ${copy}`);
        }
      }
      folder.names = taken;
      if (!opts.dryRun) {
        for (const [path, text] of Object.entries(importWrites)) {
          const full = toPath(dir, path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, text, "utf8");
        }
      }
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

      await applyPlan(dir, plan);
      let version = team.version;
      if (!sameManifest(plan.manifest, team.manifest)) {
        await upload(client, ws, project, plan, team.manifest, report);
      }
      if (!sameManifest(plan.manifest, team.manifest)) {
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
      return 0;
    }
  } catch (e) {
    out((e as Error).message);
    return 1;
  }
}

/** The command: parse, find the key, sync. */
export async function runSyncMemory(
  argv: string[],
  io: CommandIo & { client?: SyncClient; ask?: (question: string) => Promise<string>; now?: () => Date },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let args: SyncMemoryArgs;
  let client = io.client;
  try {
    args = parseSyncMemoryArgs(argv);
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
