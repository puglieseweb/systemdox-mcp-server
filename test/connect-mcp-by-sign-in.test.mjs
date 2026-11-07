// Binds test/features/connect-mcp-by-sign-in.feature (ADR-229, ids MCS-M-nn).
// The behaviour part of the brief (ADR-201 Amendment 2): every scenario is
// @proposed. node:test has no expected failure, so the state tag is held to the
// binding instead: a @proposed scenario must have no test here, and a @built one
// must have one. The pull request that builds a scenario adds `scenario(id, fn)`
// below and flips its tag to @built in the same change, or this file fails.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler as createConnectHandler } from "../dist/connect.js";
import { handler as mcpHandler } from "../dist/http.js";
import { SystemDoxApiClient } from "../dist/lib/api-client.js";
import { createHandler as createOAuthHandler } from "../dist/oauth.js";
import { CLIENT_SIGNING_SECRET, TOKEN_DERIVATION_SECRET, fakeAccount } from "./fixtures/fake-aws.mjs";

const FEATURE = join(dirname(fileURLToPath(import.meta.url)), "features", "connect-mcp-by-sign-in.feature");

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
    const match = line.match(/^Scenario: (MCS-M-\d+) (.+)$/);
    if (match) found.push({ id: match[1], title: match[2], tags });
    if (line) tags = [];
  }
  return found;
}

const SCENARIOS = readScenarios(await readFile(FEATURE, "utf8"));
const TITLES = new Map(SCENARIOS.map((s) => [s.id, s.title]));
const bound = new Set();

// The build's stories call this for each scenario they flip to @built.
function scenario(id, fn) {
  assert.ok(TITLES.has(id), `${id} is not a scenario in the feature file`);
  bound.add(id);
  test(`${id} ${TITLES.get(id)}`, fn);
}

// ── A world of real handlers, on a double of AWS (fixtures/fake-aws.mjs) ──────

process.env.SYSTEM_TABLE = "systemdox-test-system";
process.env.MCP_CLIENT_SIGNING_KEY_SECRET_ARN = CLIENT_SIGNING_SECRET;
process.env.MCP_TOKEN_DERIVATION_KEY_SECRET_ARN = TOKEN_DERIVATION_SECRET;
process.env.MCP_CONNECTION_KEY_ID = "arn:aws:kms:eu-west-2:000000000000:key/test";
process.env.AUTH_API_URL = "https://api.test/auth/v1";
process.env.ALLOWED_ORIGINS = "https://app.systemdox.com,https://*.systemdox.com";
process.env.SYSTEMDOX_API_URL = "https://api.test/systemdox";

const WORKSPACE = "acme";
const HOST = `${WORKSPACE}.mcp.systemdox.com`;
const ISSUER = `https://${HOST}`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
// A verifier and its S256 challenge (RFC 7636, appendix B).
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function world() {
  const account = fakeAccount();
  return {
    account,
    // Each function holds only its own grants, as the template gives them.
    oauth: createOAuthHandler(() => account.deps(["Encrypt"], [CLIENT_SIGNING_SECRET, TOKEN_DERIVATION_SECRET])),
    connect: createConnectHandler(() => account.deps(["Decrypt"], [TOKEN_DERIVATION_SECRET])),
  };
}

function event(method, resource, { host = HOST, body = null, query = null, headers = {}, authorizer, pathParameters } = {}) {
  return {
    httpMethod: method,
    path: resource,
    resource,
    headers: { Host: host, ...headers },
    queryStringParameters: query,
    pathParameters: pathParameters ?? null,
    body,
    isBase64Encoded: false,
    requestContext: { domainName: host, ...(authorizer ? { authorizer } : {}) },
  };
}

const register = (w, doc, host) =>
  w.oauth(event("POST", "/oauth/register", { host, body: JSON.stringify(doc) }));

async function registeredClient(w, redirect = CLAUDE_CALLBACK, name = "Claude") {
  const res = await register(w, { client_name: name, redirect_uris: [redirect] });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).client_id;
}

const authorizeQuery = (clientId, redirect = CLAUDE_CALLBACK, extra = {}) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "xyz",
  ...extra,
});

const authorize = (w, query, host) => w.oauth(event("GET", "/oauth/authorize", { host, query }));

const requestRow = (account) => [...account.ddb.rows.values()].find((row) => row.PK.startsWith("MCPREQ#"));

/** Run `fn` with every outbound fetch answered by `answer`, and the calls listed. */
async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// ── MCS-1 Claude can find the way in ──────────────────────────────────────────

scenario("MCS-M-02", async () => {
  const w = world();
  const resource = await w.oauth(event("GET", "/.well-known/oauth-protected-resource/connect"));
  assert.equal(resource.statusCode, 200);
  const metadata = JSON.parse(resource.body);
  assert.equal(metadata.resource, `${ISSUER}/connect`);
  assert.deepEqual(metadata.authorization_servers, [ISSUER]);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
  assert.deepEqual(metadata.scopes_supported, ["systemdox.read", "systemdox.write"]);
  // The same at the address clients try next.
  const root = await w.oauth(event("GET", "/.well-known/oauth-protected-resource"));
  assert.deepEqual(JSON.parse(root.body), metadata);

  const server = JSON.parse((await w.oauth(event("GET", "/.well-known/oauth-authorization-server"))).body);
  assert.equal(server.issuer, ISSUER);
  assert.equal(server.authorization_endpoint, `${ISSUER}/oauth/authorize`);
  assert.equal(server.token_endpoint, `${ISSUER}/oauth/token`);
  assert.equal(server.registration_endpoint, `${ISSUER}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
});

scenario("MCS-M-03", async () => {
  const w = world();
  const doc = { client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" };
  const first = await register(w, doc);
  const second = await register(w, doc);
  assert.equal(first.statusCode, 201);
  const client = JSON.parse(first.body);
  assert.match(client.client_id, /^sdxc_/);
  assert.equal(client.client_id, JSON.parse(second.body).client_id);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(w.account.ddb.writes, 0, "registering writes nothing");
  // Loopback, any port: Claude Code's return address.
  assert.equal((await register(w, { redirect_uris: ["http://localhost:53012/callback"] })).statusCode, 201);
  assert.equal((await register(w, { redirect_uris: ["http://127.0.0.1:9/callback"] })).statusCode, 201);
});

scenario("MCS-M-04", async () => {
  const w = world();
  for (const redirect of [
    "https://evil.example/callback",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/more",
    "http://localhost:1/elsewhere",
    "http://[::1]:1/callback",
    "http://user:pw@localhost:1/callback",
    "http://localhost:1/callback?next=https://evil.example",
  ]) {
    const res = await register(w, { client_name: "x", redirect_uris: [CLAUDE_CALLBACK, redirect] });
    assert.equal(res.statusCode, 400, redirect);
    assert.equal(JSON.parse(res.body).error, "invalid_redirect_uri", redirect);
  }
  const confidential = await register(w, {
    redirect_uris: [CLAUDE_CALLBACK],
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.equal(JSON.parse(confidential.body).error, "invalid_client_metadata");
});

scenario("MCS-M-05", async () => {
  const w = world();
  const clientId = await registeredClient(w);
  const [payload, signature] = clientId.slice("sdxc_".length).split(".");
  const altered = JSON.parse(Buffer.from(payload, "base64url").toString());
  altered.r = ["https://evil.example/callback"];
  const forged = `sdxc_${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;

  for (const query of [
    authorizeQuery(forged, "https://evil.example/callback"),
    // A true id, and a redirect it never registered.
    authorizeQuery(clientId, "https://evil.example/callback"),
    // A true id, and a redirect the rule allows but this client never asked for.
    authorizeQuery(clientId, "http://localhost:1/callback"),
  ]) {
    const res = await authorize(w, query);
    assert.equal(res.statusCode, 400);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assert.match(res.body, /cannot be trusted/);
    assert.equal(res.headers.Location, undefined, "the browser is not sent anywhere");
    assert.doesNotMatch(res.body, /evil\.example/);
  }
  assert.equal(w.account.ddb.writes, 0);
});

scenario("MCS-M-06", async () => {
  const w = world();
  const clientId = await registeredClient(w);
  const res = await authorize(w, authorizeQuery(clientId));
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.Location);
  assert.equal(location.origin + location.pathname, "https://app.systemdox.com/approve-connection");
  assert.equal(location.searchParams.get("workspace"), WORKSPACE);
  const requestId = location.searchParams.get("request");
  assert.match(requestId, /^cnr_[0-9a-z]{26}$/);

  const row = requestRow(w.account);
  assert.equal(row.PK, `MCPREQ#${requestId}`);
  assert.equal(row.expiresAt, w.account.now + 600_000, "kept for ten minutes");
  assert.equal(row.ttl, Math.ceil((w.account.now + 600_000) / 1000));
  assert.equal(row.label, WORKSPACE);
  assert.equal(row.challenge, CHALLENGE);
  assert.equal(row.returnHost, "claude.ai");
  assert.equal(row.loopback, false);
  assert.equal(row.clientNameVerified, false);
  assert.equal("ownerId" in row, false, "no person until approval");

  // Claude Code's port changes between registering and signing in.
  const loopbackClient = await registeredClient(w, "http://localhost:1111/callback", "Claude Code");
  const loopback = await authorize(w, authorizeQuery(loopbackClient, "http://localhost:2222/callback"));
  assert.equal(loopback.statusCode, 302);
  assert.match(loopback.headers.Location, /approve-connection/);

  // A checked client that asks wrongly is told so at its own address, with `iss`.
  const noPkce = await authorize(w, authorizeQuery(clientId, CLAUDE_CALLBACK, { code_challenge_method: "plain" }));
  const back = new URL(noPkce.headers.Location);
  assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get("error"), "invalid_request");
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), ISSUER);
  const otherResource = await authorize(
    w,
    authorizeQuery(clientId, CLAUDE_CALLBACK, { resource: "https://globex.mcp.systemdox.com/connect" })
  );
  assert.equal(new URL(otherResource.headers.Location).searchParams.get("error"), "invalid_target");
});

test("a key is read from its secret once per warm container, and a missing one fails closed", async () => {
  const w = world();
  const secrets = { reads: 0 };
  const account = w.account;
  const deps = account.deps(["Encrypt"], [CLIENT_SIGNING_SECRET, TOKEN_DERIVATION_SECRET]);
  const send = deps.secrets.send.bind(deps.secrets);
  deps.secrets.send = (command) => {
    secrets.reads += 1;
    return send(command);
  };
  const oauth = createOAuthHandler(() => deps);
  const doc = JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] });
  await oauth(event("POST", "/oauth/register", { body: doc }));
  await oauth(event("POST", "/oauth/register", { body: doc }));
  assert.equal(secrets.reads, 1);

  delete account.secrets[CLIENT_SIGNING_SECRET];
  const gone = createOAuthHandler(() => account.deps(["Encrypt"], [CLIENT_SIGNING_SECRET]));
  const res = await gone(event("POST", "/oauth/register", { body: doc }));
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, "server_error");
  assert.equal(res.body.includes("secret"), false, "the answer says nothing about where keys are");
});

test("a function with no grant on a secret cannot read it", async () => {
  const w = world();
  const ungranted = createOAuthHandler(() => w.account.deps(["Encrypt"], [TOKEN_DERIVATION_SECRET]));
  const res = await ungranted(event("POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) }));
  assert.equal(res.statusCode, 500);
});

test("a client that names a document is read from claude.ai only, and its own id must match", async () => {
  const w = world();
  const url = "https://claude.ai/oauth/claude-code-client-metadata";
  const document = {
    client_id: url,
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  };
  await withFetch(
    () => new Response(JSON.stringify(document), { status: 200 }),
    async (calls) => {
      const res = await authorize(w, authorizeQuery(url, "http://localhost:4242/callback"));
      assert.equal(res.statusCode, 302, res.body);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.redirect, "manual", "no redirect is followed");
      assert.ok(calls[0].init.signal, "the read has a time limit");
      const row = requestRow(w.account);
      assert.equal(row.clientName, "Claude Code");
      assert.equal(row.clientNameVerified, true, "a name from a fetched document is verified");
      assert.equal(row.loopback, true);
      await authorize(w, authorizeQuery(url, "http://localhost:4242/callback"));
      assert.equal(calls.length, 1, "cached for an hour");
    }
  );

  for (const [name, clientId, answer] of [
    ["another host", "https://evil.example/doc", () => new Response(JSON.stringify(document))],
    ["a host that ends the same", "https://notclaude.ai/doc", () => new Response(JSON.stringify(document))],
    ["plain http", "http://claude.ai/doc", () => new Response(JSON.stringify(document))],
    ["a different id", "https://claude.ai/other", () => new Response(JSON.stringify(document))],
    ["a redirect", "https://claude.ai/moved", () => new Response("", { status: 302, headers: { Location: "https://evil.example" } })],
    ["over 16 KB", "https://claude.ai/big", () => new Response(JSON.stringify({ ...document, client_id: "https://claude.ai/big", padding: "x".repeat(17_000) }))],
    ["not JSON", "https://claude.ai/text", () => new Response("hello")],
    ["unreachable", "https://claude.ai/down", () => { throw new Error("timed out"); }],
  ]) {
    const res = await withFetch(answer, () => authorize(w, authorizeQuery(clientId, "http://localhost:1/callback")));
    assert.equal(res.statusCode, 400, name);
    assert.match(res.body, /cannot be trusted/, name);
  }
});

scenario("MCS-M-28", async () => {
  const w = world();
  for (const host of [
    "api.puglieseweb.com",
    "abc123.execute-api.eu-west-2.amazonaws.com",
    "mcp.systemdox.com",
    "a.b.mcp.systemdox.com",
    "acme.mcp.systemdox.com.evil.example",
  ]) {
    for (const res of [
      await w.oauth(event("GET", "/.well-known/oauth-protected-resource/connect", { host })),
      await w.oauth(event("GET", "/.well-known/oauth-authorization-server", { host })),
      await register(w, { redirect_uris: [CLAUDE_CALLBACK] }, host),
      await authorize(w, authorizeQuery("sdxc_x.y"), host),
    ]) {
      assert.equal(res.statusCode, 404, host);
      assert.deepEqual(JSON.parse(res.body), { error: "not_found" });
    }
  }
  // A header a client can add is not where the host comes from.
  const forged = event("GET", "/.well-known/oauth-authorization-server", {
    host: "api.puglieseweb.com",
    headers: { Host: HOST, "X-Forwarded-Host": HOST },
  });
  assert.equal((await w.oauth(forged)).statusCode, 404);
  // Nor is the Host header, when the gateway named no domain.
  const unnamed = event("GET", "/.well-known/oauth-authorization-server");
  delete unnamed.requestContext.domainName;
  assert.equal((await w.oauth(unnamed)).statusCode, 404);
  const unnamedConnect = event("POST", "/connect", { body: "{}" });
  delete unnamedConnect.requestContext.domainName;
  assert.equal((await w.connect(unnamedConnect)).statusCode, 404);
});

scenario("MCS-M-29", async () => {
  const w = world();
  const real = await w.oauth(event("GET", "/.well-known/oauth-authorization-server"));
  const absent = await w.oauth(
    event("GET", "/.well-known/oauth-authorization-server", { host: "no-such-workspace.mcp.systemdox.com" })
  );
  assert.equal(absent.statusCode, real.statusCode);
  assert.deepEqual(
    Object.keys(JSON.parse(absent.body)),
    Object.keys(JSON.parse(real.body))
  );
  assert.equal(absent.body, real.body.replaceAll(HOST, "no-such-workspace.mcp.systemdox.com"));
  const clientId = await registeredClient(w);
  const request = await authorize(w, authorizeQuery(clientId), "no-such-workspace.mcp.systemdox.com");
  assert.equal(request.statusCode, 302, "it fails at approval, not here");
});

// ── MCS-2 A person's approval becomes a connection ────────────────────────────

const API_HOST = "api.puglieseweb.com";
const PERSON_TOKEN = ["Bearer", "person-session"].join(" ");
const OWNER = { tenant_id: "org_1", user_id: "usr_1", tenant_slug: WORKSPACE, role: "owner" };
const API_KEY = ["pweb", "test", "key", "01J", "secretpart"].join("_");
const IN_90_DAYS = "2027-02-04T00:00:00.000Z";

const consoleCall = (w, method, requestId, { authorizer = OWNER, body = null } = {}) =>
  w.oauth(
    event(method, "/v1/connection-requests/{requestId}", {
      host: API_HOST,
      body: body && JSON.stringify(body),
      headers: { Authorization: PERSON_TOKEN, Origin: "https://app.systemdox.com" },
      authorizer,
      pathParameters: { requestId },
    })
  );

/** shared-auth's key routes: minted keys are numbered, refusals are `refuse`'s. */
function authApi({ refuse, revokeStatus = 204 } = {}) {
  let minted = 0;
  return (url, init) => {
    if (init.method === "DELETE") return new Response(null, { status: revokeStatus });
    if (refuse) return new Response(JSON.stringify(refuse), { status: refuse.status ?? 403 });
    minted += 1;
    return new Response(
      JSON.stringify({ keyId: `key_${minted}`, key: `${API_KEY}${minted}`, expiresAt: IN_90_DAYS, mode: "read" }),
      { status: 200 }
    );
  };
}

async function askToConnect(w, { redirect = CLAUDE_CALLBACK, name = "Claude" } = {}) {
  const clientId = await registeredClient(w, redirect, name);
  const res = await authorize(w, authorizeQuery(clientId, redirect));
  assert.equal(res.statusCode, 302, res.body);
  return { clientId, redirect, requestId: new URL(res.headers.Location).searchParams.get("request") };
}

/** A person approves. Returns the request, plus the code that came back. */
async function approved(w, { access = "read", authorizer, redirect, name, api = authApi() } = {}) {
  const asked = await askToConnect(w, { redirect, name });
  const res = await withFetch(api, () =>
    consoleCall(w, "POST", asked.requestId, { authorizer, body: { decision: "approve", access } })
  );
  assert.equal(res.statusCode, 200, res.body);
  const back = new URL(JSON.parse(res.body).redirectTo);
  return { ...asked, back, code: back.searchParams.get("code") };
}

const form = (fields) => new URLSearchParams(fields).toString();

const exchange = (w, { code, clientId, redirect }, verifier = VERIFIER) =>
  w.oauth(
    event("POST", "/oauth/token", {
      body: form({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })
  );

const rowsOf = (w, prefix) => [...w.account.ddb.rows.values()].filter((row) => row.PK.startsWith(prefix));
const connections = (w) => rowsOf(w, "TENANT#").filter((row) => row.SK.startsWith("MCPCONN#"));

function assertRefused(res, code, status) {
  assert.equal(res.statusCode, status, res.body);
  assert.equal(JSON.parse(res.body).code, code);
}

scenario("MCS-M-07", async () => {
  const w = world();
  const calls = [];
  const api = (url, init) => {
    calls.push({ url, init });
    return authApi()(url, init);
  };
  const connected = await approved(w, { api, name: "Claude" });
  assert.equal(connected.back.origin + connected.back.pathname, CLAUDE_CALLBACK);
  assert.equal(connected.back.searchParams.get("state"), "xyz");
  assert.equal(connected.back.searchParams.get("iss"), ISSUER);
  assert.match(connected.code, /^sdxk_/);

  // The key is asked for in the person's own name, read only, on all spaces.
  const [mint] = calls;
  assert.equal(mint.url, "https://api.test/auth/v1/api-keys");
  assert.equal(mint.init.headers.Authorization, PERSON_TOKEN);
  const sent = JSON.parse(mint.init.body);
  assert.equal(sent.mode, "read");
  assert.equal(sent.expiresAt, undefined, "left out, for the default");
  assert.match(sent.name, /^Claude \(claude\.ai\) \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(sent.bindings, [
    {
      space: "*",
      scopes: ["build:read", "build:write", "capture:read", "capture:write", "docs:read"],
      preset: "product-owner",
    },
  ]);

  const res = await exchange(w, connected);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const pair = JSON.parse(res.body);
  assert.match(pair.access_token, /^sdxa_/);
  assert.match(pair.refresh_token, /^sdxr_/);
  assert.equal(pair.expires_in, 3600);
  assert.equal(pair.token_type, "Bearer");
  assert.equal(pair.scope, "systemdox.read");
  assert.equal(res.body.includes(API_KEY), false, "the API key is nowhere in what Claude receives");

  // Nothing readable is kept: not the key, not a token.
  const kept = JSON.stringify([...w.account.ddb.rows.values()]);
  for (const secret of [API_KEY, connected.code, pair.access_token, pair.refresh_token]) {
    assert.equal(kept.includes(secret), false);
  }
  const [connection] = connections(w);
  assert.equal(connection.ownerId, OWNER.user_id);
  assert.equal(connection.expiresAt, Date.parse(IN_90_DAYS), "the connection lasts as long as its key");
  for (const token of rowsOf(w, "MCPTOK#")) {
    assert.equal("ownerId" in token, false, "a token row holds no person");
  }
});

scenario("MCS-M-08", async () => {
  const w = world();
  const connected = await approved(w);
  assert.equal((await exchange(w, connected)).statusCode, 200);
  w.account.advance(31_000);
  const res = await exchange(w, connected);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid_grant");
  assert.equal(connections(w).length, 0, "the connection it created has ended");
  assert.equal(rowsOf(w, "MCPOWNER#").length, 0);
  // Well past the code's minute it is still seen for what it is.
  const w2 = world();
  const second = await approved(w2);
  await exchange(w2, second);
  w2.account.advance(3_600_000);
  assert.equal((await exchange(w2, second)).statusCode, 400);
  assert.equal(connections(w2).length, 0);
});

scenario("MCS-M-09", async () => {
  const w = world();
  const connected = await approved(w);
  const wrong = await exchange(w, connected, "x".repeat(43));
  assert.equal(wrong.statusCode, 400);
  assert.equal(JSON.parse(wrong.body).error, "invalid_grant");
  assert.equal(connections(w).length, 1);
  assert.equal((await exchange(w, connected)).statusCode, 200, "the code still works for Claude");
});

scenario("MCS-M-10", async () => {
  const w = world();
  const connected = await approved(w);
  w.account.advance(61_000);
  const res = await exchange(w, connected);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid_grant");
});

test("a code answers only its own client, return address and host", async () => {
  const w = world();
  const connected = await approved(w);
  assert.equal((await exchange(w, { ...connected, clientId: "sdxc_other" })).statusCode, 400);
  assert.equal((await exchange(w, { ...connected, redirect: "http://localhost:1/callback" })).statusCode, 400);
  const elsewhere = await w.oauth(
    event("POST", "/oauth/token", {
      host: "globex.mcp.systemdox.com",
      body: form({
        grant_type: "authorization_code",
        code: connected.code,
        client_id: connected.clientId,
        redirect_uri: connected.redirect,
        code_verifier: VERIFIER,
      }),
    })
  );
  assert.equal(JSON.parse(elsewhere.body).error, "invalid_grant");
  assert.equal((await exchange(w, connected)).statusCode, 200, "and none of those spent it");
  const none = await w.oauth(event("POST", "/oauth/token", { body: form({ grant_type: "password" }) }));
  assert.equal(JSON.parse(none.body).error, "unsupported_grant_type");
  const empty = await w.oauth(event("POST", "/oauth/token", { body: "" }));
  assert.equal(JSON.parse(empty.body).error, "invalid_request");
});

scenario("MCS-M-18", async () => {
  for (const reason of ["aal2_required", "step_up_required"]) {
    const w = world();
    const { requestId } = await askToConnect(w);
    const res = await withFetch(authApi({ refuse: { code: reason } }), () =>
      consoleCall(w, "POST", requestId, { body: { decision: "approve" } })
    );
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "SYD-C003");
    assert.equal(body.reason, reason);
    assert.equal(connections(w).length, 0, "no key is created");
    // The claim is released, so they can confirm it and approve.
    const again = await withFetch(authApi(), () => consoleCall(w, "POST", requestId, { body: { decision: "approve" } }));
    assert.equal(again.statusCode, 200, again.body);
  }
});

scenario("MCS-M-19", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  const editor = { ...OWNER, role: "editor" };
  const read = JSON.parse((await consoleCall(w, "GET", requestId, { authorizer: editor })).body);
  assert.equal(read.canApprove, false);
  const res = await withFetch(authApi({ refuse: { code: "insufficient_role" } }), () =>
    consoleCall(w, "POST", requestId, { authorizer: editor, body: { decision: "approve" } })
  );
  assertRefused(res, "SYD-C004", 403);
  assert.equal(connections(w).length, 0, "no key is created");
});

test("the mint's other refusals are the contract's", async () => {
  for (const [answer, code, status] of [
    [{ code: "binding_exceeds_creator" }, "SYD-C007", 403],
    // The same check as the rank's (api_keys.py), and no retry can pass it.
    [{ code: "support_session_forbidden" }, "SYD-C004", 403],
    [{ code: "anything", status: 500 }, "SYD-C005", 502],
  ]) {
    const w = world();
    const { requestId } = await askToConnect(w);
    const res = await withFetch(authApi({ refuse: answer }), () =>
      consoleCall(w, "POST", requestId, { body: { decision: "approve" } })
    );
    assertRefused(res, code, status);
    assert.equal(connections(w).length, 0);
  }
});

scenario("MCS-M-20", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  const elsewhere = { ...OWNER, tenant_id: "org_2", tenant_slug: "globex" };
  const read = JSON.parse((await consoleCall(w, "GET", requestId, { authorizer: elsewhere })).body);
  assert.equal(read.workspace, WORKSPACE);
  assert.equal(read.activeWorkspace, "globex");
  await withFetch(authApi(), async (calls) => {
    const res = await consoleCall(w, "POST", requestId, { authorizer: elsewhere, body: { decision: "approve" } });
    assertRefused(res, "SYD-C002", 409);
    assert.equal(calls.length, 0, "no key is created");
  });
});

scenario("MCS-M-21", async () => {
  const w = world();
  const api = authApi();
  const first = await approved(w, { api });
  await exchange(w, first);
  const asked = await askToConnect(w);
  const code = await withFetch(api, async (calls) => {
    const res = await consoleCall(w, "POST", asked.requestId, { body: { decision: "approve" } });
    assert.equal(res.statusCode, 200, res.body);
    const revoke = calls.find((call) => call.init.method === "DELETE");
    assert.equal(revoke.url, "https://api.test/auth/v1/api-keys/key_1", "the old key is revoked");
    assert.equal(revoke.init.headers.Authorization, PERSON_TOKEN);
    return new URL(JSON.parse(res.body).redirectTo).searchParams.get("code");
  });
  assert.equal((await exchange(w, { ...asked, code })).statusCode, 200, "the new connection works");
  const left = connections(w);
  assert.equal(left.length, 1, "they have one connection");
  assert.equal(left[0].keyId, "key_2", "the new connection stands");
  assert.equal(rowsOf(w, "MCPOWNER#").length, 1);

  // A failed revoke is logged and does not fail the approval.
  const again = await askToConnect(w);
  const res = await withFetch(authApi({ revokeStatus: 500 }), () =>
    consoleCall(w, "POST", again.requestId, { body: { decision: "approve" } })
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(connections(w).length, 1);
});

scenario("MCS-M-22", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  await withFetch(authApi(), async (calls) => {
    const res = await consoleCall(w, "POST", requestId, { body: { decision: "decline" } });
    assert.equal(res.statusCode, 200, res.body);
    const back = new URL(JSON.parse(res.body).redirectTo);
    assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "xyz");
    assert.equal(back.searchParams.get("iss"), ISSUER);
    assert.equal(calls.length, 0, "no key is created");
  });
  assert.equal(requestRow(w.account), undefined, "the request is deleted");
  assertRefused(await consoleCall(w, "GET", requestId), "SYD-C001", 404);
});

test("a person active in another workspace cannot decline this one's request", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  const elsewhere = { ...OWNER, tenant_id: "org_2", tenant_slug: "globex" };
  const res = await consoleCall(w, "POST", requestId, { authorizer: elsewhere, body: { decision: "decline" } });
  assertRefused(res, "SYD-C002", 409);
  assert.ok(requestRow(w.account), "the request stands");
});

test("a client's name reaches nobody with control or bidi characters in it", async () => {
  const w = world();
  const hidden = "Cl\u202Eaude\u0007\u200B\u2066\u2028 Code\u0000";
  const res = await register(w, { client_name: hidden, redirect_uris: [CLAUDE_CALLBACK] });
  assert.equal(JSON.parse(res.body).client_name, "Claude Code");
  const { requestId } = await askToConnect(w, { name: hidden });
  assert.equal(JSON.parse((await consoleCall(w, "GET", requestId)).body).clientName, "Claude Code");
  const url = "https://claude.ai/oauth/hidden-name";
  const document = { client_id: url, client_name: hidden, redirect_uris: [CLAUDE_CALLBACK] };
  const fetched = world();
  await withFetch(
    () => new Response(JSON.stringify(document), { status: 200 }),
    () => authorize(fetched, authorizeQuery(url))
  );
  assert.equal(requestRow(fetched.account).clientName, "Claude Code");
});

test("an approval and a reuse are logged, with no token, code or key", async () => {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    const w = world();
    const connected_ = await approved(w, { access: "write" });
    const [connection] = connections(w);
    const pair = JSON.parse((await exchange(w, connected_)).body);
    w.account.advance(31_000);
    await exchange(w, connected_);
    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call.arguments[0]));
    const said = lines.map((line) => JSON.parse(line));
    const approval = said.find((entry) => entry.event === "mcp.connection.approved");
    assert.equal(approval.connectionId, connection.connectionId);
    assert.equal(approval.organisationId, OWNER.tenant_id);
    assert.equal(approval.returnHost, "claude.ai");
    assert.equal(approval.access, "write");
    const reuse = said.find((entry) => entry.event === "mcp.connection.ended");
    assert.equal(reuse.reason, "token_reused");
    assert.equal(reuse.connectionId, connection.connectionId);
    for (const secret of [API_KEY, connected_.code, pair.access_token, pair.refresh_token, PERSON_TOKEN]) {
      assert.equal(lines.join("\n").includes(secret), false);
    }
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
});

test("a mint that answers something other than JSON is SYD-C005, and the claim is released", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  const res = await withFetch(
    () => new Response("<html>Bad gateway</html>", { status: 502 }),
    () => consoleCall(w, "POST", requestId, { body: { decision: "approve" } })
  );
  assertRefused(res, "SYD-C005", 502);
  const again = await withFetch(authApi(), () => consoleCall(w, "POST", requestId, { body: { decision: "approve" } }));
  assert.equal(again.statusCode, 200, again.body);
});

test("an answer that is not a ConnectionAnswer is a 400 with a detail", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  for (const body of [{ decision: "maybe" }, { decision: "approve", access: "admin" }]) {
    const res = await consoleCall(w, "POST", requestId, { body });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { detail: "That answer was not understood." });
  }
});

test("a double click creates one key, and a stale request is gone", async () => {
  const w = world();
  const { requestId } = await askToConnect(w);
  await withFetch(authApi(), async (calls) => {
    const answers = await Promise.all([
      consoleCall(w, "POST", requestId, { body: { decision: "approve" } }),
      consoleCall(w, "POST", requestId, { body: { decision: "approve" } }),
    ]);
    assert.deepEqual(answers.map((res) => res.statusCode).sort(), [200, 409]);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    const late = await consoleCall(w, "POST", requestId, { body: { decision: "approve" } });
    assertRefused(late, "SYD-C006", 409);
    assertRefused(await consoleCall(w, "POST", requestId, { body: { decision: "decline" } }), "SYD-C006", 409);
  });
  const stale = await askToConnect(w);
  w.account.advance(600_001);
  assertRefused(await consoleCall(w, "GET", stale.requestId), "SYD-C001", 404);
  assertRefused(await consoleCall(w, "POST", stale.requestId, { body: { decision: "approve" } }), "SYD-C001", 404);
  assertRefused(await consoleCall(w, "GET", "cnr_00000000000000000000000000"), "SYD-C001", 404);
});

test("the console reads the request, from the console's origin", async () => {
  const w = world();
  const { requestId } = await askToConnect(w, { name: "Claude" });
  const res = await consoleCall(w, "GET", requestId);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://app.systemdox.com");
  assert.deepEqual(JSON.parse(res.body), {
    requestId,
    clientName: "Claude",
    clientNameVerified: false,
    returnHost: "claude.ai",
    loopback: false,
    workspace: WORKSPACE,
    activeWorkspace: WORKSPACE,
    canApprove: true,
    expiresAt: new Date(requestRow(w.account).expiresAt).toISOString(),
  });
  const refused = await w.oauth(
    event("GET", "/v1/connection-requests/{requestId}", {
      host: API_HOST,
      headers: { Origin: "https://evil.example" },
      authorizer: OWNER,
      pathParameters: { requestId },
    })
  );
  assert.equal(refused.headers["Access-Control-Allow-Origin"], undefined);
});

scenario("MCS-M-31", async () => {
  // The erasure is Python, and tested there: backend/tests/test_erasure_wave2.py
  // erases the rows of this fixture. What is held here is that the fixture is
  // what the real handlers write, so that test erases production's rows.
  const fixture = JSON.parse(
    await readFile(join(dirname(FEATURE), "..", "..", "..", "..", "backend", "tests", "fixtures", "mcp_connection_rows.json"), "utf8")
  );
  const shape = (row) => {
    const prefix = (key) => key.split("#")[0];
    return `${prefix(row.PK)}|${row.SK.startsWith("MCPCONN#") ? "MCPCONN" : row.SK === "TOKEN" ? "TOKEN" : "OWNER"}|${row.kind ?? ""}|${Object.keys(row).sort()}`;
  };
  const w = world();
  const connected = await approved(w);
  await exchange(w, connected);
  const written = [...w.account.ddb.rows.values()].filter((row) => !row.PK.startsWith("MCPREQ#"));
  assert.deepEqual(written.map(shape).sort(), fixture.map(shape).sort());
  const erasure = await readFile(join(dirname(FEATURE), "..", "..", "..", "..", "backend", "tests", "test_erasure_wave2.py"), "utf8");
  assert.match(erasure, /test_erasing_a_person_ends_their_mcp_connections/);
});

scenario("MCS-M-32", async () => {
  const w = world();
  const connected = await approved(w);
  const first = await exchange(w, connected);
  w.account.advance(29_000);
  const retried = await exchange(w, connected);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.deepEqual(JSON.parse(retried.body), JSON.parse(first.body));
  assert.equal(connections(w).length, 1);
});

scenario("MCS-M-33", async () => {
  const w = world();
  const api = authApi();
  const claudeCode = { redirect: "http://localhost:53012/callback", name: "Claude Code", api };
  await withFetch(api, async (calls) => {
    await approved(w, claudeCode);
    await approved(w, { ...claudeCode, redirect: "http://localhost:61000/callback" });
    assert.equal(calls.filter((call) => call.init.method === "DELETE").length, 0, "nothing is revoked");
  });
  const both = connections(w);
  assert.equal(both.length, 2, "both computers stay connected");
  assert.ok(both.every((connection) => connection.loopback));
});

// ── MCS-4 A connected Claude uses its tools ───────────────────────────────────

const READ_TOOLS = [
  "get_context", "get_checks", "get_guardrails", "get_project_rules", "get_prompt_templates", "get_specs",
  "get_docs", "get_tech_stack", "get_planning_context", "get_plan_board", "get_change", "get_team_setup",
  "get_document_links", "trace_document_path", "get_graph_stats", "list_skills", "install_skill", "resolve_person",
];
const WRITE_TOOLS = [
  "create_check", "create_guardrail", "create_project_rule", "create_prompt_template", "update_spec",
  "report_decision", "publish_skill", "publish_setup_part",
];

const CHECK = { id: "1", title: "No secrets in code", description: "d", category: "security", severity: "high" };

/** The REST API: `status` and `body` are what the next call answers. */
function restApi(world_) {
  world_.rest = { status: 200, body: [CHECK] };
  return (url, init) => {
    world_.restCalls = [...(world_.restCalls ?? []), { url, init }];
    return new Response(JSON.stringify(world_.rest.body), { status: world_.rest.status });
  };
}

const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 7, method, params });
const callTool = (name = "get_checks") => rpc("tools/call", { name, arguments: {} });

const post = (w, token, body = callTool(), host = HOST) =>
  withFetch((url, init) => w.restAnswer(url, init), () =>
    w.connect(
      event("POST", "/connect", {
        host,
        body,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      })
    )
  );

/** A connection, with Claude holding its pair. */
async function connected(options = {}) {
  const w = world();
  w.restAnswer = restApi(w);
  const approval = await approved(w, options);
  const res = await exchange(w, approval);
  assert.equal(res.statusCode, 200, res.body);
  return { w, approval, pair: JSON.parse(res.body) };
}

const refresh = (w, { refresh_token: refreshToken }, clientId) =>
  w.oauth(
    event("POST", "/oauth/token", {
      body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    })
  );

const toolResult = (res) => JSON.parse(res.body).result;
const toolNames = async (w, token) =>
  toolResult(await post(w, token, rpc("tools/list"))).tools.map((tool) => tool.name).sort();

scenario("MCS-M-01", async () => {
  const w = world();
  for (const token of [undefined, "sdxa_unknown", API_KEY]) {
    const res = await w.connect(
      event("POST", "/connect", {
        body: rpc("initialize"),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    );
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(
      res.headers["WWW-Authenticate"],
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/connect"`
    );
    assert.equal(JSON.parse(res.body).error, "invalid_token");
  }
  const stream = await w.connect(event("GET", "/connect"));
  assert.equal(stream.statusCode, 405);
  assert.equal(stream.headers.Allow, "POST");
  const elsewhere = await w.connect(event("POST", "/connect", { host: API_HOST, body: rpc("initialize") }));
  assert.equal(elsewhere.statusCode, 404);
});

scenario("MCS-M-11", async () => {
  const { w, pair } = await connected();
  const res = await post(w, pair.access_token);
  assert.equal(res.statusCode, 200, res.body);
  const result = toolResult(res);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /No secrets in code/);
  const [call] = w.restCalls;
  assert.match(call.url, /^https:\/\/api\.test\/systemdox\//);
  assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}1`, "its own API, with the connection's key");
  assert.equal(res.body.includes(API_KEY), false);
});

test("the key opens only under its own connection's context", async () => {
  const { w, pair } = await connected();
  await approved(w, { redirect: "http://localhost:1/callback", name: "Other" });
  const mine = connections(w).find((row) => row.returnHost === "claude.ai");
  const other = connections(w).find((row) => row.loopback);
  putRow(w, { ...mine, encryptedKey: other.encryptedKey });
  const res = await post(w, pair.access_token);
  assert.equal(res.statusCode, 401);
  assert.equal(w.restCalls, undefined, "no key left the function");
});

test("a key is opened under the checked token row's ids", async () => {
  const { w, pair } = await connected();
  const deps = w.account.deps(["Decrypt"], [TOKEN_DERIVATION_SECRET]);
  const decrypt = deps.kms.send.bind(deps.kms);
  const contexts = [];
  deps.kms.send = (command) => {
    contexts.push(command.input.EncryptionContext);
    return decrypt(command);
  };
  w.connect = createConnectHandler(() => deps);
  assert.equal((await post(w, pair.access_token)).statusCode, 200);
  const token = tokenRow(w, "access");
  assert.deepEqual(contexts, [{ organisation: token.organisationId, connection: token.connectionId }]);
});

const putRow = (w, row) => w.account.ddb.rows.set(`${row.PK}\u0000${row.SK}`, row);
const tokenRow = (w, kind) => rowsOf(w, "MCPTOK#").find((row) => row.kind === kind);
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("a row written by anything else opens no key: a forged token is an invalid token", async () => {
  const { w, approval, pair } = await connected();
  const [connection] = connections(w);
  const forged = ["sdxa", "forged-by-any-function-holding-the-table"].join("_");
  const genuine = tokenRow(w, "access");

  // The security reviewer's P6: a row with no MAC, for a real connection.
  putRow(w, {
    PK: `MCPTOK#${sha(forged)}`,
    SK: "TOKEN",
    organisationId: connection.organisationId,
    connectionId: connection.connectionId,
    kind: "access",
    expiresAt: w.account.now + 3_600_000,
    ttl: 9_999_999_999,
  });
  const none = await post(w, forged);
  assert.equal(none.statusCode, 401);
  assert.match(none.headers["WWW-Authenticate"], /resource_metadata/);

  // A genuine row, MAC and all, copied under the hash of a token of the writer's own.
  putRow(w, { ...genuine, PK: `MCPTOK#${sha(forged)}` });
  assert.equal((await post(w, forged)).statusCode, 401);

  // A genuine row with its hour extended.
  w.account.advance(3_600_001);
  putRow(w, { ...genuine, expiresAt: w.account.now + 3_600_000 });
  assert.equal((await post(w, pair.access_token)).statusCode, 401);
  assert.equal(w.restCalls, undefined, "no key was opened");

  // The same on the refresh: a forged refresh row gives no pair.
  const refreshForged = ["sdxr", "forged"].join("_");
  putRow(w, { ...tokenRow(w, "refresh"), PK: `MCPTOK#${sha(refreshForged)}` });
  const refused = await refresh(w, { refresh_token: refreshForged }, approval.clientId);
  assert.equal(JSON.parse(refused.body).error, "invalid_grant");
  assert.equal(connections(w).length, 1, "and a forged row ends nothing");
});

test("a table writer with one honest token of its own opens nobody else's key", async () => {
  const w = world();
  w.restAnswer = restApi(w);
  const minted = (key) => () => new Response(JSON.stringify({ keyId: key, key, expiresAt: IN_90_DAYS }), { status: 200 });
  await approved(w, { api: minted("VICTIMKEY") });

  const EVIL = "evil.mcp.systemdox.com";
  const writer = { tenant_id: "org_2", user_id: "usr_2", tenant_slug: "evil", role: "owner" };
  const clientId = await registeredClient(w);
  const asked = await authorize(w, authorizeQuery(clientId), EVIL);
  const requestId = new URL(asked.headers.Location).searchParams.get("request");
  const answer = await withFetch(minted("WRITERKEY"), () =>
    consoleCall(w, "POST", requestId, { authorizer: writer, body: { decision: "approve", access: "read" } })
  );
  const code = new URL(JSON.parse(answer.body).redirectTo).searchParams.get("code");
  const tokens = await w.oauth(
    event("POST", "/oauth/token", {
      host: EVIL,
      body: form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: VERIFIER }),
    })
  );
  const pair = JSON.parse(tokens.body);
  await post(w, pair.access_token, callTool(), EVIL);
  assert.match(w.restCalls.at(-1).init.headers.Authorization, /WRITERKEY/, "an honest call uses the writer's own key");

  const rows = connections(w);
  const victim = rows.find((row) => row.organisationId === OWNER.tenant_id);
  const own = rows.find((row) => row.organisationId === "org_2");
  putRow(w, { ...own, organisationId: victim.organisationId, connectionId: victim.connectionId, encryptedKey: victim.encryptedKey });
  w.restCalls = [];
  const res = await post(w, pair.access_token, callTool(), EVIL);
  assert.equal(res.statusCode, 401, res.body);
  assert.deepEqual(w.restCalls, [], "no key left the function");
});

test("a connection row is held to what was approved, on /connect and on the refresh", async () => {
  for (const change of [{ access: "write" }, { label: "evil" }, { expiresAt: 9_999_999_999_999 }, { clientHash: "x" }, { keyId: "key_x" }]) {
    const { w, approval, pair } = await connected();
    const [row] = connections(w);
    putRow(w, { ...row, ...change });
    w.restCalls = [];
    const res = await post(w, pair.access_token);
    assert.equal(res.statusCode, 401, JSON.stringify(change));
    assert.deepEqual(w.restCalls, []);
    assert.equal(JSON.parse((await refresh(w, pair, approval.clientId)).body).error, "invalid_grant", JSON.stringify(change));
  }
});

test("the counts of a refused key are not what the row's MAC covers", async () => {
  const { w, pair } = await connected();
  w.rest = { status: 401, body: { message: "Unauthorized" } };
  expectKeyRefusedWords(await post(w, pair.access_token));
  expectKeyRefusedWords(await post(w, pair.access_token));
  assert.equal(connections(w)[0].keyRefusedCalls, 2, "the row still reads as genuine");
});

test("a pending request is held to what was asked: a rewritten row is a request that has gone", async () => {
  for (const change of [
    { redirectUri: "https://evil.example/cb" },
    { returnHost: "evil.example" },
    { challenge: "x".repeat(43) },
    { clientName: "Your IT department", clientNameVerified: true },
    { label: "globex" },
    { state: "other" },
    { loopback: true },
    { expiresAt: 9_999_999_999_999 },
    { clientId: "sdxc_other" },
  ]) {
    const w = world();
    const asked = await askToConnect(w);
    putRow(w, { ...requestRow(w.account), ...change });
    assertRefused(await consoleCall(w, "GET", asked.requestId), "SYD-C001", 404);
    await withFetch(authApi(), async (calls) => {
      const res = await consoleCall(w, "POST", asked.requestId, { body: { decision: "approve", access: "write" } });
      assertRefused(res, "SYD-C001", 404);
      assert.equal(calls.length, 0, `no key for ${JSON.stringify(change)}`);
    });
  }
});

test("replacedAt held as NULL is not an unspent row", async () => {
  const { w, approval, pair } = await connected();
  const row = rowsOf(w, "MCPTOK#").find((candidate) => candidate.PK === `MCPTOK#${sha(pair.refresh_token)}`);
  putRow(w, { ...row, replacedAt: null });
  assert.equal(JSON.parse((await refresh(w, pair, approval.clientId)).body).error, "invalid_grant");
  assert.equal(connections(w).length, 1, "a forged row ends nothing");
});

test("Claude's other callback passes through the stack's allow-list, and shows its own host", async () => {
  const CLAUDE_COM = "https://claude.com/api/mcp/auth_callback";
  const refused = await register(world(), { redirect_uris: [CLAUDE_COM] });
  assert.equal(JSON.parse(refused.body).error, "invalid_redirect_uri", "the rule itself does not name it");
  process.env.MCP_CLIENT_ALLOW_LIST = CLAUDE_COM;
  try {
    const w = world();
    const connected_ = await approved(w, { redirect: CLAUDE_COM });
    assert.equal(connected_.back.origin + connected_.back.pathname, CLAUDE_COM);
    assert.equal(connections(w)[0].returnHost, "claude.com");
    const asked = await askToConnect(w, { redirect: CLAUDE_COM });
    assert.equal(JSON.parse((await consoleCall(w, "GET", asked.requestId)).body).returnHost, "claude.com");
  } finally {
    delete process.env.MCP_CLIENT_ALLOW_LIST;
  }
});

test("a spent token cannot be made unspent, and a code's challenge cannot be swapped", async () => {
  const { w, approval, pair } = await connected();
  await refresh(w, pair, approval.clientId);
  const spent = rowsOf(w, "MCPTOK#").find((row) => row.PK === `MCPTOK#${sha(pair.refresh_token)}`);
  assert.ok(spent.replacedAt, "the token was spent");
  w.account.advance(31_000);
  const { replacedAt, ...revived } = spent;
  putRow(w, revived);
  assert.equal(JSON.parse((await refresh(w, pair, approval.clientId)).body).error, "invalid_grant");

  const second = world();
  const asked = await approved(second);
  const code = tokenRow(second, "code");
  putRow(second, { ...code, challenge: "x".repeat(43) });
  assert.equal(JSON.parse((await exchange(second, asked)).body).error, "invalid_grant");
});

test("the https pin holds on /connect, as on /mcp: a key never goes out in clear", async () => {
  const { w, pair } = await connected();
  const url = process.env.SYSTEMDOX_API_URL;
  process.env.SYSTEMDOX_API_URL = "http://api.test/systemdox";
  try {
    const res = await post(w, pair.access_token);
    assert.equal(res.statusCode, 500);
    assert.equal(w.restCalls, undefined);
  } finally {
    process.env.SYSTEMDOX_API_URL = url;
  }
});

const ESCAPES = [
  "../../../auth/v1/api-keys",
  "..",
  ".",
  "%2e%2e",
  "%2E%2E%2Fauth%2Fv1%2Fapi-keys",
  "..%2f..%2fauth",
  ".%2e/.%2E/auth",
  "a/../../../b",
  "..\\..\\auth",
  "%252e%252e%252fauth",
  ".\t./.\n./auth",
];

test("an id cannot walk out of its route: through real tools, nothing is fetched", async () => {
  const { w, pair } = await connected({ access: "write" });
  const tools = (id) => [
    ["get_specs", { draft_id: id }],
    ["get_docs", { doc_id: id }],
    ["update_spec", { draft_id: id, section: "proposal", content: "x" }],
    ["install_skill", { name: id }],
  ];
  for (const id of ESCAPES) {
    for (const [name, args] of tools(id)) {
      w.restCalls = [];
      const res = await post(w, pair.access_token, rpc("tools/call", { name, arguments: args }));
      assert.equal(toolResult(res).isError, true, `${name} ${JSON.stringify(id)}`);
      assert.deepEqual(w.restCalls, [], `${name} ${JSON.stringify(id)} reached ${w.restCalls[0]?.url}`);
    }
  }
});

test("the client's own segment encoder cannot pass a dot segment either", async () => {
  const client = new SystemDoxApiClient({
    apiKey: API_KEY,
    apiUrl: "https://api.test/systemdox",
    cacheTtlMs: 0,
    defaultOrg: undefined,
  });
  await withFetch(
    () => new Response("{}", { status: 200 }),
    async (calls) => {
      for (const id of ["..", ".", "%2e%2e"]) {
        await assert.rejects(client.resolvePerson(WORKSPACE, id), /leaves the API/, id);
        await assert.rejects(client.getTeamSetup(id), /leaves the API/, id);
      }
      assert.equal(calls.length, 0);
    }
  );
});

test("the same refusal holds on /mcp, which shares the client", async () => {
  await withFetch(
    () => new Response("{}", { status: 200 }),
    async (calls) => {
      const res = await mcpHandler({
        httpMethod: "POST",
        path: "/mcp",
        headers: { Host: HOST, Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: rpc("tools/call", { name: "get_specs", arguments: { draft_id: "../../../auth/v1/api-keys" } }),
        isBase64Encoded: false,
        requestContext: { authorizer: { tenant_slug: WORKSPACE } },
      });
      assert.equal(toolResult(res).isError, true);
      assert.equal(calls.length, 0, "the key went nowhere");
    }
  );
});

test("an id stays one path segment, and a real document id still reads", async () => {
  const { w, pair } = await connected({ access: "write" });
  w.rest = { status: 200, body: { name: "s", status: "draft", requirements: [] } };
  w.restCalls = [];
  await post(w, pair.access_token, rpc("tools/call", { name: "get_specs", arguments: { draft_id: "abc/publish" } }));
  assert.equal(new URL(w.restCalls[0].url).pathname, "/systemdox/v1/specs/abc%2Fpublish");
  w.restCalls = [];
  await post(
    w,
    pair.access_token,
    rpc("tools/call", { name: "update_spec", arguments: { draft_id: "abc/publish", section: "proposal", content: "x" } })
  );
  assert.deepEqual(
    w.restCalls.map((call) => new URL(call.url).pathname),
    ["/systemdox/v1/specs/abc%2Fpublish", "/systemdox/v1/specs/abc%2Fpublish"]
  );
  w.restCalls = [];
  const docId = "RepoDoc#puglieseweb/docs-company#6430ea3e0f9e";
  w.rest = { status: 200, body: { content: "text", title: "t" } };
  await post(w, pair.access_token, rpc("tools/call", { name: "get_docs", arguments: { doc_id: docId } }));
  assert.equal(
    new URL(w.restCalls[0].url).pathname,
    "/systemdox/v1/docs/RepoDoc%23puglieseweb%2Fdocs-company%236430ea3e0f9e/content"
  );
});

test("the client refuses a path that leaves its base, before any fetch", async () => {
  const client = new SystemDoxApiClient({
    apiKey: API_KEY,
    apiUrl: "https://api.test/systemdox",
    cacheTtlMs: 0,
    defaultOrg: undefined,
  });
  await withFetch(
    () => new Response("{}", { status: 200 }),
    async (calls) => {
      const tab = String.fromCharCode(9);
      const newline = String.fromCharCode(10);
      for (const path of [
        "/v1/../../auth/v1/api-keys",
        "/%2e%2e/auth",
        "/v1/a/..",
        "../auth",
        // A URL parser drops these before it reads the escape they split.
        `/v1/docs/%2${tab}e%2${tab}e/x`,
        `/v1/docs/%${newline}2e%${tab}2e/x`,
        `/v1/docs/%25${tab}2e%25${tab}2e/x`,
        "/v1/docs/%2%09e%2%09e/x",
      ]) {
        await assert.rejects(client.get(path), /leaves the API/, path);
        await assert.rejects(client.post(path, {}), /leaves the API/, path);
        await assert.rejects(client.getFresh(path), /leaves the API/, path);
      }
      assert.equal(calls.length, 0);
      await client.get("/v1/ok?next=../elsewhere");
      await client.get("/v1/ok", { search: "../../x" });
      assert.equal(calls.length, 2, "only the path is held to it");
    }
  );
});

scenario("MCS-M-12", async () => {
  const { w, pair } = await connected({ access: "read" });
  assert.deepEqual(await toolNames(w, pair.access_token), [...READ_TOOLS].sort());
});

scenario("MCS-M-13", async () => {
  const { w, pair } = await connected({ access: "write" });
  assert.equal(pair.scope, "systemdox.read systemdox.write");
  assert.deepEqual(await toolNames(w, pair.access_token), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  // Every tool /mcp offers: the list leaves none behind.
  const hosted = await mcpHandler({
    httpMethod: "POST",
    path: "/mcp",
    headers: { Host: HOST, Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: rpc("tools/list"),
    isBase64Encoded: false,
    requestContext: { authorizer: { tenant_slug: WORKSPACE } },
  });
  assert.deepEqual(toolResult(hosted).tools.map((tool) => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

scenario("MCS-M-14", async () => {
  const { w, pair } = await connected();
  const res = await post(w, pair.access_token, callTool(), "globex.mcp.systemdox.com");
  assert.equal(res.statusCode, 401);
  assert.match(res.headers["WWW-Authenticate"], /globex\.mcp\.systemdox\.com/);
  assert.equal(w.restCalls, undefined, "no call was made with the key");
});

scenario("MCS-M-15", async () => {
  const { w, approval, pair } = await connected();
  w.account.advance(3_600_001);
  assert.equal((await post(w, pair.access_token)).statusCode, 401, "the old token no longer works");
  const res = await refresh(w, pair, approval.clientId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const next = JSON.parse(res.body);
  assert.notEqual(next.access_token, pair.access_token);
  assert.notEqual(next.refresh_token, pair.refresh_token);
  assert.equal((await post(w, next.access_token)).statusCode, 200);
  assert.equal((await post(w, pair.access_token)).statusCode, 401);
  const stored = JSON.stringify([...w.account.ddb.rows.values()]);
  assert.equal(stored.includes(next.access_token) || stored.includes(next.refresh_token), false);
});

scenario("MCS-M-16", async () => {
  const { w, approval, pair } = await connected();
  const first = await refresh(w, pair, approval.clientId);
  w.account.advance(29_000);
  const second = await refresh(w, pair, approval.clientId);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.equal(connections(w).length, 1);
});

scenario("MCS-M-17", async () => {
  const { w, approval, pair } = await connected();
  const next = JSON.parse((await refresh(w, pair, approval.clientId)).body);
  w.account.advance(31_000);
  const res = await refresh(w, pair, approval.clientId);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid_grant");
  assert.equal(connections(w).length, 0, "the connection has ended");
  assert.equal((await post(w, next.access_token)).statusCode, 401);
  assert.equal(JSON.parse((await refresh(w, next, approval.clientId)).body).error, "invalid_grant");
});

test("a refresh token answers only its own client and host", async () => {
  const { w, pair } = await connected();
  assert.equal(JSON.parse((await refresh(w, pair, "sdxc_other")).body).error, "invalid_grant");
  assert.equal(JSON.parse((await refresh(w, { refresh_token: "sdxr_unknown" }, "x")).body).error, "invalid_grant");
  assert.equal(JSON.parse((await refresh(w, { refresh_token: pair.access_token }, "x")).body).error, "invalid_grant");
  assert.equal(connections(w).length, 1, "none of those ended it");
});

const expectKeyRefusedWords = (res) => {
  assert.equal(res.statusCode, 200, res.body);
  const result = toolResult(res);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /refused this connection/);
};

scenario("MCS-M-23", async () => {
  const { w, approval, pair } = await connected();
  w.rest = { status: 401, body: { message: "Unauthorized. Please sign in to access this resource." } };
  expectKeyRefusedWords(await post(w, pair.access_token));
  w.account.advance(1_800_000);
  expectKeyRefusedWords(await post(w, pair.access_token));
  assert.equal(connections(w)[0].keyRefusedCalls, 2);
  w.account.advance(1_800_000 + 1_000);
  // Past the hour, so the token is renewed first: the refresh still works.
  const renewed = await refresh(w, pair, approval.clientId);
  assert.equal(renewed.statusCode, 200);
  const next = JSON.parse(renewed.body);
  const ended = await post(w, next.access_token);
  assert.equal(ended.statusCode, 401, ended.body);
  assert.match(ended.headers["WWW-Authenticate"], /resource_metadata/);
  assert.equal(connections(w).length, 0, "the connection has ended");
  assert.equal(JSON.parse((await refresh(w, next, approval.clientId)).body).error, "invalid_grant");
});

test("an hour alone, or three calls alone, ends nothing", async () => {
  const { w, pair } = await connected();
  w.rest = { status: 401, body: { message: "Unauthorized" } };
  for (let call = 0; call < 5; call += 1) expectKeyRefusedWords(await post(w, pair.access_token));
  assert.equal(connections(w).length, 1, "five calls in a moment");
  const quiet = await connected();
  quiet.w.rest = { status: 401, body: { message: "Unauthorized" } };
  expectKeyRefusedWords(await post(quiet.w, quiet.pair.access_token));
  quiet.w.account.advance(3_600_001);
  const next = JSON.parse((await refresh(quiet.w, quiet.pair, quiet.approval.clientId)).body);
  expectKeyRefusedWords(await post(quiet.w, next.access_token));
  assert.equal(connections(quiet.w).length, 1, "two calls over an hour");
});

scenario("MCS-M-24", async () => {
  const { w, pair } = await connected();
  w.rest = { status: 401, body: { message: "Unauthorized" } };
  expectKeyRefusedWords(await post(w, pair.access_token));
  w.account.advance(180_000);
  w.rest = { status: 200, body: [CHECK] };
  const res = await post(w, pair.access_token);
  assert.equal(toolResult(res).isError, undefined);
  assert.match(toolResult(res).content[0].text, /No secrets in code/);
  const [connection] = connections(w);
  assert.equal(connection.keyRefusedAt, undefined, "any success clears it");
  assert.equal(connection.keyRefusedCalls, undefined);
});

scenario("MCS-M-25", async () => {
  for (const code of ["USER_SUSPENDED", "MEMBER_SUSPENDED", "MEMBERSHIP_REVOKED", "ORG_SUSPENDED", "ORG_PENDING_DELETION"]) {
    const { w, approval, pair } = await connected();
    w.rest = { status: 403, body: { type: "about:blank", title: "Forbidden", status: 403, code } };
    const res = await post(w, pair.access_token);
    assert.equal(res.statusCode, 200, "a 401 would send Claude round a refresh that works");
    const result = toolResult(res);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /suspended/, code);
    assert.equal(connections(w).length, 1, "the connection has not ended");
    assert.equal(connections(w)[0].keyRefusedAt, undefined);
    assert.equal((await refresh(w, pair, approval.clientId)).statusCode, 200);
    w.rest = { status: 200, body: [CHECK] };
    const next = await post(w, JSON.parse((await refresh(w, pair, approval.clientId)).body).access_token);
    assert.match(toolResult(next).content[0].text, /No secrets in code/, "it works again once lifted");
  }
});

scenario("MCS-M-26", async () => {
  const { w, pair } = await connected();
  w.rest = { status: 404, body: { code: "space_not_visible", detail: "No such space" } };
  const res = await post(w, pair.access_token);
  assert.equal(res.statusCode, 200);
  const result = toolResult(res);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /space_not_visible/, "the tool's own error");
  assert.doesNotMatch(result.content[0].text, /refused this connection|suspended/);
  const [connection] = connections(w);
  assert.equal(connection.keyRefusedAt, undefined, "the connection is untouched");
  assert.equal(connection.keyRefusedCalls, undefined);
});

scenario("MCS-M-27", async () => {
  const soon = new Date(1_780_000_000_000 + 1_800_000).toISOString();
  const w = world();
  w.restAnswer = restApi(w);
  const api = (url, init) =>
    new Response(JSON.stringify({ keyId: "key_1", key: API_KEY, expiresAt: soon }), { status: 200 });
  const approval = await approved(w, { api });
  const pair = JSON.parse((await exchange(w, approval)).body);
  assert.equal((await post(w, pair.access_token)).statusCode, 200);
  w.account.advance(1_800_001);
  const res = await post(w, pair.access_token);
  assert.equal(res.statusCode, 401, "the token answers 401, though its own hour is not up");
  assert.match(res.headers["WWW-Authenticate"], /resource_metadata/);
  assert.equal(JSON.parse((await refresh(w, pair, approval.clientId)).body).error, "invalid_grant");
});

scenario("MCS-M-30", async () => {
  const keyed = (headers) => ({
    httpMethod: "POST",
    path: "/mcp",
    headers: { Host: HOST, "Content-Type": "application/json", ...headers },
    body: rpc("tools/call", { name: "get_checks", arguments: {} }),
    isBase64Encoded: false,
    requestContext: { authorizer: { tenant_slug: WORKSPACE } },
  });
  const calls = await withFetch(
    () => new Response(JSON.stringify([CHECK]), { status: 200 }),
    async (seen) => {
      const res = await mcpHandler(keyed({ Authorization: `Bearer ${API_KEY}` }));
      assert.equal(res.statusCode, 200, res.body);
      assert.match(toolResult(res).content[0].text, /No secrets in code/);
      return seen;
    }
  );
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`, "the bearer is the key, as it was");
  const none = await mcpHandler(keyed({}));
  assert.equal(none.statusCode, 401);
  assert.equal(none.headers["WWW-Authenticate"], undefined, "refused as it was");
  assert.equal(JSON.parse(none.body).error.message, "Missing bearer API key");
  const otherTenant = await mcpHandler({
    ...keyed({ Authorization: `Bearer ${API_KEY}` }),
    requestContext: { authorizer: { tenant_slug: "globex" } },
  });
  assert.equal(otherTenant.statusCode, 403);
});

test("the published package holds no Lambda handler, and nothing that needs the AWS SDK", async () => {
  const root = join(dirname(FEATURE), "..", "..");
  const [{ files }] = JSON.parse(
    execSync("npm pack --dry-run --json --ignore-scripts", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  );
  const packed = files.map((file) => file.path.replaceAll("\\", "/"));
  assert.ok(packed.includes("dist/http.js") && packed.includes("dist/cli.js"), "the package itself is still there");
  const handlers = packed.filter((path) => /^dist\/(oauth|connect)\./.test(path));
  assert.deepEqual(handlers, []);
  for (const path of packed.filter((name) => name.endsWith(".js"))) {
    assert.equal((await readFile(join(root, path), "utf8")).includes("@aws-sdk/"), false, path);
  }
});

test("the feature holds its scenarios, each with a unique id and one state tag", () => {
  assert.equal(SCENARIOS.length, 33);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
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
