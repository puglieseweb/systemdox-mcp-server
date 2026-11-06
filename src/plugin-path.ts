/**
 * `systemdox-mcp-server plugin-path <workspace> --version <n> --sha256 <hash>`
 * (ADR-217 Amendment 1, specs/changes/team-setup/contract.md "plugin-path").
 *
 * The team marketplace's plugin entry is this command. Claude Code runs it on
 * install, on update and once per session while the plugin is enabled, and
 * takes the folder it prints as the plugin. So the usual run makes no network
 * call: a version already unpacked, whose hash state.json records, is printed
 * as it is. Otherwise the zip is downloaded with the member's key, refused
 * unless its SHA-256 is <hash>, checked entry by entry BEFORE anything is
 * written, unpacked into a temporary folder beside plugin/<n>/ and renamed
 * into place; then the hash is recorded.
 *
 * Stdout carries only the folder; everything else goes to stderr.
 * Exit codes: 0 the folder is printed; 1 usage, no key, or the API refused;
 * 2 the SHA-256 is not <hash>, or an entry was refused.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SystemDoxApiClient } from "./lib/api-client.js";
import {
  apiKeyFor,
  apiUrlFrom,
  isWorkspace,
  pluginDir,
  pluginRoot,
  readState,
  removeFolder,
  updateState,
  type CommandIo,
} from "./lib/team-setup-files.js";

export const PLUGIN_PATH_USAGE =
  "Usage: systemdox-mcp-server plugin-path <workspace> --version <n> --sha256 <hash>";

/** The most a plugin may take once unpacked. */
export const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface PluginPathArgs {
  workspace: string;
  version: number;
  sha256: string;
}

export function parsePluginPathArgs(argv: string[]): PluginPathArgs {
  const args: Partial<PluginPathArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "--sha256") {
      const value = argv[++i];
      if (!value) throw new Error(`${a} needs a value\n${PLUGIN_PATH_USAGE}`);
      if (a === "--sha256") {
        if (!SHA256_RE.test(value)) throw new Error(`--sha256 must be 64 lowercase hex characters, got ${value}`);
        args.sha256 = value;
      } else if (/^[1-9]\d{0,8}$/.test(value)) args.version = Number(value);
      else throw new Error(`--version must be a whole number, got ${value}`);
    } else if (a.startsWith("-")) throw new Error(`Unknown option ${a}\n${PLUGIN_PATH_USAGE}`);
    else if (!args.workspace) args.workspace = a;
    else throw new Error(`Unexpected argument ${a}\n${PLUGIN_PATH_USAGE}`);
  }
  if (!args.workspace || !args.version || !args.sha256) throw new Error(PLUGIN_PATH_USAGE);
  if (!isWorkspace(args.workspace)) throw new Error(`${args.workspace} is not a workspace name`);
  return args as PluginPathArgs;
}

/** A download or an entry refused: exit 2, nothing unpacked. */
export class PluginRefused extends Error {}

// ── The zip ─────────────────────────────────────────────────────────────────

export interface ZipEntry {
  name: string;
  directory: boolean;
  /** Unix permission bits, when the zip was made on Unix. */
  mode: number | undefined;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function refuse(name: string, why: string): never {
  throw new PluginRefused(`refused the plugin entry ${JSON.stringify(name)}: it ${why}. Nothing was unpacked.`);
}

/**
 * The zip's central directory, every entry checked: none may be absolute,
 * contain `..`, be a link, or take the unpacked size past MAX_UNPACKED_BYTES.
 * Throws PluginRefused naming the first entry at fault.
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PluginRefused("the download is not a zip. Nothing was unpacked.");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new PluginRefused("the zip is a ZIP64 archive, which a plugin never is. Nothing was unpacked.");

  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) {
      throw new PluginRefused("the zip's directory is damaged. Nothing was unpacked.");
    }
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const external = zip.readUInt32LE(at + 38);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;

    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const segments = name.split(/[\\/]/);
    if (!name || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) refuse(name, "is absolute");
    if (segments.includes("..")) refuse(name, "climbs out of the plugin folder (..)");
    if (name.includes(":") || name.includes("\0")) refuse(name, "is not a plain relative path");
    if ((unixMode & S_IFMT) === S_IFLNK) refuse(name, "is a link");
    const directory = name.endsWith("/") || (unixMode & S_IFMT) === S_IFDIR;
    if (!directory && unixMode && (unixMode & S_IFMT) !== S_IFREG) refuse(name, "is not a regular file");
    if (flags & 0x1) refuse(name, "is encrypted");
    if (!directory && method !== 0 && method !== 8) refuse(name, `uses compression method ${method}`);
    total += size;
    if (total > MAX_UNPACKED_BYTES) refuse(name, `takes the unpacked size past ${MAX_UNPACKED_BYTES} bytes`);
    entries.push({ name, directory, mode: unixMode ? unixMode & 0o777 : undefined, method, compressedSize, size, offset });
  }
  return entries;
}

function entryData(zip: Buffer, entry: ZipEntry): Buffer {
  const at = entry.offset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL) refuse(entry.name, "has a damaged header");
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const raw = zip.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  try {
    data =
      entry.method === 0
        ? raw
        : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) + 1 });
  } catch (e) {
    refuse(entry.name, `cannot be unpacked (${(e as Error).message})`);
  }
  if (data.length !== entry.size) refuse(entry.name, "unpacks to a size other than the one it declares");
  return data;
}

/** Unpack `zip` into `dest`, which must not exist yet. Every entry is checked
 * before the first is written. */
export async function unpackZip(zip: Buffer, dest: string): Promise<number> {
  const entries = readZipEntries(zip);
  const root = resolve(dest);
  const targets = entries.map((e) => {
    const full = resolve(root, ...e.name.split(/[\\/]/).filter(Boolean));
    if (full !== root && !full.startsWith(root + sep)) refuse(e.name, "climbs out of the plugin folder");
    return full;
  });
  const data = entries.map((e) => (e.directory ? undefined : entryData(zip, e)));
  await mkdir(root, { recursive: true });
  for (const [i, entry] of entries.entries()) {
    if (entry.directory) {
      await mkdir(targets[i], { recursive: true });
      continue;
    }
    await mkdir(dirname(targets[i]), { recursive: true });
    await writeFile(targets[i], data[i]!, { mode: entry.mode ?? 0o644 });
  }
  return entries.filter((e) => !e.directory).length;
}

// ── The command ─────────────────────────────────────────────────────────────

export interface PluginPathIo extends CommandIo {
  client?: Pick<SystemDoxApiClient, "getPluginZip">;
}

export async function runPluginPath(argv: string[], io: PluginPathIo): Promise<number> {
  let args: PluginPathArgs;
  try {
    args = parsePluginPathArgs(argv);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  const { workspace, version, sha256 } = args;
  const folder = pluginDir(workspace, version);

  try {
    const state = await readState(workspace);
    if (existsSync(folder) && state.plugin?.[String(version)]?.sha256 === sha256) {
      io.out(folder);
      return 0;
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  let client = io.client;
  if (!client) {
    try {
      const apiUrl = apiUrlFrom();
      const apiKey = await apiKeyFor(workspace);
      if (!apiKey) {
        io.err(
          `No SystemDox key for ${workspace}. Set SYSTEMDOX_API_KEY, or run npx -y @systemdox/mcp-server setup, then run this again.`
        );
        return 1;
      }
      client = new SystemDoxApiClient({ apiKey, apiUrl, cacheTtlMs: 0, defaultOrg: undefined });
    } catch (e) {
      io.err((e as Error).message);
      return 1;
    }
  }

  let zip: Buffer;
  try {
    ({ bytes: zip } = await client.getPluginZip(workspace, version));
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== sha256) {
    io.err(
      `The download of ${workspace}'s team plugin version ${version} has SHA-256 ${got}, not the ${sha256} Claude Code named. Nothing was unpacked.`
    );
    return 2;
  }

  const tmp = join(pluginRoot(workspace), `.${version}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await unpackZip(zip, tmp);
    if (existsSync(folder) && (await readState(workspace)).plugin?.[String(version)]?.sha256 === sha256) {
      // Another session unpacked the same version meanwhile: keep its folder.
      await removeFolder(tmp);
    } else {
      // A folder with no recorded hash (an unpack cut short, or state.json
      // lost) is replaced by the verified one.
      if (existsSync(folder)) await removeFolder(folder);
      try {
        await rename(tmp, folder);
      } catch (e) {
        // Another session renamed the same verified bytes into place first.
        if (!existsSync(folder)) throw e;
        await removeFolder(tmp);
      }
    }
    await updateState(workspace, (state) => {
      state.plugin = { ...state.plugin, [String(version)]: { sha256, installedAt: new Date().toISOString() } };
    });
  } catch (e) {
    await removeFolder(tmp);
    io.err((e as Error).message);
    return e instanceof PluginRefused ? 2 : 1;
  }
  io.err(`Unpacked ${workspace}'s team plugin version ${version}.`);
  io.out(folder);
  return 0;
}
