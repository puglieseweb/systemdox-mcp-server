// What get_context, get_docs, get_specs and get_planning_context answer in a
// workspace larger than one page of /v1/docs. Offline: only SystemDox is a
// stand-in. Build first (`npm run build`), then `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildContext } from "../dist/lib/context-builder.js";
import { createServer } from "../dist/server.js";

const REPO = "acme/docs";
const doc = (id, title, path, doc_type = "documentation") => ({
  id,
  repo_full_name: REPO,
  path,
  title,
  doc_type,
  size: 100,
  synced_at: new Date().toISOString(),
});

const ADR = doc("adr", "ADR-224: the graph walks links", "docs/adr/ADR-224-graph.md", "adr");
const RECORD = doc("record", "The graph links shipped", "docs/changelog/2026-11-04-graph.md");
const FIRST_PAGE = doc("page", "Accessibility review", "docs/a11y.md");

const spec = (draftId, name, requirementCount = 0) => ({
  draftId,
  name,
  status: "draft",
  requirementCount,
  updatedAt: new Date().toISOString(),
});

/** A workspace whose listing is one alphabetical page, and whose search works. */
function workspace(overrides = {}) {
  const calls = [];
  const answers = {
    listing: [FIRST_PAGE],
    search: [RECORD, ADR],
    specs: [],
    stack: [],
    rules: [],
    ...overrides,
  };
  const get = async (path, params) => {
    calls.push({ path, params });
    if (path === "/v1/guardrails") return [];
    if (path === "/v1/specs") return answers.specs;
    if (path === "/v1/ai/settings/stack") return answers.stack;
    if (path === "/v1/standards/rules") return answers.rules;
    if (path === "/v1/doc-repos") return {};
    if (path === "/v1/docs") {
      if (!params?.q) return { items: answers.listing, total: answers.listing.length };
      if (answers.search instanceof Error) throw answers.search;
      return { items: answers.search, total: answers.search.length };
    }
    if (path.startsWith("/v1/specs/")) return { proposalContent: "the proposal" };
    if (path.endsWith("/content")) return { content: "the body of the document" };
    throw new Error(`unexpected ${path}`);
  };
  return { api: { get, getFresh: get }, calls };
}

const TASK = "add a graph route that walks links";
const position = (text, needle) => {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `${needle} is not in the answer`);
  return at;
};

test("the task searches the workspace, so a document past the first page is found", async () => {
  const { api, calls } = workspace();
  const { text } = await buildContext(api, { taskDescription: TASK });
  assert.equal(calls.find((c) => c.path === "/v1/docs").params.q, TASK);
  assert.match(text, /ADR-224: the graph walks links/);
  assert.doesNotMatch(text, /Accessibility review/);
});

test("a decision comes before a changelog entry the search ranked higher", async () => {
  const { api } = workspace();
  const { text } = await buildContext(api, { taskDescription: TASK });
  assert.ok(position(text, ADR.title) < position(text, RECORD.title));
});

test("a search that fails still answers from the listing", async () => {
  const { api } = workspace({
    search: new Error("the search is down"),
    listing: [doc("graph", "Graph links route walks", "docs/graph.md")],
  });
  const { text } = await buildContext(api, { taskDescription: TASK });
  assert.match(text, /Graph links route walks/);
});

test("a listing with nothing about the task is not offered as relevant", async () => {
  const { api } = workspace({ search: [] });
  const { text } = await buildContext(api, { taskDescription: TASK });
  assert.doesNotMatch(text, /Accessibility review/);
});

test("a spec sharing one common word with the task is not relevant", async () => {
  const { api } = workspace({
    specs: [
      spec("vault", "ADR: the customer vault keeps the documents bucket"),
      spec("graph", "Graph links route", 3),
    ],
  });
  const { text } = await buildContext(api, {
    taskDescription: "add a document graph route that walks links",
  });
  assert.doesNotMatch(text, /customer vault/);
  assert.match(text, /Graph links route/);
});

test("a decision draft is not listed beside the ADR it copies, and says what it is", async () => {
  const { api } = workspace({
    specs: [
      spec("copy", `ADR: ${ADR.title}`),
      spec("own", "ADR: graph links walk the route"),
    ],
  });
  const { text } = await buildContext(api, { taskDescription: TASK });
  assert.doesNotMatch(text, /draft_id: copy/);
  assert.match(text, /draft_id: own.*decision record/);
  assert.doesNotMatch(text, /0 requirements/);
});

test("the stack leaves room for the task, naming what the task touches first", async () => {
  const stack = Array.from({ length: 50 }, (_, i) => ({
    id: `s${i}`,
    name: `Library ${i}`,
    category: "tool",
    notes: "a line about what this library is for",
  }));
  stack.push({ id: "py", name: "Python", category: "language", version: "3.11" });
  const { api } = workspace({ stack });
  const { text } = await buildContext(api, {
    taskDescription: TASK,
    filePaths: ["backend/functions/graph_api/app.py"],
  });
  assert.ok(position(text, "Python v3.11") < position(text, "Library 0"));
  assert.match(text, /\d+ more with `get_tech_stack`/);
  assert.doesNotMatch(text, /Library 49/);
});

test("rules over the whole budget still leave the best documents named", async () => {
  const rules = [{ id: "r", text: "x".repeat(8000), category: "process", createdAt: "" }];
  const { api } = workspace({ rules });
  const { text } = await buildContext(api, { taskDescription: TASK, maxTokens: 1500 });
  assert.match(text, /doc_id: adr/);
  assert.match(text, /doc_id: record/);
});

async function callTool(api, name, args = {}) {
  const server = createServer(api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result.content[0].text;
}

test("get_docs asks the API for the folder a path names", async () => {
  const calls = [];
  const get = async (path, params) => {
    calls.push(params);
    const items = (params.pathPrefix ?? "").startsWith("docs/adr/ADR-224") ? [ADR] : [FIRST_PAGE];
    return { items, total: items.length, offset: 0, limit: 50 };
  };
  const text = await callTool({ get, getFresh: get }, "get_docs", { path: "docs/adr/ADR-224*" });
  assert.equal(calls[0].pathPrefix, "docs/adr/ADR-224");
  assert.equal(calls[0].limit, "1000");
  assert.match(text, /ADR-224: the graph walks links/);
});

test("get_docs says when a path could not reach every document", async () => {
  const get = async () => ({ items: [ADR], total: 1200, offset: 0, limit: 1000 });
  const text = await callTool({ get, getFresh: get }, "get_docs", { path: "**/ADR-224*" });
  assert.match(text, /1199 more were not read/);
});

test("get_specs calls a decision draft a decision record", async () => {
  const get = async () => [
    { ...spec("d", "ADR: a decision"), repoFullName: "" },
    { ...spec("r", "A requirement", 2), repoFullName: "" },
  ];
  const text = await callTool({ get, getFresh: get }, "get_specs");
  assert.match(text, /ADR: a decision\*\* \(d\) — draft, decision record/);
  assert.match(text, /A requirement\*\* \(r\) — draft, 2 requirements/);
});

test("get_planning_context says when it shows only the newest decisions", async () => {
  const get = async () => ({
    repoSummaries: [],
    dependencies: [],
    adrs: [{ title: "ADR-224: the graph", repo: REPO }],
    adrTotal: 312,
    specs: [],
    targetRepo: null,
  });
  const text = await callTool({ get, getFresh: get }, "get_planning_context");
  assert.match(text, /## Architecture Decision Records \(1 newest of 312\)/);
  assert.match(text, /ADR-224: the graph \(acme\/docs\)/);
});
