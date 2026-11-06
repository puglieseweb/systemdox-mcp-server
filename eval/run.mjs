// get_context eval harness. Runs every task in eval/tasks.mjs through the real
// buildContext() and reports what came back — how much of the budget was spent,
// how many bodies were actually retrieved, and which items were returned.
//
//   node eval/run.mjs                      offline, against eval/fixtures/tenant.json
//   node eval/run.mjs --live               against a real tenant (SYSTEMDOX_API_KEY)
//   node eval/run.mjs --budget 2000        change the token budget
//   node eval/run.mjs --write              dump each full response to eval/out/
//   node eval/run.mjs --strict             exit 1 if an offline expectation misses
//
// Build first: `npm run build` (or use `npm run eval`, which builds).
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildContext, estimateTokens } from "../dist/lib/context-builder.js";
import { SystemDoxApiClient } from "../dist/lib/api-client.js";
import { tasks } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const live = flag("live");
const strict = flag("strict");
const budget = parseInt(value("budget", "4000"), 10);

/** Stands in for the API's search: what holds the task's words, most first. */
function search(docs, query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const hits = (d) =>
    words.filter((w) => `${d.title} ${d.path}`.toLowerCase().includes(w)).length;
  const items = docs.items
    .filter((d) => hits(d) > 0)
    .sort((a, b) => hits(b) - hits(a));
  return { ...docs, items, total: items.length };
}

/** Offline client: serves the fixture tenant, same paths as the REST API. */
function fixtureClient(f) {
  return {
    async get(path, params) {
      if (path === "/v1/guardrails") return f.guardrails;
      if (path === "/v1/specs") return f.specs;
      if (path === "/v1/docs") return params?.q ? search(f.docs, params.q) : f.docs;
      if (path === "/v1/ai/settings/stack") return f.stack;
      if (path === "/v1/standards/rules") return f.rules;

      const spec = /^\/v1\/specs\/(.+)$/.exec(path);
      if (spec) {
        const body = f.specBodies[decodeURIComponent(spec[1])];
        if (!body) throw new Error("404 spec not found");
        return body;
      }

      const doc = /^\/v1\/docs\/(.+)\/content$/.exec(path);
      if (doc) {
        const body = f.docBodies[decodeURIComponent(doc[1])];
        if (!body) throw new Error("404 doc not found");
        return body;
      }

      throw new Error(`unmapped path ${path}`);
    },
  };
}

async function makeClient() {
  if (!live) {
    const f = JSON.parse(
      await readFile(join(here, "fixtures", "tenant.json"), "utf-8")
    );
    return fixtureClient(f);
  }

  const apiKey = process.env.SYSTEMDOX_API_KEY;
  if (!apiKey) {
    console.error(
      "--live needs SYSTEMDOX_API_KEY (generate one on your SystemDox settings page)."
    );
    process.exit(2);
  }

  return new SystemDoxApiClient({
    apiKey,
    apiUrl:
      process.env.SYSTEMDOX_API_URL ?? "https://api.puglieseweb.com/systemdox",
    // No caching: each task must pay the real retrieval cost.
    cacheTtlMs: 0,
    defaultOrg: undefined,
  });
}

/** The items whose full text was returned, in the order get_context ranked them. */
function returnedItems(text) {
  const items = [];
  const re = /^### (.+)\n`(draft_id|doc_id): ([^`]+)`/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    items.push({ title: m[1], kind: m[2], id: m[3] });
  }
  return items;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

const client = await makeClient();
const rows = [];
let misses = 0;

for (const t of tasks) {
  const started = Date.now();
  const { text, stats } = await buildContext(client, {
    taskDescription: t.task,
    filePaths: t.files,
    maxTokens: budget,
  });
  const ms = Date.now() - started;

  const items = returnedItems(text);
  const expect = live ? [] : (t.expect ?? []);
  const hits = expect.filter((e) => text.includes(e));
  const missed = expect.filter((e) => !text.includes(e));
  if (missed.length > 0) misses++;

  rows.push({ t, stats, items, text, ms, hits, missed, expect });

  if (flag("write")) {
    await mkdir(join(here, "out"), { recursive: true });
    await writeFile(join(here, "out", `${t.id}.md`), text);
  }
}

console.log(
  `\nget_context eval — ${live ? "LIVE tenant" : "offline fixture tenant"}, budget ${budget} tokens\n`
);
console.log(
  pad("task", 22) +
    pad("tokens", 12) +
    pad("bodies", 8) +
    pad("listed", 8) +
    pad("fail", 6) +
    pad("expect", 8) +
    "top item returned"
);
console.log("-".repeat(110));

for (const r of rows) {
  const used = estimateTokens(r.text);
  const over = used > budget ? " !!" : "";
  const expectCell = r.expect.length
    ? `${r.hits.length}/${r.expect.length}${r.missed.length ? " X" : ""}`
    : "-";

  console.log(
    pad(r.t.id, 22) +
      pad(`${used}/${budget}${over}`, 12) +
      pad(r.stats.itemsWithBody, 8) +
      pad(r.stats.itemsListed, 8) +
      pad(r.stats.bodyFailures, 6) +
      pad(expectCell, 8) +
      (r.items[0] ? `${r.items[0].title} (${r.items[0].id})` : "—")
  );

  for (const m of r.missed) {
    console.log(`${" ".repeat(22)}MISS: expected the context to mention "${m}"`);
  }
}

const totals = rows.reduce(
  (a, r) => ({
    bodies: a.bodies + r.stats.itemsWithBody,
    failures: a.failures + r.stats.bodyFailures,
    tokens: a.tokens + estimateTokens(r.text),
    overBudget: a.overBudget + (estimateTokens(r.text) > budget ? 1 : 0),
  }),
  { bodies: 0, failures: 0, tokens: 0, overBudget: 0 }
);

console.log("-".repeat(110));
console.log(
  `${rows.length} tasks · ${totals.bodies} bodies retrieved · ${totals.failures} body fetch failures · ` +
    `avg ${Math.round(totals.tokens / rows.length)} tokens (${Math.round(
      (totals.tokens / rows.length / budget) * 100
    )}% of budget) · ${totals.overBudget} over budget`
);

if (!live) {
  console.log(
    `${tasks.length - misses}/${tasks.length} tasks retrieved everything a human said they needed.`
  );
}
if (flag("write")) console.log(`Full responses written to eval/out/.`);
console.log();

if (totals.overBudget > 0) {
  console.error("FAIL: at least one response exceeded the token budget.");
  process.exit(1);
}
if (strict && misses > 0) {
  console.error(`FAIL: ${misses} task(s) missed an expectation.`);
  process.exit(1);
}
