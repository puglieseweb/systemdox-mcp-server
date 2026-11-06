// Binds test/features/document-graph.feature (ADR-224, ids GRF-M-nn). The server
// and the tools are real: a session connects over the SDK's in-memory transport.
// Only SystemDox is a stand-in, answering as openapi.yaml says.
// Build first (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SystemDoxApiError } from "../dist/lib/api-client.js";
import { createServer } from "../dist/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE = await readFile(join(HERE, "features", "document-graph.feature"), "utf8");
const TITLES = new Map([...FEATURE.matchAll(/^\s*Scenario: (GRF-M-\d+) (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
const bound = new Set();
function scenario(id, fn) {
  assert.ok(TITLES.has(id), `${id} is not a scenario in the feature file`);
  bound.add(id);
  test(`${id} ${TITLES.get(id)}`, fn);
}

const node = (id, label, repo = "acme/api") => ({ id, label, type: "documentation", repo, path: `docs/${id}.md` });
const GUIDE = node("RepoDoc#acme/api#guide", "Guide");
const TARGET = node("RepoDoc#acme/api#target", "Target");
const ADR_DOCS = node("RepoDoc#acme/docs#adr7", "ADR-007 in docs", "acme/docs");
const ADR_WEB = node("RepoDoc#acme/web#adr7", "ADR-007 in web", "acme/web");

function clientFor(answers) {
  const calls = [];
  const answer = (path, params) => {
    calls.push({ path, params });
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(params) : value;
  };
  return { calls, get: async (path, params) => answer(path, params), getFresh: async (path) => answer(path) };
}

async function connect(apiClient) {
  const server = createServer(apiClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function ask(apiClient, name, args = {}) {
  const client = await connect(apiClient);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return { text: result.content[0].text, isError: result.isError };
}

const LINK = {
  direction: "out",
  relation: "links_to",
  provenance: "extracted",
  confidence: 1,
  file: "docs/guide.md",
  line: 3,
  other: TARGET,
};

scenario("GRF-M-01", async () => {
  const api = clientFor({
    "/v1/graph/neighbours": {
      doc: GUIDE,
      links: [LINK],
      ambiguous: [{ reference: "ADR-007", file: "docs/guide.md", line: 9, candidates: [ADR_DOCS, ADR_WEB] }],
      total: 1,
      truncated: false,
    },
  });
  const { text } = await ask(api, "get_document_links", { doc_id: GUIDE.id });
  assert.deepEqual(api.calls[0].params, { doc: GUIDE.id, limit: "50" });
  assert.match(text, /out · links_to · extracted 1 · Target/);
  assert.match(text, /docs\/guide\.md:3/);
  assert.match(text, /ADR-007 at docs\/guide\.md:9: .*acme\/docs.*acme\/web/);
});

scenario("GRF-M-02", async () => {
  const api = clientFor({
    "/v1/graph/path": {
      found: true,
      hops: 2,
      confidence: 0.85,
      steps: [
        { from: GUIDE, to: ADR_DOCS, relation: "cites", provenance: "inferred", confidence: 0.85, file: "docs/guide.md", line: 2, reversed: false },
        { from: ADR_DOCS, to: TARGET, relation: "cites", provenance: "extracted", confidence: 1, file: "docs/target.md", line: 4, reversed: true },
      ],
    },
  });
  const { text } = await ask(api, "trace_document_path", { from: GUIDE.id, to: TARGET.id });
  assert.match(text, /^1\. Guide -> cites -> ADR-007 in docs · inferred 0\.85/m);
  assert.match(text, /^2\. ADR-007 in docs <- cites <- Target · extracted 1/m);
  assert.match(text, /Path confidence: 0\.85/);
});

scenario("GRF-M-03", async () => {
  const fresh = { repo: "acme/api", documents: 4, links: 9, indexedCommit: "aaa", indexedAt: "t", headCommit: "aaa", pushedAt: "t", behind: false };
  const late = { ...fresh, repo: "acme/web", indexedCommit: "bbb", headCommit: "ccc", behind: true };
  const api = clientFor({
    "/v1/graph/stats": {
      nodeCount: 8,
      edgeCount: 18,
      links: { declared: 1, extracted: 15, inferred: 2, ambiguous: 3 },
      repos: [fresh, late],
    },
    "/v1/graph/repos": {
      links: [{ source: "acme/api", target: "acme/cicd", relation: "uses_workflow", provenance: "extracted", confidence: 1, file: ".github/workflows/ci.yml", line: 9 }],
    },
  });
  const { text } = await ask(api, "get_graph_stats");
  assert.match(text, /1 declared · 15 extracted · 2 inferred · 3 ambiguous/);
  assert.match(text, /acme\/web: .*BEHIND: pushed ccc/);
  assert.doesNotMatch(text.split("\n").find((l) => l.startsWith("- acme/api:")), /BEHIND/);
  assert.match(text, /acme\/api uses_workflow acme\/cicd/);
});

scenario("GRF-M-04", async () => {
  const api = clientFor({
    "/v1/graph/neighbours": { doc: GUIDE, links: [LINK], ambiguous: [], total: 7, truncated: true },
  });
  const { text } = await ask(api, "get_document_links", { doc_id: GUIDE.id, limit: 1 });
  assert.match(text, /Showing 1 of 7\. Raise limit to see more\./);
});

test("a document the caller may not read answers in the API's own words", async () => {
  const api = clientFor({ "/v1/graph/neighbours": new SystemDoxApiError(404, '{"code":"SYD-K028"}') });
  const { text, isError } = await ask(api, "get_document_links", { doc_id: "RepoDoc#x#y" });
  assert.equal(isError, true);
  assert.match(text, /SYD-K028/);
});

test("two documents with no connection are told so", async () => {
  const api = clientFor({ "/v1/graph/path": { found: false, hops: 0, confidence: 0, steps: [] } });
  const { text } = await ask(api, "trace_document_path", { from: "a", to: "b", max_hops: 3 });
  assert.equal(text, "No path within 3 hops.");
});

test("a failure that is not a refusal is not swallowed", async () => {
  const api = clientFor({ "/v1/graph/path": new SystemDoxApiError(500, "boom") });
  const { text, isError } = await ask(api, "trace_document_path", { from: "a", to: "b" });
  assert.equal(isError, true);
  assert.match(text, /500/);
});

test("every scenario in the feature file is bound and built", () => {
  assert.deepEqual([...bound].sort(), [...TITLES.keys()].sort());
  assert.doesNotMatch(FEATURE, /^\s*@proposed/m);
});
