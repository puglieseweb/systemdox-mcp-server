// Binds test/features/edit-project-rules.feature (ids RUL-M-nn): project rules
// listed with their ids, updated and deleted over MCP
// (specs/changes/edit-project-rules-over-mcp/contract.md).
// node:test has no expected failure, so the state tag is held to the binding
// instead, as change-page.test.mjs does: a @proposed scenario must have no
// test here, and a @built one must have one. The pull request that builds a
// scenario adds `scenario(id, fn)` below and flips its tag to @built in the
// same change, or this file fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SystemDoxApiClient } from "../dist/lib/api-client.js";
import { registerGetProjectRules } from "../dist/tools/get-project-rules.js";
import { registerUpdateProjectRule } from "../dist/tools/update-project-rule.js";
import { registerDeleteProjectRule } from "../dist/tools/delete-project-rule.js";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "edit-project-rules.feature");

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
    const m = line.match(/^Scenario: (RUL-M-\d+) (.+)$/);
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

// ── Bound scenarios ──────────────────────────────────────────────────────────

const API_URL = "https://api.example.test/systemdox";
const RULES_PATH = "/systemdox/v1/standards/rules";
const RULE_PATH = /^\/systemdox\/v1\/standards\/rules\/([^/]+)$/;

/** A workspace's rules behind the SystemDox REST API, faked at fetch as
 * standards_api serves its rule routes: the list, PUT and DELETE of one rule,
 * and 404 for a rule the workspace does not have. Every request is recorded in
 * `sent`, as { method, path, body }. */
function workspace(rules) {
  const held = new Map(rules.map((rule) => [rule.id, { ...rule }]));
  const sent = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ method, path, body });
    if (method === "GET" && path === RULES_PATH) return Response.json([...held.values()]);
    const m = RULE_PATH.exec(path);
    const rule = m ? held.get(decodeURIComponent(m[1])) : undefined;
    if (rule && method === "PUT") {
      Object.assign(rule, body);
      return Response.json(rule);
    }
    if (rule && method === "DELETE") {
      held.delete(rule.id);
      return Response.json({ deleted: true });
    }
    return Response.json({ message: "Rule not found" }, { status: 404 });
  };
  return { held, sent, fetch };
}

/** One agent session: the three rule tools on a server, with the real API
 * client and its cache, so a read after a change shows whether the change
 * reached it. */
function session() {
  const tools = new Map();
  const server = { registerTool: (name, meta, fn) => tools.set(name, { meta, fn }) };
  const client = new SystemDoxApiClient({ apiKey: "sdx-test", apiUrl: API_URL, cacheTtlMs: 300_000, defaultOrg: undefined });
  registerGetProjectRules(server, client);
  registerUpdateProjectRule(server, client);
  registerDeleteProjectRule(server, client);
  return {
    meta: (name) => tools.get(name).meta,
    async call(ws, name, args) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = ws.fetch;
      try {
        const answer = await tools.get(name).fn(args);
        return { isError: answer.isError === true, text: answer.content.map((c) => c.text).join("\n") };
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
}

/** get_project_rules' answer as rows: { heading, text, id } for each `- <text> (id: <id>)` line. */
function listed(text) {
  const rows = [];
  let heading;
  for (const line of text.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) heading = h[1];
    const r = /^- (.+) \(id: ([^)]+)\)$/.exec(line);
    if (r) rows.push({ heading, text: r[1], id: r[2] });
  }
  return rows;
}

const DEPLOY = {
  id: "rul_01JD6Q2A",
  text: "All deployments go through GitHub Actions",
  category: "deployment",
  createdAt: "2026-11-01T09:00:00Z",
};
const TESTS = {
  id: "rul_01JD6Q2B",
  text: "Tests run only in the pipeline",
  category: "testing",
  createdAt: "2026-11-02T09:00:00Z",
};

scenario("RUL-M-01", async () => {
  // Given the workspace has a rule "All deployments go through GitHub Actions"
  const ws = workspace([DEPLOY, TESTS]);

  // When an agent lists the project rules
  const { text } = await session().call(ws, "get_project_rules", {});

  // Then each rule is shown with its id (and nothing else in the answer changes)
  assert.equal(
    text,
    "Found 2 project rule(s):\n\n" +
      "## Deployment\n\n- All deployments go through GitHub Actions (id: rul_01JD6Q2A)\n\n" +
      "## Testing\n\n- Tests run only in the pipeline (id: rul_01JD6Q2B)\n\n"
  );
});

scenario("RUL-M-02", async () => {
  // Given the workspace has a rule "All deployments go through GitHub Actions"
  const ws = workspace([DEPLOY]);
  const agent = session();
  await agent.call(ws, "get_project_rules", {}); // this session has read the rules once

  // When an agent gives that rule new words by its id
  const words = "Every deployment goes through a GitHub Actions workflow";
  const changed = await agent.call(ws, "update_project_rule", { id: DEPLOY.id, text: words });
  assert.equal(changed.isError, false, changed.text);
  assert.equal(changed.text, `Project rule updated: **${words}** (id: ${DEPLOY.id}, category: deployment)`);
  assert.deepEqual(ws.sent.at(-1), { method: "PUT", path: `${RULES_PATH}/${DEPLOY.id}`, body: { text: words } });

  // Then the rule says the new words the next time any session reads the rules
  // And it keeps its id and its category
  for (const reader of [agent, session()]) {
    const { text } = await reader.call(ws, "get_project_rules", {});
    assert.deepEqual(listed(text), [{ heading: "Deployment", text: words, id: DEPLOY.id }]);
  }
});

scenario("RUL-M-03", async () => {
  // Given the workspace has a testing rule
  const ws = workspace([TESTS]);
  const agent = session();
  await agent.call(ws, "get_project_rules", {});

  // When an agent moves that rule to the process category by its id
  const moved = await agent.call(ws, "update_project_rule", { id: TESTS.id, category: "process" });
  assert.equal(moved.isError, false, moved.text);
  assert.equal(moved.text, `Project rule updated: **${TESTS.text}** (id: ${TESTS.id}, category: process)`);
  assert.deepEqual(ws.sent.at(-1), { method: "PUT", path: `${RULES_PATH}/${TESTS.id}`, body: { category: "process" } });

  // Then the rule is listed under process, with the same words
  const { text } = await agent.call(ws, "get_project_rules", {});
  assert.deepEqual(listed(text), [{ heading: "Process", text: TESTS.text, id: TESTS.id }]);
});

scenario("RUL-M-04", async () => {
  // Given the workspace has a rule that no longer holds
  const ws = workspace([DEPLOY, TESTS]);
  const agent = session();
  await agent.call(ws, "get_project_rules", {});

  // When an agent deletes that rule by its id
  const deleted = await agent.call(ws, "delete_project_rule", { id: TESTS.id });
  assert.equal(deleted.isError, false, deleted.text);
  assert.equal(deleted.text, `Project rule deleted: ${TESTS.id}`);
  assert.deepEqual(ws.sent.at(-1), { method: "DELETE", path: `${RULES_PATH}/${TESTS.id}`, body: undefined });

  // Then no session sees that rule any more
  for (const reader of [agent, session()]) {
    const { text } = await reader.call(ws, "get_project_rules", {});
    assert.deepEqual(listed(text), [{ heading: "Deployment", text: DEPLOY.text, id: DEPLOY.id }]);
  }
});

scenario("RUL-M-05", async () => {
  const ws = workspace([DEPLOY]);
  const before = structuredClone([...ws.held.values()]);
  const agent = session();

  // When an agent changes or deletes a rule the workspace does not have
  const changed = await agent.call(ws, "update_project_rule", { id: "rul_unknown", text: "Ship on Fridays" });
  const deleted = await agent.call(ws, "delete_project_rule", { id: "rul_unknown" });

  // Then it is told there is no such rule in this workspace
  for (const answer of [changed, deleted]) {
    assert.equal(answer.isError, true);
    assert.equal(answer.text, "No project rule rul_unknown in this workspace.");
  }

  // And no rule changes
  assert.deepEqual([...ws.held.values()], before);
});

scenario("RUL-M-06", async () => {
  const ws = workspace([DEPLOY]);

  // When an agent asks to change a rule but gives neither new words nor a category
  const answer = await session().call(ws, "update_project_rule", { id: DEPLOY.id });

  // Then it is told to give new words or a category
  assert.equal(answer.isError, true);
  assert.equal(answer.text, `Give new words (text) or a category to change rule ${DEPLOY.id}.`);

  // And nothing is sent to SystemDox
  assert.deepEqual(ws.sent, []);
});

// ── The contract's other lines (contract.md) ─────────────────────────────────

test("blank words are refused before anything is sent", async () => {
  const ws = workspace([DEPLOY]);
  const answer = await session().call(ws, "update_project_rule", { id: DEPLOY.id, text: "   " });
  assert.equal(answer.isError, true);
  assert.equal(answer.text, "A rule's words cannot be empty.");
  assert.deepEqual(ws.sent, []);
});

test("a rule's id is sent as one path segment", async () => {
  const ws = workspace([]);
  await session().call(ws, "delete_project_rule", { id: "rul 1/x" });
  assert.deepEqual(ws.sent.map((r) => r.path), [`${RULES_PATH}/rul%201%2Fx`]);
});

test("update writes and delete is marked destructive", () => {
  const agent = session();
  assert.deepEqual(agent.meta("update_project_rule").annotations, { readOnlyHint: false });
  assert.deepEqual(agent.meta("delete_project_rule").annotations, { readOnlyHint: false, destructiveHint: true });
});

test("every scenario has one state tag and a unique id", async () => {
  assert.ok(SCENARIOS.length > 0, "no RUL-M scenario found");
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `an id is used twice: ${ids.sort().join(", ")}`);
  const scenarioLines = (await readFile(FEATURE, "utf8")).match(/^\s*Scenario(?: Outline)?: /gm) ?? [];
  assert.equal(scenarioLines.length, ids.length, "a Scenario line without a RUL-M-nn id");
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
