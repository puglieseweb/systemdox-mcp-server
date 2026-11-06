// The contract test of get_change (CHG-6, ADR-218; contract.md §5.1) against
// the Change schema of specs/changes/change-page/openapi.yaml — the 200 of
// GET /changes/{owner}/{repo}/{slug} (operationId getChange).
//
// The package has no YAML parser among its dependencies, so the schema facts
// used here are copied below from openapi.yaml, each under the name of its
// schema, and the first test holds every copy to the file's text by a line
// read (as person-values.test.mjs reads PersonId). The fixture,
// fixtures/change-built.json, is getChange's `built` example as JSON; the
// second test holds each of its values to the file's text and its shape to the
// schema. Offline: the real API client runs over a faked fetch. Build first
// (`pnpm build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SystemDoxApiClient } from "../dist/lib/api-client.js";
import { briefVerdict, registerGetChange } from "../dist/tools/get-change.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// The change's folder: specs/changes/ until the change is archived.
const OPENAPI = ["changes", "archive"]
  .map((folder) => join(HERE, "..", "..", "..", "specs", folder, "change-page", "openapi.yaml"))
  .find((path) => existsSync(path));
assert.ok(OPENAPI, "the contract specs/changes/change-page/openapi.yaml is in the repository");
const OPENAPI_TEXT = await readFile(OPENAPI, "utf8");
const BUILT = JSON.parse(await readFile(join(HERE, "fixtures", "change-built.json"), "utf8"));

// ── The schema, copied from openapi.yaml (components.schemas) ───────────────
// State.enum: ADR-218 §2.3.2's five words.
const STATES = ["not yet", "waiting for your review", "passed", "being built", "done"];
// PartName.enum.
const PARTS = ["decision", "contract", "behaviour", "plan", "release"];
// Scenario.state.enum: the tag without @, '' when untagged.
const SCENARIO_STATES = ["proposed", "built", "defect", "unbuilt", "open", ""];
// <schema>.required — for Change and FeatureFile, their own allOf member's;
// Change.<part> and Board.items, that property's.
const REQUIRED = {
  ChangeSummary: ["key", "owner", "repo", "slug", "title", "size", "archived", "states", "counts", "waitingForReview", "lastActivity", "syncedAt"],
  Change: ["proposal", "decision", "contract", "behaviour", "plan", "release"],
  "Change.contract": ["files", "operations", "channels"],
  "Change.behaviour": ["files", "counts"],
  "Change.plan": ["file", "draftId", "board"],
  "Change.release": ["prs"],
  ChangeStates: ["decision", "contract", "behaviour", "plan", "release"],
  ScenarioCounts: ["proposed", "built", "defect", "unbuilt", "open", "untagged", "total"],
  PullRequest: ["number", "title", "state", "base", "repo", "openedAt", "mergedAt", "url", "approvingReview"],
  TrackedFile: ["path", "docId", "pullRequest", "direct"],
  Decision: ["adr", "title", "status", "docId", "pullRequest"],
  FeatureFile: ["title", "runner", "scenarios", "counts"],
  Scenario: ["id", "title", "state", "steps"],
  Board: ["number", "title", "url", "items"],
  "Board.items": ["todo", "inProgress", "done", "truncated"],
};

// ── openapi.yaml read by line, not parsed ───────────────────────────────────
const LINES = OPENAPI_TEXT.split(/\r?\n/);
const indent = (line) => line.length - line.trimStart().length;

/** The mapping entry `key:` (alone on its line) first found in `lines`: that
 * line and every following line indented deeper. */
function entry(lines, key) {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  assert.ok(start >= 0, `openapi.yaml has no "${key}:" line where it was looked for`);
  const end = lines.findIndex((line, n) => n > start && line.trim() !== "" && indent(line) <= indent(lines[start]));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The first one-line flow list `<key>: [a, b, '']` in `lines`. */
function flowList(lines, key) {
  const line = lines.find((l) => l.trimStart().startsWith(`${key}: [`));
  assert.ok(line, `openapi.yaml: no "${key}: [...]" line under ${lines[0].trim()}`);
  return line
    .slice(line.indexOf("[") + 1, line.lastIndexOf("]"))
    .split(",")
    .map((item) => item.trim().replace(/^'(.*)'$/, "$1"));
}

/** `Change.contract` → the lines of components.schemas.Change's `contract:`. */
const schema = (path) => path.split(".").reduce(entry, entry(LINES, "schemas"));

// ── A Change by the schema ───────────────────────────────────────────────────
function hasRequired(value, name, where) {
  assert.ok(value !== null && typeof value === "object", `${where} is an object`);
  for (const key of REQUIRED[name]) assert.ok(key in value, `${where} has ${key} (${name})`);
}

function assertPullRequest(pr, where) {
  hasRequired(pr, "PullRequest", where);
  assert.ok(["open", "merged"].includes(pr.state), `${where}.state is open or merged`);
}

function assertTrackedFile(file, where) {
  hasRequired(file, "TrackedFile", where);
  if (file.pullRequest !== null) assertPullRequest(file.pullRequest, `${where}.pullRequest`);
}

function assertChange(c) {
  hasRequired(c, "ChangeSummary", "change");
  hasRequired(c, "Change", "change");
  hasRequired(c.states, "ChangeStates", "states");
  for (const part of PARTS) {
    if (part === "decision" && c.states.decision === null) continue;
    assert.ok(STATES.includes(c.states[part]), `states.${part} is one of the five words`);
  }
  assert.equal(c.decision === null, c.states.decision === null, "a change has a decision state when it has a decision");
  hasRequired(c.counts, "ScenarioCounts", "counts");
  c.waitingForReview.forEach((pr, i) => assertPullRequest(pr, `waitingForReview[${i}]`));
  assertTrackedFile(c.proposal, "proposal");
  if (c.decision !== null) {
    hasRequired(c.decision, "Decision", "decision");
    if (c.decision.pullRequest !== null) assertPullRequest(c.decision.pullRequest, "decision.pullRequest");
  }
  hasRequired(c.contract, "Change.contract", "contract");
  c.contract.files.forEach((file, i) => assertTrackedFile(file, `contract.files[${i}]`));
  hasRequired(c.behaviour, "Change.behaviour", "behaviour");
  hasRequired(c.behaviour.counts, "ScenarioCounts", "behaviour.counts");
  c.behaviour.files.forEach((file, i) => {
    const where = `behaviour.files[${i}]`;
    assertTrackedFile(file, where);
    hasRequired(file, "FeatureFile", where);
    hasRequired(file.counts, "ScenarioCounts", `${where}.counts`);
    file.scenarios.forEach((s, j) => {
      hasRequired(s, "Scenario", `${where}.scenarios[${j}]`);
      assert.ok(SCENARIO_STATES.includes(s.state), `${where}.scenarios[${j}].state`);
    });
  });
  hasRequired(c.plan, "Change.plan", "plan");
  if (c.plan.file !== null) assertTrackedFile(c.plan.file, "plan.file");
  if (c.plan.board !== null) {
    hasRequired(c.plan.board, "Board", "plan.board");
    hasRequired(c.plan.board.items, "Board.items", "plan.board.items");
  }
  hasRequired(c.release, "Change.release", "release");
  c.release.prs.forEach((pr, i) => assertPullRequest(pr, `release.prs[${i}]`));
}

function* leaves(value) {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) yield* leaves(v);
  } else {
    yield value;
  }
}

// ── get_change as an agent calls it ─────────────────────────────────────────
const API_URL = "https://api.example.test/systemdox";

function register() {
  let tool;
  const server = { registerTool: (name, meta, fn) => (tool = { name, meta, fn }) };
  const client = new SystemDoxApiClient({ apiKey: "sdx-test", apiUrl: API_URL, cacheTtlMs: 0, defaultOrg: undefined });
  registerGetChange(server, client);
  return tool;
}

/** The API answering one change at its own path and 404 SYD-K023 at any other. */
const serving = (change) => (path) =>
  path === `/systemdox/v1/changes/${change.owner}/${change.repo}/${change.slug}`
    ? Response.json(change)
    : Response.json({ code: "SYD-K023", status: 404, title: "No such change", detail: "SYD-K023: no such change" }, { status: 404 });

/** Call the tool with the REST API faked at fetch by `answer(path)`. */
async function call(args, answer) {
  const { fn } = register();
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    requests.push({ method: init.method ?? "GET", path: pathname, authorization: init.headers?.Authorization });
    return answer(pathname);
  };
  try {
    const result = await fn(args);
    return { result, text: result.content.map((c) => c.text).join("\n"), requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const REMINDERS = { repo: "acme/booking-api", slug: "customer-reminders" };

// ── The tests ────────────────────────────────────────────────────────────────

test("the schema copied here is openapi.yaml's", () => {
  assert.deepEqual(flowList(schema("State"), "enum"), STATES);
  assert.deepEqual(flowList(schema("PartName"), "enum"), PARTS);
  assert.deepEqual(flowList(schema("Scenario.state"), "enum"), SCENARIO_STATES);
  for (const [name, required] of Object.entries(REQUIRED)) {
    assert.deepEqual(flowList(schema(name), "required"), required, name);
  }
});

test("the fixture is getChange's built example, and a Change by the schema", () => {
  const example = entry(LINES, "built").join("\n");
  for (const value of leaves(BUILT)) {
    if (typeof value === "string" || typeof value === "number") {
      assert.ok(example.includes(String(value)), `the built example holds ${JSON.stringify(value)}`);
    }
  }
  assertChange(BUILT);
});

test("get_change is a read-only tool that asks GET /changes/{owner}/{repo}/{slug} once, with the caller's key", async () => {
  const { name, meta } = register();
  assert.equal(name, "get_change");
  assert.equal(meta.annotations.readOnlyHint, true);
  const { requests } = await call(REMINDERS, serving(BUILT));
  assert.deepEqual(requests, [
    { method: "GET", path: "/systemdox/v1/changes/acme/booking-api/customer-reminders", authorization: "Bearer sdx-test" },
  ]);
});

test("the answer holds the Change object whole in a fenced JSON block", async () => {
  const { text } = await call(REMINDERS, serving(BUILT));
  const blocks = [...text.matchAll(/^```json\n(.*?)\n```$/gms)];
  assert.equal(blocks.length, 1, "one JSON block");
  const change = JSON.parse(blocks[0][1]);
  assert.deepEqual(change, BUILT);
  assertChange(change);
});

test("the answer reads as contract.md §5.1 lists it, and its last line is the brief's verdict", async () => {
  const { result, text } = await call(REMINDERS, serving(BUILT));
  assert.equal(result.isError, undefined);
  const pr219 = "[acme/booking-api#219](https://github.com/acme/booking-api/pull/219) merged";
  const markdown = [
    "# A customer is reminded of a booking by message, on the location's schedule",
    "",
    "`CHANGE#acme/booking-api#customer-reminders` · size: ordinary · synced 2026-11-01T08:00:12Z",
    "",
    "| Part | State | Pull request |",
    "|---|---|---|",
    "| decision | passed | [acme/docs#412](https://github.com/acme/docs/pull/412) merged |",
    `| contract | passed | ${pr219} |`,
    `| behaviour | being built | ${pr219} |`,
    `| plan | being built | ${pr219} |`,
    "| release | waiting for your review | [acme/booking-api#226](https://github.com/acme/booking-api/pull/226) open |",
    "",
    "## Decision",
    "",
    "ADR-044 · accepted — A customer is reminded of a booking by message, on the location's schedule",
    "",
    "## Contract",
    "",
    `- specs/changes/customer-reminders/openapi.yaml — ${pr219}`,
    "",
    "## Behaviour",
    "",
    "9 scenario(s): 9 built",
    "",
    "### tests/features/reminders.feature",
    "",
    `A customer is reminded of a booking (ADR-044) · runner pytest-bdd · ${pr219} · 9 scenario(s): 9 built`,
    "",
    "- REM-01 · built · A location sets a lead time and an hour",
    "",
    "## Plan",
    "",
    `- plan.md: specs/changes/customer-reminders/plan.md — ${pr219}`,
    "- Draft: pln_01JBXW3K9QZ6R8T2M5N7P0AVCD",
    "- Board: [#74 Booking: customer reminders (ADR-044)](https://github.com/orgs/acme/projects/74) — todo 0 · in progress 1 · done 8",
    "",
    "## Release",
    "",
    "- [acme/booking-api#226](https://github.com/acme/booking-api/pull/226) open · Release: preprod to main · no approving review on its head yet",
  ].join("\n");
  // Then the JSON block (the test above), then the verdict.
  assert.equal(text.slice(0, text.indexOf("```json")), `${markdown}\n\n`);
  // Behaviour and plan being built, the release waiting: the brief has passed.
  assert.equal(text.split("\n").at(-1), "The brief is passed");
});

test("a part has passed once it reads passed, being built or done; the release is no part of the brief", () => {
  const passed = { decision: "passed", contract: "passed", behaviour: "passed", plan: "passed", release: "not yet" };
  assert.equal(briefVerdict(passed), "The brief is passed");
  for (const word of STATES) {
    const past = ["passed", "being built", "done"].includes(word);
    assert.equal(
      briefVerdict({ ...passed, plan: word }),
      past ? "The brief is passed" : `The brief is not passed: plan is ${word}`,
      word
    );
    assert.equal(briefVerdict({ ...passed, release: word }), "The brief is passed", `release ${word}`);
  }
  // A small change has no decision; it holds nothing up.
  assert.equal(briefVerdict({ ...passed, decision: null }), "The brief is passed");
  // Every part that waits is named, in the page's order.
  assert.equal(
    briefVerdict({ ...passed, behaviour: "waiting for your review", decision: "not yet" }),
    "The brief is not passed: decision is not yet, behaviour is waiting for your review"
  );
});

test("a change without a decision has no decision row, and a missing plan reads none", async () => {
  const small = {
    ...BUILT,
    size: "small",
    states: { ...BUILT.states, decision: null, plan: "not yet" },
    decision: null,
    plan: { file: null, draftId: null, board: null },
  };
  assertChange(small);
  const { text } = await call(REMINDERS, serving(small));
  assert.doesNotMatch(text, /^\| decision \|/m);
  assert.match(text, /^## Decision\n\nNone: the proposal names no ADR \(a small change\)\.$/m);
  assert.match(text, /^- plan\.md: none\n- Draft: none\n- Board: none$/m);
  assert.equal(text.split("\n").at(-1), "The brief is not passed: plan is not yet");
});

test("a 404 answers No such change <repo>/<slug>; any other refusal is the API's own error", async () => {
  const missing = await call({ repo: "acme/booking-api", slug: "nothing-here" }, serving(BUILT));
  assert.equal(missing.result.isError, true);
  assert.equal(missing.text, "No such change acme/booking-api/nothing-here");

  await assert.rejects(
    call(REMINDERS, () => new Response("upstream timed out", { status: 502 })),
    /SystemDox API error 502: upstream timed out/
  );
});

test("repo is owner/name and slug a change folder's name, as openapi.yaml's path parameters", () => {
  const { repo, slug } = register().meta.inputSchema;
  assert.equal(repo.safeParse("acme/booking-api").success, true);
  for (const bad of ["acme", "acme/booking-api/x", "../booking-api", "acme/..", "acme/", ""]) {
    assert.equal(repo.safeParse(bad).success, false, bad);
  }
  assert.equal(slug.safeParse("customer-reminders").success, true);
  for (const bad of ["Customer-Reminders", "customer--reminders", "-reminders", "../x", "a".repeat(65), ""]) {
    assert.equal(slug.safeParse(bad).success, false, bad);
  }
});
