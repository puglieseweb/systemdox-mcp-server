// Binds test/features/change-page.feature (ADR-218, ids CHG-M-nn).
// The behaviour part of the brief (ADR-201 Amendment 2): every scenario is
// @proposed. node:test has no expected failure, so the state tag is held to
// the binding instead: a @proposed scenario must have no test here, and a
// @built one must have one. The pull request that builds a scenario adds
// `scenario(id, fn)` below and flips its tag to @built in the same change, or
// this file fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SystemDoxApiClient } from "../dist/lib/api-client.js";
import { registerGetChange } from "../dist/tools/get-change.js";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "change-page.feature");
// getChange's `built` example of specs/changes/change-page/openapi.yaml, as
// JSON; get-change.test.mjs holds it to the contract.
const BUILT = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "change-built.json"), "utf8")
);

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
    const m = line.match(/^Scenario: (CHG-M-\d+) (.+)$/);
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

// ── Bound scenarios. Build PRs add scenario("CHG-M-nn", async () => { … }) here. ──

/** get_change as an agent calls it: the tool on a server, the real API client,
 * and the SystemDox REST API faked at fetch with the changes the workspace may
 * read, keyed owner/repo/slug. Any other change answers 404 SYD-K023, as
 * GET /changes/{owner}/{repo}/{slug} does (openapi.yaml). */
async function getChange(workspace, args) {
  let tool;
  const server = { registerTool: (name, _meta, fn) => { if (name === "get_change") tool = fn; } };
  const apiUrl = "https://api.example.test/systemdox";
  registerGetChange(server, new SystemDoxApiClient({ apiKey: "sdx-test", apiUrl, cacheTtlMs: 0, defaultOrg: undefined }));
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    const m = /^\/systemdox\/v1\/changes\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    const change = m ? workspace[m.slice(1).join("/")] : undefined;
    return change
      ? Response.json(change)
      : Response.json({ code: "SYD-K023", status: 404, title: "No such change", detail: "SYD-K023: no such change" }, { status: 404 });
  };
  try {
    const answer = await tool(args);
    return { answer, text: answer.content.map((c) => c.text).join("\n"), asked };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The answer's table of parts, as part → state. */
function partStates(text) {
  const rows = text.split("\n").filter((line) => /^\| [a-z]+ \| /.test(line));
  return Object.fromEntries(rows.map((row) => row.split("|").slice(1, 3).map((cell) => cell.trim())));
}

const REMINDERS = { repo: "acme/booking-api", slug: "customer-reminders" };

scenario("CHG-M-01", async () => {
  // Given the change "customer-reminders" of "acme/booking-api" has its
  // decision, contract and behaviour passed and no plan yet
  const proposed = [
    { ...BUILT.behaviour.files[0].scenarios[0], state: "proposed" },
    {
      id: "REM-02",
      title: "A customer is reminded at the location's hour",
      state: "proposed",
      steps: ["Given a booking tomorrow at 10:00", "When 18:00 comes today", "Then the customer is sent a reminder"],
    },
  ];
  const counts = { proposed: 2, built: 0, defect: 0, unbuilt: 0, open: 0, untagged: 0, total: 2 };
  const contractMd = {
    ...BUILT.contract.files[0],
    path: "specs/changes/customer-reminders/contract.md",
    docId: "RepoDoc#acme/booking-api#5b8e1f0c2d94",
  };
  const change = {
    ...BUILT,
    states: { decision: "passed", contract: "passed", behaviour: "passed", plan: "not yet", release: "not yet" },
    counts,
    waitingForReview: [],
    contract: { ...BUILT.contract, files: [BUILT.contract.files[0], contractMd] },
    behaviour: { files: [{ ...BUILT.behaviour.files[0], scenarios: proposed, counts }], counts },
    plan: { file: null, draftId: null, board: null },
    release: { prs: [] },
  };

  // When get_change is called for "acme/booking-api" and "customer-reminders"
  const { text, asked } = await getChange({ "acme/booking-api/customer-reminders": change }, REMINDERS);
  assert.deepEqual(asked, ["/systemdox/v1/changes/acme/booking-api/customer-reminders"]);

  // Then the answer gives each of the four parts with its state
  const { decision, contract, behaviour, plan } = partStates(text);
  assert.deepEqual(
    { decision, contract, behaviour, plan },
    { decision: "passed", contract: "passed", behaviour: "passed", plan: "not yet" }
  );

  // And it lists the contract files by path and every scenario with its id and its tag
  for (const file of change.contract.files) assert.ok(text.includes(`\n- ${file.path} — `), file.path);
  for (const s of proposed) assert.ok(text.includes(`\n- ${s.id} · ${s.state} · ${s.title}\n`), `${s.id} with its tag`);
});

scenario("CHG-M-02", async () => {
  // Given the contract part of "customer-reminders" is waiting for review: an
  // amendment of its openapi.yaml is open
  const amendment = {
    number: 231,
    title: "brief(customer-reminders): amend the contract",
    state: "open",
    base: "preprod",
    repo: "acme/booking-api",
    openedAt: "2026-10-31T12:00:00Z",
    mergedAt: null,
    url: "https://github.com/acme/booking-api/pull/231",
    approvingReview: null,
  };
  const change = {
    ...BUILT,
    states: { ...BUILT.states, contract: "waiting for your review" },
    waitingForReview: [amendment, ...BUILT.waitingForReview],
    lastActivity: amendment.openedAt,
    contract: { ...BUILT.contract, files: [{ ...BUILT.contract.files[0], pullRequest: amendment }] },
  };

  // When get_change is called for "acme/booking-api" and "customer-reminders"
  const { answer, text } = await getChange({ "acme/booking-api/customer-reminders": change }, REMINDERS);

  // Then the answer says the brief is not passed and names the contract part as the one that waits
  assert.equal(answer.isError, undefined);
  assert.equal(text.split("\n").at(-1), "The brief is not passed: contract is waiting for your review");
  assert.ok(
    text.includes("\n| contract | waiting for your review | [acme/booking-api#231](https://github.com/acme/booking-api/pull/231) open |\n"),
    "the contract's row links the pull request that waits"
  );
});

scenario("CHG-M-03", async () => {
  // When get_change is called for "acme/booking-api" and "nothing-here"
  const { answer, text, asked } = await getChange(
    { "acme/booking-api/customer-reminders": BUILT },
    { repo: "acme/booking-api", slug: "nothing-here" }
  );

  // Then the answer says there is no such change
  assert.deepEqual(asked, ["/systemdox/v1/changes/acme/booking-api/nothing-here"], "the API answered 404");
  assert.equal(answer.isError, true);
  assert.equal(text, "No such change acme/booking-api/nothing-here");
});

test("every scenario has one state tag and a unique id", async () => {
  assert.ok(SCENARIOS.length > 0, "no CHG-M scenario found");
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `an id is used twice: ${ids.sort().join(", ")}`);
  // Every Scenario line carries an id of this file's series, or the guard never saw it.
  const scenarioLines = (await readFile(FEATURE, "utf8")).match(/^\s*Scenario(?: Outline)?: /gm) ?? [];
  assert.equal(scenarioLines.length, ids.length, "a Scenario line without a CHG-M-nn id");
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
