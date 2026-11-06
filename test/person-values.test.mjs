// The client's person-value detector against the shared vectors (ADR-217
// Amendment 2, TSU-M-34). specs/changes/team-setup/person-values.json is part
// of the contract and the only fixture: the backend's detector
// (backend/layers/common/common/person_values.py) is held to the same file by
// backend/tests/test_person_values.py. Every example is its own test, so a
// failure names it. The JSON is read from the repository by a relative path
// and is never part of the published package (package.json `files`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMAIL,
  HOME_PATH,
  PERSON_ID,
  PERSON_TOKEN,
  PHONE,
  findPersonValues,
  findSecrets,
  normalise,
  rewriteHomePaths,
} from "../dist/lib/person-values.js";

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "specs", "changes", "team-setup", "person-values.json"
);
const VECTORS = JSON.parse(await readFile(VECTORS_PATH, "utf8"));

test("person-values.json: every kind of example is read by a test here", () => {
  assert.deepEqual(Object.keys(VECTORS).filter((k) => k !== "$comment").sort(), ["found", "not_found", "secret"]);
  assert.deepEqual([...new Set(VECTORS.found.map((v) => v.kind))].sort(), [EMAIL, HOME_PATH, PHONE].sort());
  for (const v of VECTORS.found) assert.ok(("normalised" in v) !== ("rewritten" in v), v.text);
});

for (const v of VECTORS.found) {
  test(`found: ${v.text}`, () => {
    const findings = findPersonValues(v.text);
    assert.deepEqual(findings.map((f) => [f.kind, f.value]), [[v.kind, v.value]]);
    assert.equal(v.text.slice(findings[0].start, findings[0].end), v.value);
    assert.equal(findings[0].line, 1);
    if ("normalised" in v) {
      assert.equal(findings[0].normalised, v.normalised);
      assert.equal(normalise(v.kind, v.value), v.normalised);
    }
    if ("rewritten" in v) {
      assert.equal(rewriteHomePaths(v.text), v.rewritten);
      assert.deepEqual(findPersonValues(v.rewritten), [], "the rewrite is never found again");
    }
  });
}

for (const v of VECTORS.not_found) {
  test(`not found: ${v.text}`, () => {
    assert.deepEqual(findPersonValues(v.text), [], v.why);
  });
}

for (const v of VECTORS.secret) {
  test(`secret: ${v.text}`, () => {
    assert.deepEqual(findSecrets(v.text).map((s) => s.kind), [v.kind]);
    assert.deepEqual(findPersonValues(v.text), []);
  });
}

test("a finding names its line", () => {
  const [finding] = findPersonValues("line one\nline two\ncall 07700 900123\n");
  assert.equal(finding.line, 3);
  assert.equal(findSecrets("a\n\nthe key " + "sk-ant-" + "abcd1234")[0].line, 3);
});

test("a person token is skipped but the rest of the line is read", () => {
  const text = "filed `con_01JC2Q8Y4M7T0X3K5N9P2R6S8V` (reseller, sales); office 020 7946 0321";
  assert.deepEqual(findPersonValues(text).map((f) => [f.kind, f.normalised]), [[PHONE, "+442079460321"]]);
});

test("a member token keeps its hyphens and is skipped (proposal item 22)", () => {
  const text = "owner `usr_76422294-d0d1-4e2a-9b1c-0123456789ab` (owner) on 07700 900123";
  assert.deepEqual(findPersonValues(text).map((f) => [f.kind, f.normalised]), [[PHONE, "+447700900123"]]);
  assert.deepEqual(text.match(new RegExp(PERSON_TOKEN, "g")), ["`usr_76422294-d0d1-4e2a-9b1c-0123456789ab` (owner)"]);
});

test("the person token is built from the one PersonId pattern, and it is the contract's", async () => {
  const openapi = await readFile(join(dirname(VECTORS_PATH), "openapi.yaml"), "utf8");
  const contract = /PersonId:\s*\n\s*type: string\s*\n\s*pattern: '([^']+)'/.exec(openapi)?.[1];
  assert.ok(contract, "openapi.yaml has a PersonId pattern");
  assert.equal(`^${PERSON_ID}$`, contract);
  assert.ok(PERSON_TOKEN.includes(PERSON_ID));
});

test("a member's token keeps its hyphens and is skipped, label and all", () => {
  // shared-auth's member id is usr_<Cognito sub>, a UUID with hyphens (proposal
  // item 22). resolve_person's input check is held in team-setup.test.mjs (TSU-M-29).
  const member = "usr_" + "76422294-d0d1-7023-a659-b346009638be";
  const text = `the owner is \`${member}\` (owner, 07700 900123); desk 020 7946 0321`;
  assert.deepEqual(findPersonValues(text).map((f) => [f.kind, f.normalised]), [[PHONE, "+442079460321"]]);
  const token = new RegExp(`^${PERSON_TOKEN}$`, "u");
  assert.match(`\`${member}\` (owner)`, token);
  assert.doesNotMatch("`con_" + "01JC2Q8Y4M-7T0X3K5N9P2R6S8V` (owner)", token, "a con_ admits no hyphen");
  assert.doesNotMatch("`usr_" + "76422294_d0d1_7023` (owner)", token, "only letters, digits and hyphens");
});

test("normalise refuses what is not a value of its kind", () => {
  for (const [kind, value] of [
    [PHONE, "41223694205"],
    [PHONE, "call me"],
    [EMAIL, "jo@"],
    [EMAIL, "@puglieseweb/x"],
    [HOME_PATH, "/home/jo"],
  ]) {
    assert.throws(() => normalise(kind, value), undefined, `${kind} ${value}`);
  }
});
