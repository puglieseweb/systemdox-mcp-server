// Offline smoke test for the hosted MCP handler (packages/mcp-server/src/http.ts).
// Exercises the full request path — auth, tenant scoping, MCP protocol handshake,
// tool catalogue — without any network calls (only tool *invocation* would hit the
// REST API, which these cases avoid). Build first (`pnpm build`), then `node smoke-http.mjs`.
import { handler } from "./dist/http.js";

function event(overrides = {}) {
  return {
    httpMethod: "POST",
    path: "/mcp",
    headers: {
      Host: "acme.mcp.systemdox.com",
      Authorization: "Bearer pweb_test_key_smoke",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0" },
      },
    }),
    isBase64Encoded: false,
    requestContext: { authorizer: { tenant_slug: "acme" } },
    ...overrides,
  };
}

let failed = false;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " — " + detail}`);
  if (!cond) failed = true;
}

// 1. initialize succeeds for matching tenant
const r1 = await handler(event());
check("initialize 200", r1.statusCode === 200, `got ${r1.statusCode}: ${r1.body?.slice(0, 200)}`);
check("initialize serverInfo", r1.body.includes("systemdox-mcp-server"), r1.body?.slice(0, 200));

// 2. tenant mismatch -> 403
const r2 = await handler(event({ requestContext: { authorizer: { tenant_slug: "globex" } } }));
check("tenant mismatch 403", r2.statusCode === 403, `got ${r2.statusCode}`);

// 3. tools/list returns the tool catalogue (no API calls involved)
const r3 = await handler(
  event({
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  })
);
check("tools/list 200", r3.statusCode === 200, `got ${r3.statusCode}: ${r3.body?.slice(0, 200)}`);
const tools = JSON.parse(r3.body)?.result?.tools ?? [];
const toolNames = tools.map((t) => t.name);
check("26 tools registered", tools.length === 26, `got ${tools.length}: ${toolNames.join(", ")}`);
// ADR-218: a build session reads its change's brief before it writes code.
check("get_change registered", toolNames.includes("get_change"), "missing get_change");
check("get_team_setup registered", toolNames.includes("get_team_setup"), "missing get_team_setup");
check("get_document_links registered", toolNames.includes("get_document_links"), "missing get_document_links");
// ADR-216 and ADR-217: the hosted server offers the skill and team-setup
// tools, but never a folder to read.
for (const name of ["publish_skill", "list_skills", "install_skill", "publish_setup_part", "resolve_person"]) {
  check(`${name} registered`, toolNames.includes(name), `missing ${name}`);
}
// sync_memory needs the member's disk: it is on the local server only.
check("sync_memory not hosted", !toolNames.includes("sync_memory"), "sync_memory is in the hosted catalogue");
for (const name of ["publish_skill", "publish_setup_part"]) {
  const tool = tools.find((t) => t.name === name);
  check(`hosted ${name} takes no directory`, tool && !("directory" in (tool.inputSchema?.properties ?? {})),
    JSON.stringify(tool?.inputSchema?.properties ?? {}));
}
check("get_guardrails alias frozen", toolNames.includes("get_guardrails"), `missing get_guardrails`);
check("create_guardrail alias frozen", toolNames.includes("create_guardrail"), `missing create_guardrail`);
check("get_checks alias added", toolNames.includes("get_checks"), `missing get_checks`);
check("create_check alias added", toolNames.includes("create_check"), `missing create_check`);

// 4. GET -> 405
const r4 = await handler(event({ httpMethod: "GET", body: null }));
check("GET 405", r4.statusCode === 405, `got ${r4.statusCode}`);

// 5. missing key -> 401
const r5 = await handler(
  event({
    headers: { Host: "acme.mcp.systemdox.com", Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
  })
);
check("missing key 401", r5.statusCode === 401, `got ${r5.statusCode}`);

// 6. JSON-only client (Accept: application/json, no text/event-stream) still 200.
//    The transport 406s unless BOTH media types are accepted; the handler must
//    normalize the Accept header for stateless JSON mode. Regression guard.
const r6 = await handler(event({ headers: { ...event().headers, Accept: "application/json" } }));
check("json-only Accept 200 (406 regression)", r6.statusCode === 200, `got ${r6.statusCode}: ${r6.body?.slice(0, 200)}`);

// 7. Client omitting Content-Type still 200 (transport 415s without it).
const r7 = await handler(
  event({
    headers: { Host: "acme.mcp.systemdox.com", Authorization: "Bearer pweb_test_key_smoke", Accept: "application/json, text/event-stream" },
  })
);
check("missing Content-Type 200 (415 regression)", r7.statusCode === 200, `got ${r7.statusCode}: ${r7.body?.slice(0, 200)}`);

// 8. Response carries only allow-listed headers (no hop-by-hop leakage)
const rk = Object.keys(r1.headers).map((k) => k.toLowerCase());
check("response header allowlist", rk.every((k) => k === "content-type" || k === "mcp-session-id"), `headers: ${rk.join(",")}`);

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
