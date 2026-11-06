// The hosted (Lambda) MCP entry point must obey the SAME https pin as the CLI.
// This path forwards the CUSTOMER's bearer API key to the REST API, so a
// non-https SYSTEMDOX_API_URL would leak their key in cleartext. It once read
// the env var raw, bypassing requireHttpsApiUrl(); these tests fail if that
// bypass — or any loopback carve-out for it — comes back.
// Build first (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../dist/http.js";

const HOST = "acme.mcp.systemdox.com";

function event(body = { jsonrpc: "2.0", method: "tools/list", id: 1 }) {
  return {
    httpMethod: "POST",
    path: "/mcp",
    headers: {
      host: HOST,
      authorization: "Bearer pweb_test_key",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { tenant_slug: "acme" } },
  };
}

async function withApiUrl(url, fn) {
  const prev = process.env.SYSTEMDOX_API_URL;
  process.env.SYSTEMDOX_API_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SYSTEMDOX_API_URL;
    else process.env.SYSTEMDOX_API_URL = prev;
  }
}

test("hosted handler refuses a cleartext http SYSTEMDOX_API_URL", async () => {
  const res = await withApiUrl("http://api.example.com/systemdox", () =>
    handler(event())
  );
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error.message, /https/);
});

// Loopback is listed explicitly and kept as an assertion so that re-adding a
// carve-out has to delete a test that says why it exists.
test("hosted handler refuses http on loopback too — the pin has no exceptions", async () => {
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:8787/systemdox",
    "http://[::1]:9000",
  ]) {
    const res = await withApiUrl(url, () => handler(event()));
    assert.equal(res.statusCode, 500, `expected ${url} to be rejected`);
    assert.match(JSON.parse(res.body).error.message, /https/);
  }
});

test("hosted handler refuses a host that only looks like loopback", async () => {
  const res = await withApiUrl("http://127.0.0.1.evil.com/systemdox", () =>
    handler(event())
  );
  assert.equal(res.statusCode, 500);
});

test("hosted handler refuses a non-http(s) scheme", async () => {
  const res = await withApiUrl("ftp://api.example.com/systemdox", () =>
    handler(event())
  );
  assert.equal(res.statusCode, 500);
});

// An https URL must still be accepted — the pin must not break the happy path.
// No network call is made: tools/list is served by the server itself.
test("hosted handler accepts an https SYSTEMDOX_API_URL", async () => {
  const res = await withApiUrl("https://api.example.com/systemdox", () =>
    handler(event())
  );
  assert.notEqual(res.statusCode, 500);
});

// The tenant/auth gates run BEFORE the URL check, so they must keep their own
// status codes rather than being masked by the 500 above.
test("tenant mismatch still 403s regardless of API URL", async () => {
  const ev = event();
  ev.requestContext.authorizer.tenant_slug = "other";
  const res = await withApiUrl("http://api.example.com/systemdox", () =>
    handler(ev)
  );
  assert.equal(res.statusCode, 403);
});

test("missing bearer key still 401s regardless of API URL", async () => {
  const ev = event();
  delete ev.headers.authorization;
  const res = await withApiUrl("http://api.example.com/systemdox", () =>
    handler(ev)
  );
  assert.equal(res.statusCode, 401);
});
