// Unit tests for the get_plan_board tool (src/tools/get-plan-board.ts).
// Offline: a fake MCP server captures the registered handler and a fake API
// client stands in for the SystemDox REST API. Build first (`npm run build`),
// then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bucketOf,
  registerGetPlanBoard,
} from "../dist/tools/get-plan-board.js";

/** Capture the handler registerGetPlanBoard installs. */
function handlerFor(routes) {
  let captured;
  const server = {
    registerTool: (name, meta, fn) => {
      assert.equal(name, "get_plan_board");
      captured = { meta, fn };
    },
  };
  const apiClient = {
    get: async (path) => {
      if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  registerGetPlanBoard(server, apiClient);
  return captured;
}

async function callTool(routes, args = {}) {
  const { fn } = handlerFor(routes);
  const result = await fn(args);
  return result.content[0].text;
}

const PORTAL = { "/v1/docs/portal-access": { host: "acme.kb.systemdox.com" } };

function board(overrides = {}) {
  return {
    id: "PVT_1",
    number: 1,
    title: "SystemDox Product",
    closed: false,
    description: "Platform backlog",
    url: "https://github.com/orgs/acme/projects/1",
    itemCount: 3,
    statusCounts: { todo: 1, inProgress: 1, done: 1 },
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: "PVTI_1",
    number: 100,
    title: "Add a thing",
    state: "OPEN",
    url: "https://github.com/acme/app/issues/100",
    repo: "acme/app",
    labels: [],
    assignees: [],
    fields: {},
    ...overrides,
  };
}

// ── status bucketing ──────────────────────────────────────────────────────

test("bucketOf matches the backend's loose column matching", () => {
  assert.equal(bucketOf({ state: "OPEN", fields: { Status: "Todo" } }), "todo");
  assert.equal(bucketOf({ state: "OPEN", fields: { Status: "Backlog" } }), "todo");
  assert.equal(
    bucketOf({ state: "OPEN", fields: { Status: "In review" } }),
    "inProgress"
  );
  assert.equal(bucketOf({ state: "OPEN", fields: { Status: "Doing" } }), "inProgress");
  assert.equal(bucketOf({ state: "OPEN", fields: { Status: "Shipped" } }), "done");
  assert.equal(bucketOf({ state: "OPEN", fields: { Status: "DONE" } }), "done");
});

test("bucketOf falls back to issue state when the board has no Status column", () => {
  // A closed issue with no Status must never be offered as available work —
  // this is the deliberate divergence from the backend's count helper.
  assert.equal(bucketOf({ state: "CLOSED", fields: {} }), "done");
  assert.equal(bucketOf({ state: "OPEN", fields: {} }), "todo");
});

test("an explicit Status wins over the issue state", () => {
  assert.equal(
    bucketOf({ state: "CLOSED", fields: { Status: "In Progress" } }),
    "inProgress"
  );
});

// ── board listing (no project_number) ─────────────────────────────────────

test("lists open boards with counts and URLs", async () => {
  const text = await callTool({
    "/v1/planning/projects": [board()],
  });
  assert.equal(
    text,
    "1 open project board(s):\n\n" +
      "- **SystemDox Product** — board #1 · 3 item(s) (todo 1 · in progress 1 · done 1)\n" +
      "  Platform backlog\n" +
      "  https://github.com/orgs/acme/projects/1\n\n" +
      "Call get_plan_board with project_number to list a board's issues."
  );
});

test("closed boards are excluded but their count is disclosed", async () => {
  const text = await callTool({
    "/v1/planning/projects": [board(), board({ number: 2, closed: true })],
  });
  assert.match(text, /^1 open project board\(s\):/);
  assert.match(text, /_1 closed board\(s\) not listed\._/);
});

test("empty board list links to the plan surface", async () => {
  const text = await callTool({ "/v1/planning/projects": [], ...PORTAL });
  assert.equal(
    text,
    "No project boards found. Connect a GitHub organisation and create a board " +
      "at https://acme.systemdox.com/plan"
  );
});

test("empty board list falls back to the in-app path without a workspace base", async () => {
  const text = await callTool({
    "/v1/planning/projects": [],
    "/v1/docs/portal-access": new Error("403"),
  });
  assert.equal(
    text,
    "No project boards found. Connect a GitHub organisation and create a board " +
      "at /plan in your SystemDox workspace"
  );
});

test("all-closed boards report that, not emptiness", async () => {
  const text = await callTool({
    "/v1/planning/projects": [board({ closed: true })],
    ...PORTAL,
  });
  assert.equal(
    text,
    "No open project boards (1 closed). Reopen one, or create a board at " +
      "https://acme.systemdox.com/plan"
  );
});

// ── board items (project_number given) ────────────────────────────────────

test("groups items by status, in-progress first", async () => {
  const text = await callTool(
    {
      "/v1/planning/projects/7/items": {
        projectTitle: "Roadmap",
        items: [
          item({ number: 1, title: "Done thing", state: "CLOSED" }),
          item({
            number: 2,
            title: "Live thing",
            fields: { Status: "In Progress", Epic: "1-Auth" },
            labels: ["backend"],
            assignees: ["ep"],
          }),
          item({ number: 3, title: "Next thing" }),
        ],
      },
    },
    { project_number: 7 }
  );

  assert.equal(
    text,
    "**Roadmap** — board #7 — 3 item(s)\n\n" +
      "### In Progress (1)\n" +
      "- #2 Live thing — acme/app\n" +
      "  labels: backend · assignees: ep · epic: 1-Auth\n" +
      "  https://github.com/acme/app/issues/100\n\n" +
      "### Todo (1)\n" +
      "- #3 Next thing — acme/app\n" +
      "  https://github.com/acme/app/issues/100\n\n" +
      "### Done (1)\n" +
      "- #1 Done thing — acme/app\n" +
      "  https://github.com/acme/app/issues/100"
  );
});

test("status filter narrows to one group", async () => {
  const text = await callTool(
    {
      "/v1/planning/projects/7/items": {
        projectTitle: "Roadmap",
        items: [
          item({ number: 1, state: "CLOSED" }),
          item({ number: 2, title: "Pick me" }),
        ],
      },
    },
    { project_number: 7, status: "todo" }
  );
  assert.match(text, /### Todo \(1\)/);
  assert.doesNotMatch(text, /### Done/);
});

test("a filter matching nothing says so rather than returning an empty board", async () => {
  const text = await callTool(
    {
      "/v1/planning/projects/7/items": {
        projectTitle: "Roadmap",
        items: [item({ number: 1, state: "CLOSED" })],
      },
    },
    { project_number: 7, status: "in_progress" }
  );
  assert.equal(
    text,
    '**Roadmap** — board #7: no items with status "in_progress" ' +
      "(of 1 item(s) on the board)."
  );
});

test("truncation is disclosed and heading counts stay true", async () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    item({ number: i + 1, title: `Task ${i + 1}` })
  );
  const text = await callTool(
    { "/v1/planning/projects/7/items": { projectTitle: "Roadmap", items } },
    { project_number: 7, limit: 2 }
  );
  // The heading reports all 5; only 2 are rendered, and the gap is named.
  assert.match(text, /### Todo \(5\)/);
  assert.match(text, /_…3 more not listed\._/);
  assert.match(
    text,
    /_Listing 2 of 5 matching item\(s\) — raise limit \(max 200\) or filter by status to see the rest\._/
  );
  assert.doesNotMatch(text, /Task 3/);
});

test("a full API page warns that the board may have more items", async () => {
  const items = Array.from({ length: 100 }, (_, i) =>
    item({ number: i + 1, state: "CLOSED" })
  );
  const text = await callTool(
    { "/v1/planning/projects/7/items": { projectTitle: "Roadmap", items } },
    { project_number: 7, limit: 200 }
  );
  assert.match(
    text,
    /_The API reads the board's first 100 items; a larger board may have more\._/
  );
});

test("an empty board links to the plan surface", async () => {
  const text = await callTool(
    { "/v1/planning/projects/7/items": { items: [] }, ...PORTAL },
    { project_number: 7 }
  );
  assert.equal(
    text,
    "Board #7 has no issues, or it is not visible to this workspace's GitHub " +
      "connection. Check the board at https://acme.systemdox.com/plan"
  );
});

// ── description honesty (the reason this tool exists) ─────────────────────

test("the description states it is read-only and explicitly disclaims writes", () => {
  // #958 corrected marketing copy that overstated what MCP could do. The tool
  // description must not repeat that: it has to name the read-only boundary
  // rather than leave an agent to infer it.
  const { meta } = handlerFor({});
  assert.match(meta.description, /Read-only/);
  assert.match(meta.description, /cannot create, move, or close board items/);
});
