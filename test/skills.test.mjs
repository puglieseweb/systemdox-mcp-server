// Binds test/features/authored-skills.feature (ADR-216, ids SKL-M-nn).
// Each scenario is one test whose title is read from the feature file, and
// the last test fails when a scenario has no test or a test no scenario.
// Offline: a fake MCP server captures the tool handlers and a fake API client
// stands in for SystemDox; files go to a temporary folder. Build first
// (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSkillTools } from "../dist/tools/skills.js";
import { MANIFEST_FILE } from "../dist/lib/skills.js";
import { runInstallSkill } from "../dist/install-skill.js";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "authored-skills.feature");
const TITLES = new Map(
  [...(await readFile(FEATURE, "utf8")).matchAll(/^\s*Scenario: (SKL-M-\d+) (.+)$/gm)].map((m) => [m[1], m[2].trim()])
);
const bound = new Set();
function scenario(id, fn) {
  assert.ok(TITLES.has(id), `${id} is not a scenario in the feature file`);
  bound.add(id);
  test(`${id} ${TITLES.get(id)}`, fn);
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SKILL_MD = "---\nname: landing-review\ndescription: Review a landing page.\n---\n\n# Landing review\n";

function version(n, files) {
  return {
    name: "landing-review",
    version: n,
    description: "Review a landing page.",
    publishedAt: "2026-10-31T17:00:00Z",
    files: files.map(([path, content]) => ({ path, content, bytes: Buffer.byteLength(content), sha256: sha(content) })),
  };
}
const V1 = version(1, [["SKILL.md", SKILL_MD], ["references/guide.md", "# Guide\n"], ["scripts/run.sh", "#!/bin/sh\necho run\n"]]);
const V2 = version(2, [["SKILL.md", SKILL_MD + "\nVersion two.\n"], ["references/guide.md", "# Guide\n"]]);

function tools({ localFiles, versions = { latest: V1, 1: V1, 2: V2 } }) {
  const registered = {};
  const posted = [];
  const server = { registerTool: (name, meta, fn) => (registered[name] = { meta, fn }) };
  const client = {
    get: async () => ({ skills: [] }),
    getFresh: async (path) => {
      const v = path.split("/versions/")[1];
      if (!(v in versions)) throw new Error(`SystemDox API error 404: no version ${v}`);
      return versions[v];
    },
    post: async (path, body) => {
      posted.push({ path, body });
      return { name: "landing-review", version: 1, fileCount: body.files.length, totalBytes: 1 };
    },
    invalidateCache: () => {},
  };
  registerSkillTools(server, client, { localFiles });
  return { registered, posted, client };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), "sdx-skill-"));
}

async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

scenario("SKL-M-01", async () => {
  const dir = await tempDir();
  await write(dir, "SKILL.md", SKILL_MD.replace(/\n/g, "\r\n")); // as a Windows editor saves it
  await write(dir, "references/guide.md", "# Guide ✓\n");
  await write(dir, "scripts/run.sh", "#!/bin/sh\necho run\n");
  await write(dir, ".git/HEAD", "ref: refs/heads/main\n");
  await write(dir, MANIFEST_FILE, "{}");
  const { registered, posted } = tools({ localFiles: true });

  const out = await registered.publish_skill.fn({ directory: dir });
  assert.match(out.content[0].text, /Published \*\*landing-review\*\* version 1/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, "/v1/standards/skills/landing-review/versions");
  const sent = Object.fromEntries(posted[0].body.files.map((f) => [f.path, f.content]));
  assert.deepEqual(Object.keys(sent), ["SKILL.md", "references/guide.md", "scripts/run.sh"]);
  assert.equal(sent["SKILL.md"], SKILL_MD.replace(/\n/g, "\r\n"));
  assert.equal(sent["references/guide.md"], "# Guide ✓\n");
  await rm(dir, { recursive: true, force: true });
});

scenario("SKL-M-02", async () => {
  const dir = await tempDir();
  await write(dir, "SKILL.md", SKILL_MD);
  await writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const { registered, posted } = tools({ localFiles: true });
  await assert.rejects(registered.publish_skill.fn({ directory: dir }), /shot\.png is binary/);
  assert.equal(posted.length, 0);
  await rm(dir, { recursive: true, force: true });
});

scenario("SKL-M-03", async () => {
  const home = await tempDir();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const { registered } = tools({ localFiles: true });
    const out = await registered.install_skill.fn({ name: "landing-review" });
    const dest = join(home, ".claude", "skills", "landing-review");
    assert.match(out.content[0].text, /Installed landing-review version 1/);
    for (const f of V1.files) assert.equal(await readFile(join(dest, f.path), "utf8"), f.content);
    const manifest = JSON.parse(await readFile(join(dest, MANIFEST_FILE), "utf8"));
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.files, Object.fromEntries(V1.files.map((f) => [f.path, f.sha256])));
  } finally {
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  }
});

scenario("SKL-M-04", async () => {
  const dest = join(await tempDir(), "landing-review");
  const { registered } = tools({ localFiles: true });
  await registered.install_skill.fn({ name: "landing-review", version: 1, target: dest });
  await writeFile(join(dest, "SKILL.md"), SKILL_MD + "\nMy local note.\n");

  await assert.rejects(
    registered.install_skill.fn({ name: "landing-review", version: 2, target: dest }),
    /local changes in 1 file\(s\): SKILL\.md/
  );
  assert.match(await readFile(join(dest, "SKILL.md"), "utf8"), /My local note/);
  assert.ok(existsSync(join(dest, "scripts/run.sh")), "nothing was written or removed");

  await registered.install_skill.fn({ name: "landing-review", version: 2, target: dest, overwrite: true });
  assert.equal(await readFile(join(dest, "SKILL.md"), "utf8"), V2.files[0].content);
  await rm(dirname(dest), { recursive: true, force: true });
});

scenario("SKL-M-05", async () => {
  const dest = join(await tempDir(), "landing-review");
  const { registered } = tools({ localFiles: true });
  await registered.install_skill.fn({ name: "landing-review", version: 1, target: dest });
  await write(dest, "notes.md", "mine\n");

  const out = await registered.install_skill.fn({ name: "landing-review", version: 2, target: dest });
  assert.ok(!existsSync(join(dest, "scripts/run.sh")));
  assert.equal(await readFile(join(dest, "notes.md"), "utf8"), "mine\n");
  assert.match(out.content[0].text, /Removed \(no longer in the skill\): scripts\/run\.sh/);
  assert.match(out.content[0].text, /Kept, added here: notes\.md/);
  await rm(dirname(dest), { recursive: true, force: true });
});

scenario("SKL-M-06", async () => {
  const { registered } = tools({ localFiles: false });
  assert.ok(!("directory" in registered.publish_skill.meta.inputSchema));
  assert.ok("files" in registered.publish_skill.meta.inputSchema);
  assert.ok(!("overwrite" in registered.install_skill.meta.inputSchema));
  await assert.rejects(registered.publish_skill.fn({ directory: "/anywhere" }), /Pass `files`/);

  const out = (await registered.install_skill.fn({ name: "landing-review" })).content[0].text;
  // The user's home, never the Lambda's.
  assert.match(out, /write these 3 file\(s\) into ~\/\.claude\/skills\/landing-review\//);
  assert.match(out, new RegExp(`### ${MANIFEST_FILE.replace(".", "\\.")}`));
  for (const f of V1.files) {
    assert.ok(out.includes(`### ${f.path}`));
    assert.ok(out.includes(f.content));
    assert.ok(out.includes(f.sha256));
  }
});

scenario("SKL-M-07", async () => {
  const dest = join(await tempDir(), "landing-review");
  const { client } = tools({ localFiles: true });
  const lines = { out: [], err: [] };
  const io = { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), client };

  assert.equal(await runInstallSkill(["landing-review", "--target", dest], io), 0);
  assert.equal(await readFile(join(dest, "SKILL.md"), "utf8"), SKILL_MD);

  await writeFile(join(dest, "references/guide.md"), "# Changed here\n");
  assert.equal(await runInstallSkill(["landing-review", "--target", dest], io), 2);
  assert.match(lines.err.at(-1), /references\/guide\.md/);
  await rm(dirname(dest), { recursive: true, force: true });
});

scenario("SKL-M-08", async () => {
  const saved = process.env.SYSTEMDOX_API_KEY;
  delete process.env.SYSTEMDOX_API_KEY;
  try {
    const lines = [];
    const code = await runInstallSkill(["landing-review"], { out: () => {}, err: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /Set SYSTEMDOX_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.SYSTEMDOX_API_KEY = saved;
  }
});

scenario("SKL-M-09", async () => {
  const root = await tempDir();
  const dest = join(root, "landing-review");
  const evil = version(3, [["SKILL.md", SKILL_MD], ["../outside.md", "x"]]);
  const { registered } = tools({ localFiles: true, versions: { latest: evil } });
  await assert.rejects(registered.install_skill.fn({ name: "landing-review", target: dest }), /not a skill path/);
  assert.ok(!existsSync(join(root, "outside.md")));
  assert.ok(!existsSync(join(dest, "SKILL.md")), "nothing written at all");
  await rm(root, { recursive: true, force: true });
});

scenario("SKL-M-10", async () => {
  const root = await tempDir();
  const dest = join(root, "landing-review");
  const outside = join(root, "outside");
  await mkdir(dest, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(dest, "references"), "junction"); // a junction on Windows, a link elsewhere
  const { registered } = tools({ localFiles: true });
  await assert.rejects(registered.install_skill.fn({ name: "landing-review", target: dest }), /holds links \(references\)/);
  assert.deepEqual(await readdir(outside), []);
  assert.ok(!existsSync(join(dest, "SKILL.md")), "nothing written");

  // The folder itself being a link is refused too.
  const linked = join(root, "linked", "landing-review");
  await mkdir(dirname(linked));
  await symlink(outside, linked, "junction");
  await assert.rejects(registered.install_skill.fn({ name: "landing-review", target: linked }), /is a link/);
  assert.deepEqual(await readdir(outside), []);
  await rm(root, { recursive: true, force: true });
});

scenario("SKL-M-11", async () => {
  const root = await tempDir();
  const hooks = join(root, ".git", "hooks");
  const { registered, client } = tools({ localFiles: true });
  await assert.rejects(registered.install_skill.fn({ name: "landing-review", target: hooks }), /folder named landing-review/);
  assert.ok(!existsSync(hooks));
  const lines = [];
  const code = await runInstallSkill(["landing-review", "--target", hooks], { out: () => {}, err: (l) => lines.push(l), client });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /folder named landing-review/);
  assert.ok(!existsSync(hooks));
  await rm(root, { recursive: true, force: true });
});

scenario("SKL-M-12", async () => {
  const dir = await tempDir();
  await write(dir, "SKILL.md", SKILL_MD);
  await write(dir, ".env", "TOKEN=abc\n");
  await write(dir, ".vscode/settings.json", "{}");
  const { registered, posted } = tools({ localFiles: true });
  const out = await registered.publish_skill.fn({ directory: dir });
  assert.deepEqual(posted[0].body.files.map((f) => f.path), ["SKILL.md"]);
  assert.match(out.content[0].text, /Left out \(hidden files are never part of a skill\): \.env, \.vscode/);

  const other = await tempDir();
  await write(other, "SKILL.md", SKILL_MD);
  await symlink(dir, join(other, "refs"), "junction");
  const before = posted.length;
  await assert.rejects(registered.publish_skill.fn({ directory: other }), /refs: links are not followed/);
  assert.equal(posted.length, before);
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

scenario("SKL-M-13", async () => {
  const dir = await tempDir();
  await write(dir, "SKILL.md", SKILL_MD);
  const { registered, posted } = tools({ localFiles: true });

  await registered.publish_skill.fn({ directory: dir, note: "Fix the GA4 step", baseVersion: 3 });
  assert.equal(posted[0].body.note, "Fix the GA4 step");
  assert.equal(posted[0].body.baseVersion, 3);

  await registered.publish_skill.fn({ directory: dir });
  assert.ok(!("note" in posted[1].body));
  assert.ok(!("baseVersion" in posted[1].body));

  const { registered: hosted } = tools({ localFiles: false });
  assert.ok("note" in hosted.publish_skill.meta.inputSchema);
  assert.ok("baseVersion" in hosted.publish_skill.meta.inputSchema);
  await rm(dir, { recursive: true, force: true });
});

test("every scenario of authored-skills.feature has a test, and every test a scenario", () => {
  assert.deepEqual([...bound].sort(), [...TITLES.keys()].sort());
});
