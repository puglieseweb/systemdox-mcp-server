/**
 * Authored skills on the local disk (ADR-216): read a skill folder to publish
 * it, and install a published version into a folder without silently
 * overwriting what someone edited there.
 *
 * Shared by the stdio server's publish_skill / install_skill tools and by the
 * `install-skill` CLI command, so a skill installed either way leaves the same
 * manifest and is refused on the same edits. The hosted (HTTP) server never
 * calls the disk half: it cannot see the user's computer.
 *
 * The manifest `.systemdox-skill.json` records the version and every file's
 * SHA-256 as installed. A file whose hash no longer matches was edited here;
 * an install stops and names it unless asked to overwrite.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MANIFEST_FILE = ".systemdox-skill.json";
export const ENTRY_FILE = "SKILL.md";
/**
 * Claude Code loads a skill folder holding this as a plugin, and its hooks then run
 * at session start with nothing invoked, so "install never runs anything" (ADR-216
 * §2.2) depends on never writing it. The API refuses it at publish (ADR-223); this
 * holds for a version published before that.
 */
const PLUGIN_MANIFEST_FOLDER = ".claude-plugin";

/** The server's limits (backend common/authored_skills.py), checked early so
 * a local mistake is named before anything is sent. */
export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** Never part of a skill: tooling and caches that live beside one. */
const SKIPPED = new Set([MANIFEST_FILE, ".git", "node_modules", "__pycache__", ".DS_Store"]);

export interface SkillFileIn {
  path: string;
  content: string;
}

export interface SkillFileOut extends SkillFileIn {
  bytes: number;
  sha256: string;
}

export interface SkillVersionFiles {
  name: string;
  version: number;
  description: string;
  publishedAt: string;
  publishedBy?: string;
  files: SkillFileOut[];
}

export interface SkillManifest {
  name: string;
  version: number;
  installedAt: string;
  files: Record<string, string>;
}

export interface InstallResult {
  dest: string;
  version: number;
  written: string[];
  removed: string[];
  /** Files someone added here that the skill does not ship: left alone. */
  keptUntracked: string[];
  /** Edited files the new version no longer ships: left alone. */
  keptEdited: string[];
}

export class SkillInstallRefused extends Error {
  constructor(readonly dest: string, readonly edited: string[]) {
    super(
      `${dest} has local changes in ${edited.length} file(s): ${edited.join(", ")}. ` +
        "Nothing was written. Move your changes aside, or install again with overwrite."
    );
  }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isValidName(name: string): boolean {
  return name.length <= 64 && NAME_RE.test(name);
}

export function isValidPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    path.split("/").every((s) => SEGMENT_RE.test(s) && s !== "." && s !== ".." && s !== PLUGIN_MANIFEST_FOLDER)
  );
}

/** `name` from SKILL.md's frontmatter, or undefined. */
export function frontmatterName(skillMd: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!block) return undefined;
  const line = /^name:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  return line ? line[1].replace(/^(['"])(.*)\1$/, "$2") : undefined;
}

/** The default install folder: personal skills, every project (ADR-216 §6 Q1). */
export function defaultSkillDir(name: string): string {
  return join(homedir(), ".claude", "skills", name);
}

export interface Walked {
  files: string[];
  /** Symlinks and junctions: never followed, never written through. */
  links: string[];
  /** Dot-entries a publish leaves out (.env, .vscode/…): never part of a skill. */
  hidden: string[];
}

/** `skipHidden`: a publish leaves dot-entries out; an install must see them,
 * or an edited dotfile a version ships would be overwritten unseen. */
export async function walk(
  root: string,
  { skipHidden }: { skipHidden: boolean },
  dir = root,
  out: Walked = { files: [], links: [], hidden: [] }
): Promise<Walked> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.endsWith(".pyc")) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (entry.isSymbolicLink()) out.links.push(rel); // a Windows junction reports as one too
    else if (skipHidden && entry.name.startsWith(".")) out.hidden.push(rel);
    else if (entry.isDirectory()) await walk(root, { skipHidden }, full, out);
    else if (entry.isFile()) out.files.push(rel);
  }
  out.files.sort();
  return out;
}

/**
 * Read `paths` (relative, forward slashes) under `root` exactly as they are
 * on disk, bytes decoded as UTF-8, held to the server's limits (ADR-216):
 * at most MAX_FILES files, each text with no NUL and at most MAX_FILE_BYTES,
 * all together at most MAX_TOTAL_BYTES. Throws naming the first file at
 * fault. `what` names the thing in the message ("a skill", "the hooks part").
 */
export async function readTextFiles(root: string, paths: string[], what: string): Promise<SkillFileIn[]> {
  if (paths.length > MAX_FILES) {
    throw new Error(`${root} holds ${paths.length} files: ${what} holds at most ${MAX_FILES}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: SkillFileIn[] = [];
  let total = 0;
  for (const path of paths) {
    if (!isValidPath(path)) {
      throw new Error(`${path}: file names may use letters, digits, ".", "_" and "-" only`);
    }
    const raw = await readFile(join(root, ...path.split("/")));
    if (raw.includes(0)) throw new Error(`${path} is binary: ${what} holds text files only`);
    if (raw.length > MAX_FILE_BYTES) {
      throw new Error(`${path} is ${raw.length} bytes: a file holds at most ${MAX_FILE_BYTES}`);
    }
    total += raw.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`the files pass ${MAX_TOTAL_BYTES} bytes at ${path}`);
    }
    let content: string;
    try {
      content = decoder.decode(raw);
    } catch {
      throw new Error(`${path} is not UTF-8 text`);
    }
    files.push({ path, content });
  }
  return files;
}

/**
 * Read a skill folder exactly as it is on disk (bytes decoded as UTF-8, never
 * re-typed), ready to publish. Throws naming the first file that cannot be
 * part of a skill.
 */
export async function readSkillDirectory(
  directory: string
): Promise<{ name: string; files: SkillFileIn[]; skipped: string[] }> {
  const root = resolve(directory);
  if (!existsSync(join(root, ENTRY_FILE))) {
    throw new Error(`${root} has no ${ENTRY_FILE}: a skill folder holds SKILL.md at its root`);
  }
  const walked = await walk(root, { skipHidden: true });
  if (walked.links.length) {
    // A link could pull in a file from anywhere on this computer (~/.ssh, …).
    throw new Error(`${walked.links.join(", ")}: links are not followed; copy the file into the skill folder`);
  }
  const files = await readTextFiles(root, walked.files, "a skill");
  const skillMd = files.find((f) => f.path === ENTRY_FILE)!;
  const name = frontmatterName(skillMd.content);
  if (!name) throw new Error(`${ENTRY_FILE} has no frontmatter name`);
  return { name, files, skipped: walked.hidden };
}

function within(dest: string, path: string): string {
  if (!isValidPath(path)) throw new Error(`refusing to write ${JSON.stringify(path)}: not a skill path`);
  const full = resolve(dest, ...path.split("/"));
  if (!full.startsWith(resolve(dest) + sep)) throw new Error(`refusing to write outside ${dest}: ${path}`);
  return full;
}

async function readManifest(dest: string): Promise<SkillManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dest, MANIFEST_FILE), "utf8")) as SkillManifest;
  } catch {
    return undefined;
  }
}

/**
 * Write a published version into `dest`. Stops before writing anything when
 * a file there was edited since it was installed (or the folder holds files
 * with no manifest to vouch for them), unless `overwrite`.
 */
export async function installSkill(
  version: SkillVersionFiles,
  dest: string,
  { overwrite = false }: { overwrite?: boolean } = {}
): Promise<InstallResult> {
  if (!isValidName(version.name)) throw new Error(`refusing to install ${JSON.stringify(version.name)}: not a skill name`);
  const incoming = new Map(version.files.map((f) => [f.path, f]));
  for (const f of version.files) within(dest, f.path);

  // Never write through a link: the folder itself, or anything in it, could
  // point anywhere (a cloned repo can commit one). Checked before any write.
  if (existsSync(dest) && (await lstat(dest)).isSymbolicLink()) {
    throw new Error(`${dest} is a link: install into a real folder`);
  }
  const walked = existsSync(dest) ? await walk(dest, { skipHidden: false }) : { files: [], links: [], hidden: [] };
  if (walked.links.length) {
    throw new Error(`${dest} holds links (${walked.links.join(", ")}): remove them, nothing was written`);
  }
  const present = walked.files;
  const manifest = await readManifest(dest);
  // The manifest is a local file anyone can edit: a path in it that is not a
  // skill path (`../x`) is ignored, never removed or trusted.
  const known: Record<string, string> = Object.fromEntries(
    Object.entries(manifest?.files ?? {}).filter(([p, h]) => isValidPath(p) && typeof h === "string")
  );

  const edited: string[] = [];
  const untracked: string[] = [];
  for (const path of present) {
    const content = await readFile(join(dest, ...path.split("/")), "utf8");
    if (Object.hasOwn(known, path)) {
      if (sha256(content) !== known[path]) edited.push(path);
    } else if (!incoming.has(path) || sha256(content) !== incoming.get(path)!.sha256) {
      // A file no manifest vouches for: harmless unless the version writes over it.
      if (incoming.has(path) || !manifest) edited.push(path);
      else untracked.push(path);
    }
  }
  const blocking = edited.filter((p) => incoming.has(p) || !manifest);
  if (blocking.length && !overwrite) throw new SkillInstallRefused(dest, blocking);

  const written: string[] = [];
  for (const f of version.files) {
    const full = within(dest, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, "utf8");
    written.push(f.path);
  }

  const removed: string[] = [];
  const keptEdited: string[] = [];
  for (const path of Object.keys(known)) {
    if (incoming.has(path) || !present.includes(path)) continue;
    if (edited.includes(path)) {
      keptEdited.push(path);
      continue;
    }
    await rm(within(dest, path));
    removed.push(path);
  }

  const next: SkillManifest = {
    name: version.name,
    version: version.version,
    installedAt: new Date().toISOString(),
    files: Object.fromEntries(version.files.map((f) => [f.path, f.sha256])),
  };
  await writeFile(join(dest, MANIFEST_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");

  return {
    dest,
    version: version.version,
    written,
    removed,
    keptUntracked: untracked.filter((p) => !incoming.has(p)),
    keptEdited,
  };
}

/** A fence longer than any backtick run in `text`, so content cannot close it. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * What follows an install. Claude Code watches its skills folders, so a running
 * session needs no restart, unless the top-level folder did not exist when the
 * session started (code.claude.com/docs/en/skills, "Edit a skill during a
 * session"): `/reload-skills` covers that, and reading the file works anywhere.
 */
export function afterInstall(skillMd: string): string {
  return `No restart is needed: a running Claude Code session picks it up. If one does not list it yet, read ${skillMd} and follow it, or run /reload-skills.`;
}

/** Human summary of an install, shared by the tool and the CLI. */
export function describeInstall(name: string, r: InstallResult): string {
  const lines = [
    `Installed ${name} version ${r.version} into ${r.dest} (${r.written.length} file(s)).`,
  ];
  if (r.removed.length) lines.push(`Removed (no longer in the skill): ${r.removed.join(", ")}`);
  if (r.keptEdited.length) {
    lines.push(`Kept, edited here and no longer in the skill: ${r.keptEdited.join(", ")}`);
  }
  if (r.keptUntracked.length) lines.push(`Kept, added here: ${r.keptUntracked.join(", ")}`);
  lines.push(afterInstall(join(r.dest, "SKILL.md")));
  return lines.join("\n");
}
