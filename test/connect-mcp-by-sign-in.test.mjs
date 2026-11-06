// Binds test/features/connect-mcp-by-sign-in.feature (ADR-229, ids MCS-M-nn).
// The behaviour part of the brief (ADR-201 Amendment 2): every scenario is
// @proposed. node:test has no expected failure, so the state tag is held to the
// binding instead: a @proposed scenario must have no test here, and a @built one
// must have one. The pull request that builds a scenario adds `scenario(id, fn)`
// below and flips its tag to @built in the same change, or this file fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "connect-mcp-by-sign-in.feature");

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
    const match = line.match(/^Scenario: (MCS-M-\d+) (.+)$/);
    if (match) found.push({ id: match[1], title: match[2], tags });
    if (line) tags = [];
  }
  return found;
}

const SCENARIOS = readScenarios(await readFile(FEATURE, "utf8"));
const TITLES = new Map(SCENARIOS.map((s) => [s.id, s.title]));
const bound = new Set();

// The build's stories call this for each scenario they flip to @built.
// eslint-disable-next-line no-unused-vars
function scenario(id, fn) {
  assert.ok(TITLES.has(id), `${id} is not a scenario in the feature file`);
  bound.add(id);
  test(`${id} ${TITLES.get(id)}`, fn);
}

test("the feature holds its scenarios, each with a unique id and one state tag", () => {
  assert.equal(SCENARIOS.length, 33);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  for (const s of SCENARIOS) {
    const state = s.tags.filter((t) => t === "@proposed" || t === "@built");
    assert.equal(state.length, 1, `${s.id} needs exactly one of @proposed or @built, has ${s.tags.join(" ")}`);
  }
});

test("a @proposed scenario has no test yet, and a @built one has one", () => {
  for (const s of SCENARIOS) {
    if (s.tags.includes("@built")) assert.ok(bound.has(s.id), `${s.id} is @built but nothing binds it`);
    if (s.tags.includes("@proposed")) assert.ok(!bound.has(s.id), `${s.id} has a test: flip it to @built`);
  }
});
