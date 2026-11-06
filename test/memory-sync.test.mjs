// The team memory's merge, row by row (specs/changes/team-setup/contract.md,
// "The merge" and "MEMORY.md"), and the pure helpers the sync builds on.
// Offline: no disk, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addShareFalse,
  collectValues,
  conflictCopyName,
  decide,
  decideAll,
  isConflictCopy,
  isFilePath,
  isShareable,
  lineDiff,
  localDate,
  mergeIndex,
  personToken,
  planMerge,
  readFrontmatter,
  rewriteValues,
  sha256,
} from "../dist/lib/memory-sync.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const mem = (type, body = "Text.") => `---\nname: n\ndescription: d\ntype: ${type}\n---\n\n${body}\n`;

// ── The table, row by row ───────────────────────────────────────────────────

test("merge row: team unchanged, local changed or added → local", () => {
  assert.equal(decide("a.md", A, A, B), "local");
  assert.equal(decide("a.md", undefined, undefined, B), "local");
});

test("merge row: team changed or added, local unchanged → team (written locally)", () => {
  assert.equal(decide("a.md", A, B, A), "team");
  assert.equal(decide("a.md", undefined, B, undefined), "team");
});

test("merge row: team deleted, local unchanged → deleted locally", () => {
  assert.equal(decide("a.md", A, undefined, A), "delete-local");
});

test("merge row: team unchanged, local deleted → deleted from the team version", () => {
  assert.equal(decide("a.md", A, A, undefined), "delete-team");
});

test("merge row: both changed differently → conflict", () => {
  assert.equal(decide("a.md", A, B, C), "conflict");
  assert.equal(decide("a.md", undefined, B, C), "conflict", "both added differently");
});

test("merge row: both changed or added identically → unchanged", () => {
  assert.equal(decide("a.md", A, B, B), "unchanged");
  assert.equal(decide("a.md", undefined, B, B), "unchanged");
  assert.equal(decide("a.md", A, undefined, undefined), "unchanged", "deleted on both sides");
});

test("merge: a file deleted on one side and changed on the other keeps the change (nothing is lost)", () => {
  assert.equal(decide("a.md", A, undefined, C), "local");
  assert.equal(decide("a.md", A, B, undefined), "team");
});

test("merge: MEMORY.md changed on both sides is merged line by line, never a conflict copy", () => {
  assert.equal(decide("MEMORY.md", A, B, C), "index");
  assert.equal(decide("MEMORY.md", undefined, B, C), "index");
  assert.equal(decide("MEMORY.md", A, B, A), "team");
});

test("planMerge: each row's writes, deletes, manifest and lists", () => {
  const t = { a: "team a\n", b: "team b\n", c: "team c\n" };
  const input = {
    base: { "pushed.md": A, "pulled.md": A, "gone-here.md": A, "gone-there.md": A, "both.md": A, "same.md": A, "held.md": A },
    team: { "pushed.md": A, "pulled.md": sha256(t.a), "gone-there.md": A, "both.md": sha256(t.b), "same.md": A, "held.md": sha256(t.c) },
    local: { "pushed.md": "mine\n", "pulled.md": "x", "gone-here.md": "y", "both.md": "my both\n", "same.md": "z" },
    excluded: new Set(["held.md"]),
    taken: new Set(["both.local-2026-11-01.md"]),
    date: "2026-11-01",
  };
  // pulled.md / gone-here.md / same.md: the local text hashes to the base's
  input.base["pulled.md"] = sha256("x");
  input.base["gone-here.md"] = sha256("y");
  input.base["same.md"] = sha256("z");
  input.team["same.md"] = sha256("z");
  input.base["pushed.md"] = A;
  const { rows, needed } = decideAll(input);
  assert.deepEqual(rows, {
    "both.md": "conflict",
    "gone-here.md": "delete-local",
    "gone-there.md": "delete-team",
    "pulled.md": "team",
    "pushed.md": "local",
    "same.md": "unchanged",
  });
  assert.ok(!("held.md" in rows), "an excluded path is not merged");
  assert.deepEqual(new Set(needed), new Set([sha256(t.a), sha256(t.b)]));

  const plan = planMerge(input, rows, { [sha256(t.a)]: t.a, [sha256(t.b)]: t.b });
  assert.deepEqual(plan.manifest, {
    "both.md": sha256(t.b),
    "held.md": sha256(t.c),
    "pulled.md": sha256(t.a),
    "pushed.md": sha256("mine\n"),
    "same.md": sha256("z"),
  });
  assert.deepEqual(plan.writes, { "pulled.md": t.a, "both.md": t.b, "both.local-2026-11-01-2.md": "my both\n" });
  assert.deepEqual(plan.deletes, ["gone-here.md"]);
  assert.deepEqual(plan.upload, { "pushed.md": "mine\n" });
  assert.deepEqual(plan.conflicts, [{ path: "both.md", copy: "both.local-2026-11-01-2.md" }]);
  assert.deepEqual([plan.pulled, plan.pushed, plan.deletedHere, plan.deletedFromTeam], [["pulled.md"], ["pushed.md"], ["gone-here.md"], ["gone-there.md"]]);
  assert.ok(!Object.keys(plan.writes).includes("held.md"), "nothing is written to an excluded path");
});

test("conflict copy names: <name>.local-<date>.md, then -2, -3 when taken", () => {
  const taken = new Set();
  assert.equal(conflictCopyName("a.md", "2026-11-01", taken), "a.local-2026-11-01.md");
  taken.add("a.local-2026-11-01.md");
  assert.equal(conflictCopyName("a.md", "2026-11-01", taken), "a.local-2026-11-01-2.md");
  taken.add("a.local-2026-11-01-2.md");
  assert.equal(conflictCopyName("a.md", "2026-11-01", taken), "a.local-2026-11-01-3.md");
  assert.equal(conflictCopyName("dir/b.md", "2026-11-01", new Set()), "dir/b.local-2026-11-01.md");
  assert.equal(localDate(new Date(2026, 10, 1, 23, 59)), "2026-11-01");
});

// ── What is shared ──────────────────────────────────────────────────────────

test("shareable: feedback, project or reference, and MEMORY.md; never user, no type, share: false or a conflict copy", () => {
  for (const type of ["feedback", "project", "reference"]) assert.equal(isShareable("a.md", mem(type)), true, type);
  assert.equal(isShareable("a.md", mem("user")), false);
  assert.equal(isShareable("a.md", "No frontmatter.\n"), false);
  assert.equal(isShareable("a.md", mem("project").replace("type: project", "type: project\nshare: false")), false);
  assert.equal(isShareable("a.md", mem("project").replace("type: project", "type: 'project'\nshare: no")), false);
  assert.equal(isShareable("a.md", mem("project").replace("type: project", "type: project\nshare: \"no\"")), true, "a quoted no is a string");
  assert.equal(isShareable("a.local-2026-11-01.md", mem("project")), false);
  assert.equal(isShareable("a.local-2026-11-01-2.md", mem("project")), false);
  assert.equal(isShareable("notes.txt", mem("project")), false);
  assert.equal(isShareable("MEMORY.md", "# Index\n"), true);
  assert.equal(isShareable("MEMORY.md", "---\nshare: false\n---\n# Index\n"), false);
  assert.equal(isShareable("sub/MEMORY.md", "# Index\n"), false, "only the index at the root");
  assert.equal(isConflictCopy("x/a.local-2026-11-01.md"), true);
  assert.equal(isFilePath("a b.md"), false);
  assert.equal(isFilePath("dir/a_b-c.md"), true);
  assert.equal(isFilePath("../a.md"), false);
  assert.deepEqual(readFrontmatter(mem("Feedback")), { type: "feedback", shareFalse: false });
});

test("addShareFalse: into the block (replacing a share line), or a new block; CRLF kept", () => {
  const added = addShareFalse(mem("project"));
  assert.equal(added, "---\nname: n\ndescription: d\ntype: project\nshare: false\n---\n\nText.\n");
  assert.equal(isShareable("a.md", added), false);
  assert.equal(addShareFalse(added), added, "idempotent");
  assert.equal(addShareFalse("---\ntype: project\nshare: true\n---\nBody\n"), "---\ntype: project\nshare: false\n---\nBody\n");
  assert.equal(addShareFalse("# Index\n"), "---\nshare: false\n---\n# Index\n");
  const crlf = mem("project").replace(/\n/g, "\r\n");
  assert.equal(addShareFalse(crlf), "---\r\nname: n\r\ndescription: d\r\ntype: project\r\nshare: false\r\n---\r\n\r\nText.\r\n");
});

// ── MEMORY.md ───────────────────────────────────────────────────────────────

const INDEX = ["# Memory", "", "## Notes", "- [Alpha](alpha.md) — first", "- [Beta](beta.md) — second", "", "## Other", "- [Gamma](gamma.md)", ""].join("\n");
const lines = (...l) => l.join("\n");

test("MEMORY.md: a team line for a new file is added under the same heading", () => {
  const team = INDEX.replace("- [Beta](beta.md) — second", "- [Beta](beta.md) — second\n- [New](new.md) — the team's");
  const local = INDEX.replace("- [Beta](beta.md) — second", "- [Beta](beta.md) — second\n- [Mine](mine.md) — mine");
  const { text, teamLines } = mergeIndex(INDEX, team, local);
  assert.equal(
    text,
    lines("# Memory", "", "## Notes", "- [Alpha](alpha.md) — first", "- [Beta](beta.md) — second", "- [New](new.md) — the team's", "- [Mine](mine.md) — mine", "", "## Other", "- [Gamma](gamma.md)", "")
  );
  assert.deepEqual(teamLines, []);
  // The team's first line under a heading lands right under it.
  const first = INDEX.replace("## Other\n", "## Other\n- [Top](top.md)\n");
  assert.match(mergeIndex(INDEX, first, local).text, /## Other\n- \[Top\]\(top\.md\)\n- \[Gamma\]/);
});

test("MEMORY.md: a line the team removed and the member did not change is removed", () => {
  const team = INDEX.replace("- [Alpha](alpha.md) — first\n", "");
  const local = INDEX + "- [Mine](mine.md)\n";
  assert.ok(!mergeIndex(INDEX, team, local).text.includes("alpha.md"));
  // …but one the member changed is kept.
  const changed = local.replace("— first", "— first, edited here");
  assert.ok(mergeIndex(INDEX, team, changed).text.includes("- [Alpha](alpha.md) — first, edited here"));
});

test("MEMORY.md: a line with no link takes the team's text unless the member changed it", () => {
  const team = INDEX.replace("# Memory", "# Team memory");
  const local = INDEX + "- [Mine](mine.md)\n";
  const merged = mergeIndex(INDEX, team, local).text;
  assert.ok(merged.startsWith("# Team memory\n"), merged);
  assert.ok(!merged.includes("# Memory\n"));
  const mine = local.replace("# Memory", "# My memory");
  const both = mergeIndex(INDEX, team, mine);
  assert.ok(both.text.startsWith("# My memory\n"), both.text);
  assert.ok(!both.text.includes("# Team memory"), "both changed it: the member's is kept");
  assert.deepEqual(both.teamLines, ["# Team memory"], "and the team's is listed");
});

test("MEMORY.md: both changed the same line → the member's is kept and the team's listed", () => {
  const team = INDEX.replace("— first", "— first, the team's words");
  const local = INDEX.replace("— first", "— first, my words");
  const { text, teamLines } = mergeIndex(INDEX, team, local);
  assert.ok(text.includes("- [Alpha](alpha.md) — first, my words"));
  assert.ok(!text.includes("the team's words"));
  assert.deepEqual(teamLines, ["- [Alpha](alpha.md) — first, the team's words"]);
});

test("MEMORY.md: the index row writes the merge and pushes it, with no .local- copy; CRLF kept", () => {
  const team = INDEX + "- [New](new.md)\n";
  const local = (INDEX + "- [Mine](mine.md)\n").replace(/\n/g, "\r\n");
  const input = {
    base: { "MEMORY.md": sha256(INDEX) },
    team: { "MEMORY.md": sha256(team) },
    local: { "MEMORY.md": local },
    excluded: new Set(),
    taken: new Set(),
    date: "2026-11-01",
  };
  const { rows, needed } = decideAll(input);
  assert.deepEqual(rows, { "MEMORY.md": "index" });
  assert.deepEqual(new Set(needed), new Set([sha256(team), sha256(INDEX)]));
  const plan = planMerge(input, rows, { [sha256(team)]: team, [sha256(INDEX)]: INDEX });
  assert.deepEqual(Object.keys(plan.writes), ["MEMORY.md"]);
  assert.ok(plan.writes["MEMORY.md"].includes("- [New](new.md)\r\n") && plan.writes["MEMORY.md"].includes("- [Mine](mine.md)"));
  assert.equal(plan.manifest["MEMORY.md"], sha256(plan.writes["MEMORY.md"]));
  assert.deepEqual(plan.conflicts, []);
  // A base no kept version names any more merges as if empty: nothing is lost.
  const lost = planMerge(input, rows, { [sha256(team)]: team });
  assert.ok(lost.writes["MEMORY.md"].includes("[New](new.md)") && lost.writes["MEMORY.md"].includes("[Mine](mine.md)"));
});

// ── People ──────────────────────────────────────────────────────────────────

test("collectValues groups by normalised value, counts files and keeps the first line", () => {
  const files = {
    "b.md": "Call 07700 900456 after five.\n",
    "a.md": "Intro\nReseller: +44 7700 900456, jo@example.com\n",
    "c.md": "Mail JO@example.com or see C:\\Users\\jbloggs\\notes\n",
  };
  const { groups, homePaths } = collectValues(files);
  assert.deepEqual(
    groups.map((g) => [g.kind, g.normalised, g.files, g.first]),
    [
      ["phone", "+447700900456", ["a.md", "b.md"], { path: "a.md", line: 2, text: "Reseller: +44 7700 900456, jo@example.com" }],
      ["email", "jo@example.com", ["a.md", "c.md"], { path: "a.md", line: 2, text: "Reseller: +44 7700 900456, jo@example.com" }],
    ]
  );
  assert.deepEqual(homePaths, ["c.md"]);
});

test("rewriteValues and personToken: the identifier as returned, the label after it", () => {
  const id = "con_" + "01JC2Q8Y4M7T0X3K5N9P2R6S8V";
  assert.equal(personToken(id, "reseller, sales"), `\`${id}\` (reseller, sales)`);
  assert.equal(personToken("usr_" + "76422294-d0d1-4c2a", undefined), "`usr_76422294-d0d1-4c2a`");
  const text = "Call 07700 900456 or 020 7946 0321; notes in C:\\Users\\jbloggs\\git\\notes\n";
  const { findings } = collectValues({ "a.md": text });
  const out = rewriteValues(text, findings["a.md"], (f) =>
    f.kind === "home-path" ? "~" : f.normalised === "+447700900456" ? personToken(id, "reseller, sales") : undefined
  );
  assert.equal(out, `Call \`${id}\` (reseller, sales) or 020 7946 0321; notes in ~\\git\\notes\n`);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc"), ["- b", "+ B"]);
});
