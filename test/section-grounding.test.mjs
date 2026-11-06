// Section-precise MCP grounding (#865). Offline: a fake API client that
// understands ?section= stands in for the SystemDox REST API. Build first
// (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../dist/lib/context-builder.js";
import { registerGetDocs } from "../dist/tools/get-docs.js";

const REPO = "puglieseweb/product-systemdox";

const AUTH_SECTIONS = {
  "auth-design": "# Auth Design\n\nEvery handler resolves the principal.",
  "rollback-strategy":
    "## Rollback Strategy\n\n" +
    "Revert the release and re-run the pipeline. ".repeat(80),
  monitoring: "## Monitoring\n\nWatch the dashboards.",
};

const AUTH_OUTLINE = [
  { heading: "Auth Design", level: 1, anchor: "auth-design", chunkId: "ph1#auth-design" },
  { heading: "Rollback Strategy", level: 2, anchor: "rollback-strategy", chunkId: "ph1#rollback-strategy" },
  { heading: "Monitoring", level: 2, anchor: "monitoring", chunkId: "ph1#monitoring" },
];

function fixtures(overrides = {}) {
  return {
    guardrails: [],
    specs: [],
    stack: [],
    rules: [],
    docs: {
      items: [
        {
          id: "doc-auth",
          repo_full_name: REPO,
          path: "docs/adr/0007.md",
          title: "Auth Design",
          doc_type: "adr",
          size: 4096,
          synced_at: "2026-07-01T00:00:00Z",
          outline: AUTH_OUTLINE,
        },
      ],
    },
    docSections: { "doc-auth": AUTH_SECTIONS },
    ...overrides,
  };
}

// Fake client that honours the section param, returning just that section.
function fakeApi(f = fixtures()) {
  const state = { calls: [] };
  const api = {
    async get(path, params) {
      state.calls.push({ path, params });
      if (path === "/v1/guardrails") return f.guardrails;
      if (path === "/v1/specs") return f.specs;
      if (path === "/v1/docs") return f.docs;
      if (path === "/v1/ai/settings/stack") return f.stack;
      if (path === "/v1/standards/rules") return f.rules;

      const m = /^\/v1\/docs\/(.+)\/content$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const sections = f.docSections[id];
        if (!sections) throw new Error(`unknown doc ${id}`);
        const anchor = params?.section;
        if (anchor) {
          const body = sections[anchor];
          if (body === undefined) {
            // Degrade to the whole doc, mirroring the backend.
            return {
              content: Object.values(sections).join("\n\n"),
              section: anchor,
              section_resolved: false,
            };
          }
          const heading = AUTH_OUTLINE.find((s) => s.anchor === anchor)?.heading;
          return { content: body, heading, chunk_id: `ph1#${anchor}`, section_resolved: true };
        }
        return { content: Object.values(sections).join("\n\n") };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  return { api, state };
}

test("get_context emits a section pointer: path#anchor, chunk_id, and a deep-link", async () => {
  const { api } = fakeApi();
  const { text } = await buildContext(api, {
    taskDescription: "how do we handle rollback of a bad release",
  });

  assert.ok(text.includes("docs/adr/0007.md#rollback-strategy"), "path#anchor pointer");
  assert.ok(text.includes("chunk_id: ph1#rollback-strategy"), "chunk_id pointer");
  assert.ok(
    text.includes(`https://github.com/${REPO}/blob/HEAD/docs/adr/0007.md#rollback-strategy`),
    "github deep-link"
  );
});

test("the fetched body is the task-relevant section, not the whole doc", async () => {
  const { api, state } = fakeApi();
  const { text } = await buildContext(api, {
    taskDescription: "rollback strategy for a failed deploy",
  });

  // Keyword-selected the rollback section...
  const call = state.calls.find((c) => c.path === "/v1/docs/doc-auth/content");
  assert.equal(call.params?.section, "rollback-strategy");
  assert.ok(text.includes("Revert the release"), "section body present");
  // ...and did not pull the unrelated Monitoring section into the body.
  assert.ok(!text.includes("Watch the dashboards"));
});

test("a truncated section's retry hint names the exact section", async () => {
  const { api } = fakeApi();
  // A tight budget forces the large rollback section to be clipped, so the
  // retry hint (which carries section=) is emitted.
  const { text } = await buildContext(api, {
    taskDescription: "rollback the release",
    maxTokens: 500,
  });
  assert.ok(text.includes('get_docs(doc_id="doc-auth", section="rollback-strategy")'));
});

test("an outline-less doc degrades to whole-doc behaviour (no pointer)", async () => {
  const f = fixtures();
  delete f.docs.items[0].outline;
  const { api, state } = fakeApi(f);
  const { text } = await buildContext(api, { taskDescription: "auth design" });

  // No section param when there is no outline.
  const call = state.calls.find((c) => c.path === "/v1/docs/doc-auth/content");
  assert.equal(call.params, undefined);
  assert.ok(!text.includes("chunk_id:"), "no section pointer without an outline");
  assert.ok(text.includes("doc_id: doc-auth"), "still cites the doc");
});

test("tail docs carry a pointer-only line (no body)", async () => {
  // 12 docs so most fall to the 'Also Indexed' tail.
  const items = [];
  const docSections = {};
  for (let i = 0; i < 12; i++) {
    items.push({
      id: `doc-${i}`,
      repo_full_name: REPO,
      path: `docs/adr/00${i}.md`,
      title: `ADR ${i}`,
      doc_type: "adr",
      size: 2048,
      synced_at: "2026-07-01T00:00:00Z",
      outline: [
        { heading: `Decision ${i}`, level: 2, anchor: `decision-${i}`, chunkId: `p${i}#decision-${i}` },
      ],
    });
    docSections[`doc-${i}`] = { [`decision-${i}`]: `## Decision ${i}\n\nbody ${i}` };
  }
  const { api } = fakeApi(fixtures({ docs: { items }, docSections }));
  const { text } = await buildContext(api, {
    taskDescription: "decision records",
    maxTokens: 1500,
  });

  assert.ok(text.includes("## Also Indexed"), "there is a tail");
  // A tail entry cites a section pointer without a body block.
  assert.ok(/decision-\d+/.test(text), "tail carries section anchors");
  assert.ok(text.includes("chunk_id:"), "tail carries chunk_ids");
});

// ── get_docs tool: chunk_id / section retrieval ──────────────────────────

function captureTool() {
  let handler;
  const server = {
    registerTool(_name, _schema, fn) {
      handler = fn;
    },
  };
  return { server, run: (...a) => handler(...a) };
}

test("get_docs forwards section and prefixes the heading", async () => {
  const { api, state } = fakeApi();
  const { server, run } = captureTool();
  registerGetDocs(server, api);

  const res = await run({ doc_id: "doc-auth", section: "monitoring" });
  const call = state.calls.find((c) => c.path === "/v1/docs/doc-auth/content");
  assert.equal(call.params.section, "monitoring");
  assert.ok(res.content[0].text.startsWith("## Monitoring"));
  assert.ok(res.content[0].text.includes("Watch the dashboards"));
});

test("get_docs extracts the anchor from a chunk_id", async () => {
  const { api, state } = fakeApi();
  const { server, run } = captureTool();
  registerGetDocs(server, api);

  await run({ doc_id: "doc-auth", chunk_id: "ph1#rollback-strategy" });
  const call = state.calls.find((c) => c.path === "/v1/docs/doc-auth/content");
  assert.equal(call.params.section, "rollback-strategy");
});

test("get_docs flags an unresolved section instead of implying it", async () => {
  const { api } = fakeApi();
  const { server, run } = captureTool();
  registerGetDocs(server, api);

  const res = await run({ doc_id: "doc-auth", section: "ghost" });
  assert.ok(res.content[0].text.includes('Section "ghost" not found'));
});

test("get_docs listing surfaces section anchors", async () => {
  const { api } = fakeApi();
  const { server, run } = captureTool();
  registerGetDocs(server, api);

  const res = await run({});
  const text = res.content[0].text;
  assert.ok(text.includes("sections: auth-design, rollback-strategy, monitoring"));
  assert.ok(text.includes("doc_id: `doc-auth`"));
});
