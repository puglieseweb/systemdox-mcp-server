// Unit tests for the get_context builder (packages/mcp-server/src/lib/context-builder.ts).
// Offline: a fake API client stands in for the SystemDox REST API. Build first
// (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContext,
  estimateTokens,
} from "../dist/lib/context-builder.js";

const DOC_BODY =
  "# Auth Design\n\n" +
  "All REST handlers MUST call resolve_principal(event) and key every write " +
  "with tenant_pk(principal). Client-supplied tenant ids are never trusted.\n\n".repeat(
    40
  );

const SPEC_PROPOSAL =
  "The console MUST expose user preferences under /v1/preferences.\n\n".repeat(30);

function fixtures(overrides = {}) {
  return {
    guardrails: [
      {
        id: "gr-1",
        title: "Never trust a client-supplied tenant id",
        description: "Derive the tenant from the principal.",
        category: "backend",
        severity: "critical",
        pattern: "tenant = body['tenantId']",
        fix: "tenant = principal.tenant_id",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ],
    specs: [
      {
        draftId: "spec-prefs",
        name: "User preferences endpoint",
        status: "ready",
        requirementCount: 3,
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ],
    docs: {
      items: [
        {
          id: "doc-auth",
          repo_full_name: "puglieseweb/product-systemdox",
          path: "docs/architecture/auth.md",
          title: "Auth Design",
          doc_type: "adr",
          size: 4096,
          synced_at: "2026-07-01T00:00:00Z",
        },
      ],
    },
    stack: [{ id: "s1", name: "Python", category: "language", version: "3.11" }],
    rules: [
      {
        id: "r1",
        text: "Use type hints on every handler.",
        category: "backend",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ],
    specBodies: {
      "spec-prefs": {
        draftId: "spec-prefs",
        name: "User preferences endpoint",
        status: "ready",
        proposalContent: SPEC_PROPOSAL,
        taskContent: "",
        requirements: [
          {
            reqId: "r1",
            name: "REQ-1 Persistence",
            content: "Preferences MUST be stored under PK=TENANT#{tenant_id}.",
          },
        ],
      },
    },
    docBodies: { "doc-auth": { content: DOC_BODY } },
    ...overrides,
  };
}

/**
 * Fake SystemDoxApiClient. Records every path requested and tracks how many
 * body fetches were in flight simultaneously (for the concurrency assertion).
 */
function fakeApi(f = fixtures(), opts = {}) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0 };

  const api = {
    async get(path) {
      state.calls.push(path);

      if (path === "/v1/guardrails") return f.guardrails;
      if (path === "/v1/specs") return f.specs;
      if (path === "/v1/docs") return f.docs;
      if (path === "/v1/ai/settings/stack") return f.stack;
      if (path === "/v1/standards/rules") return f.rules;
      if (path === "/v1/doc-repos") {
        // Absent by default — an older backend without the route. The
        // builder must fail OPEN and gate nothing.
        if (f.docRepos === undefined) throw new Error("no doc-repos route");
        return f.docRepos;
      }

      // Body endpoints — the ones this whole change exists to call.
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, opts.bodyDelayMs ?? 5));

        const specMatch = /^\/v1\/specs\/(.+)$/.exec(path);
        if (specMatch) {
          const id = decodeURIComponent(specMatch[1]);
          if (opts.failSpecs) throw new Error("spec fetch exploded");
          const spec = f.specBodies[id];
          if (!spec) throw new Error(`unknown spec ${id}`);
          return spec;
        }

        const docMatch = /^\/v1\/docs\/(.+)\/content$/.exec(path);
        if (docMatch) {
          const id = decodeURIComponent(docMatch[1]);
          if (opts.failDocs) throw new Error("doc fetch exploded");
          const doc = f.docBodies[id];
          if (!doc) throw new Error(`unknown doc ${id}`);
          return doc;
        }

        throw new Error(`unexpected path ${path}`);
      } finally {
        state.inFlight--;
      }
    },
  };

  return { api, state };
}

test("returns real document body text, not just a filename", async () => {
  const { api, state } = fakeApi();
  const { text, stats } = await buildContext(api, {
    taskDescription: "add a REST endpoint for user preferences",
    filePaths: ["backend/functions/prefs_api/app.py"],
  });

  assert.ok(
    state.calls.includes("/v1/docs/doc-auth/content"),
    "should have fetched the doc body"
  );
  assert.ok(
    text.includes("resolve_principal(event)"),
    "doc body text must appear in the output"
  );
  assert.ok(stats.itemsWithBody >= 1);
});

test("returns real spec body text (proposal + requirements)", async () => {
  const { api, state } = fakeApi();
  const { text } = await buildContext(api, {
    taskDescription: "user preferences endpoint persistence",
  });

  assert.ok(state.calls.includes("/v1/specs/spec-prefs"));
  assert.ok(
    text.includes("PK=TENANT#{tenant_id}"),
    "requirement text must appear in the output"
  );
});

test("emits doc_id and draft_id so the agent can follow up", async () => {
  const { api } = fakeApi();
  const { text } = await buildContext(api, {
    taskDescription: "user preferences endpoint",
  });

  assert.ok(text.includes("doc_id: doc-auth"), "doc id must be emitted");
  assert.ok(text.includes("draft_id: spec-prefs"), "spec id must be emitted");
});

test("respects the token budget by truncating bodies, not the list", async () => {
  // 12 fat docs — a naive implementation would either blow the budget or drop
  // every item but the first.
  const docs = { items: [] };
  const docBodies = {};
  for (let i = 0; i < 12; i++) {
    docs.items.push({
      id: `doc-${i}`,
      repo_full_name: "puglieseweb/product-systemdox",
      path: `docs/architecture/preferences-${i}.md`,
      title: `Preferences design ${i}`,
      doc_type: "adr",
      size: 40000,
      synced_at: "2026-07-01T00:00:00Z",
    });
    docBodies[`doc-${i}`] = { content: DOC_BODY.repeat(3) };
  }

  const budget = 2500;
  const { api } = fakeApi(fixtures({ docs, docBodies }));
  const { text, stats } = await buildContext(api, {
    taskDescription: "preferences design endpoint persistence",
    maxTokens: budget,
  });

  assert.ok(
    estimateTokens(text) <= budget,
    `output ${estimateTokens(text)} tokens exceeded budget ${budget}`
  );
  assert.ok(stats.itemsWithBody >= 2, "several bodies should still fit");
  assert.ok(
    text.includes("truncated to fit the token budget"),
    "fat bodies must be clipped, not dropped"
  );
  // The list is NOT truncated away: lower-ranked docs still appear as ID-bearing
  // bibliography entries.
  assert.ok(text.includes("## Also Indexed"));
});

test("a smaller budget yields a smaller response", async () => {
  const f = fixtures();
  const big = await buildContext(fakeApi(f).api, {
    taskDescription: "user preferences endpoint",
    maxTokens: 4000,
  });
  const small = await buildContext(fakeApi(f).api, {
    taskDescription: "user preferences endpoint",
    maxTokens: 900,
  });

  assert.ok(estimateTokens(small.text) <= 900);
  assert.ok(
    estimateTokens(small.text) < estimateTokens(big.text),
    "the tighter budget must produce less text"
  );
});

test("bodies are fetched concurrently", async () => {
  const docs = { items: [] };
  const docBodies = {};
  for (let i = 0; i < 4; i++) {
    docs.items.push({
      id: `doc-${i}`,
      repo_full_name: "puglieseweb/product-systemdox",
      path: `docs/architecture/preferences-${i}.md`,
      title: `Preferences design ${i}`,
      doc_type: "adr",
      size: 4096,
      synced_at: "2026-07-01T00:00:00Z",
    });
    docBodies[`doc-${i}`] = { content: DOC_BODY };
  }

  const { api, state } = fakeApi(fixtures({ docs, docBodies }), {
    bodyDelayMs: 20,
  });
  await buildContext(api, {
    taskDescription: "preferences design",
    maxTokens: 8000,
  });

  assert.ok(
    state.maxInFlight >= 4,
    `expected concurrent body fetches, saw max ${state.maxInFlight} in flight`
  );
});

test("a failed body fetch degrades to title + ID instead of dropping the item", async () => {
  const { api } = fakeApi(fixtures(), { failDocs: true });
  const { text, stats } = await buildContext(api, {
    taskDescription: "auth design tenant isolation for the user preferences endpoint",
  });

  assert.ok(text.includes("Auth Design"), "title must survive a failed fetch");
  assert.ok(text.includes("doc_id: doc-auth"), "ID must survive a failed fetch");
  assert.ok(text.includes("Body unavailable"));
  assert.equal(stats.bodyFailures, 1);
  // The spec body still came through — one failure does not poison the batch.
  assert.ok(text.includes("PK=TENANT#{tenant_id}"));
});

test("an in-band doc content error is treated as a failure, not as a body", async () => {
  const f = fixtures({
    docBodies: { "doc-auth": { content: "", error: "No GitHub installation found" } },
  });
  const { text, stats } = await buildContext(fakeApi(f).api, {
    taskDescription: "auth design for the user preferences endpoint",
  });

  assert.ok(text.includes("No GitHub installation found"));
  assert.equal(stats.bodyFailures, 1);
  assert.equal(stats.itemsWithBody, 1); // the spec
});

test("guardrails cannot eat the whole budget", async () => {
  // Ten critical guardrails would, unbudgeted, crowd out every fetched body —
  // the exact failure this tool shipped with.
  const guardrails = [];
  for (let i = 0; i < 10; i++) {
    guardrails.push({
      id: `gr-${i}`,
      title: `Preferences guardrail ${i}`,
      description: "Preferences endpoint persistence rule. ".repeat(40),
      category: "backend",
      severity: "critical",
      pattern: "bad()",
      fix: "good()",
      updatedAt: "2026-07-10T00:00:00Z",
    });
  }

  const { api } = fakeApi(fixtures({ guardrails }));
  const { text, stats } = await buildContext(api, {
    taskDescription: "preferences endpoint persistence",
    maxTokens: 3000,
  });

  assert.ok(stats.itemsWithBody >= 1, "at least one body must survive");
  assert.ok(text.includes("resolve_principal(event)") || text.includes("PK=TENANT#"));
  assert.ok(estimateTokens(text) <= 3000);
});

test("empty tenant yields an honest empty answer, not a crash", async () => {
  const f = fixtures({
    guardrails: [],
    specs: [],
    docs: { items: [] },
    stack: [],
    rules: [],
  });
  const { text } = await buildContext(fakeApi(f).api, {
    taskDescription: "anything",
  });

  assert.equal(text, "No relevant context found for this task.");
});

test("archived specs are excluded", async () => {
  const f = fixtures({
    specs: [
      {
        draftId: "spec-old",
        name: "Retired thing",
        status: "archived",
        requirementCount: 1,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const { text } = await buildContext(fakeApi(f).api, {
    taskDescription: "retired thing",
  });

  assert.ok(!text.includes("draft_id: spec-old"));
});

// ── Capability gating (guided-repo-setup Phase D) ───────────────────────────
// A workspace's 'disabled' capability is a deliberate opt-out: get_context
// must not advertise those concerns to agents.

test("a disabled fitness capability removes Checks from the context", async () => {
  const f = fixtures({
    docRepos: { capabilities: { fitness: { status: "disabled" } } },
  });
  const { text } = await buildContext(fakeApi(f).api, {
    taskDescription: "user preferences endpoint",
  });

  assert.ok(!text.includes("## Checks"), "Checks section must not render");
  assert.ok(
    !text.includes("Never trust a client-supplied tenant id"),
    "guardrail content must not leak in"
  );
  // The other concerns are untouched.
  assert.ok(text.includes("draft_id: spec-prefs"));
  assert.ok(text.includes("doc_id: doc-auth"));
});

test("disabling every spec concern drops the spec listing", async () => {
  const f = fixtures({
    docRepos: {
      capabilities: {
        requirements: { status: "disabled" },
        design: { status: "disabled" },
        specs: { status: "disabled" },
      },
    },
  });
  const { text } = await buildContext(fakeApi(f).api, {
    taskDescription: "user preferences endpoint persistence",
  });

  assert.ok(!text.includes("draft_id: spec-prefs"), "specs must not be advertised");
  assert.ok(text.includes("doc_id: doc-auth"), "docs stay ungated");
});

test("one enabled spec concern keeps the spec listing", async () => {
  const f = fixtures({
    docRepos: {
      capabilities: {
        requirements: { status: "enabled", repo: "acme/docs" },
        design: { status: "disabled" },
        specs: { status: "disabled" },
      },
    },
  });
  const { text } = await buildContext(fakeApi(f).api, {
    taskDescription: "user preferences endpoint persistence",
  });

  assert.ok(text.includes("draft_id: spec-prefs"));
});

test("an unreadable capabilities config gates nothing (fail-open)", async () => {
  // Default fixtures carry no docRepos — the fake API throws for the route,
  // simulating an older backend. Everything must still be advertised.
  const { text } = await buildContext(fakeApi().api, {
    taskDescription: "user preferences endpoint",
  });

  assert.ok(text.includes("## Checks"), "Checks must survive a failed config read");
  assert.ok(text.includes("draft_id: spec-prefs"));
});
