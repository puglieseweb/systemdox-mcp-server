// Unit tests for config https-pinning (src/lib/config.ts).
// The API key is sent as a bearer token, so the API URL must be https:// —
// a non-https URL must fail closed rather than leak the key in cleartext.
// Build first (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  requireHttpsApiUrl,
  loadConfig,
  API_URL_DEFAULT,
} from "../dist/lib/config.js";

test("requireHttpsApiUrl accepts an https URL unchanged", () => {
  assert.equal(
    requireHttpsApiUrl("https://api.example.com/systemdox"),
    "https://api.example.com/systemdox"
  );
  assert.equal(requireHttpsApiUrl(API_URL_DEFAULT), API_URL_DEFAULT);
});

test("requireHttpsApiUrl rejects an http URL (would leak the bearer key)", () => {
  assert.throws(
    () => requireHttpsApiUrl("http://api.example.com/systemdox"),
    /https/
  );
});

test("requireHttpsApiUrl rejects a non-URL value", () => {
  assert.throws(() => requireHttpsApiUrl("not-a-url"));
});

// The pin has no exceptions. Loopback is listed explicitly, and kept as a test
// rather than deleted, so re-adding a carve-out has to delete an assertion that
// says why it exists instead of quietly slipping past CI.
test("requireHttpsApiUrl rejects http on loopback too — the pin has no exceptions", () => {
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:8787/systemdox",
    "http://[::1]:9000",
  ]) {
    assert.throws(() => requireHttpsApiUrl(url), /https/, `expected ${url} to be rejected`);
  }
});

// Hosts that merely start with a loopback literal must be rejected as well —
// they are remote, and a substring-based check would have let them through.
test("requireHttpsApiUrl rejects http on a host that only looks like loopback", () => {
  for (const url of [
    "http://127.0.0.1.evil.com/systemdox",
    "http://localhost.evil.com",
    "http://notlocalhost",
  ]) {
    assert.throws(() => requireHttpsApiUrl(url), /https/, `expected ${url} to be rejected`);
  }
});

test("requireHttpsApiUrl rejects a non-http(s) scheme", () => {
  assert.throws(() => requireHttpsApiUrl("ftp://localhost/systemdox"), /https/);
});

test("loadConfig rejects a non-https SYSTEMDOX_API_URL", () => {
  const prevKey = process.env.SYSTEMDOX_API_KEY;
  const prevUrl = process.env.SYSTEMDOX_API_URL;
  process.env.SYSTEMDOX_API_KEY = "test-key";
  process.env.SYSTEMDOX_API_URL = "http://insecure.example.com";
  try {
    assert.throws(() => loadConfig(), /https/);
  } finally {
    if (prevKey === undefined) delete process.env.SYSTEMDOX_API_KEY;
    else process.env.SYSTEMDOX_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.SYSTEMDOX_API_URL;
    else process.env.SYSTEMDOX_API_URL = prevUrl;
  }
});

test("loadConfig rejects an http loopback SYSTEMDOX_API_URL", () => {
  const prevKey = process.env.SYSTEMDOX_API_KEY;
  const prevUrl = process.env.SYSTEMDOX_API_URL;
  process.env.SYSTEMDOX_API_KEY = "test-key";
  process.env.SYSTEMDOX_API_URL = "http://127.0.0.1:8787";
  try {
    assert.throws(() => loadConfig(), /https/);
  } finally {
    if (prevKey === undefined) delete process.env.SYSTEMDOX_API_KEY;
    else process.env.SYSTEMDOX_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.SYSTEMDOX_API_URL;
    else process.env.SYSTEMDOX_API_URL = prevUrl;
  }
});

test("loadConfig accepts an https SYSTEMDOX_API_URL", () => {
  const prevKey = process.env.SYSTEMDOX_API_KEY;
  const prevUrl = process.env.SYSTEMDOX_API_URL;
  process.env.SYSTEMDOX_API_KEY = "test-key";
  process.env.SYSTEMDOX_API_URL = "https://secure.example.com/systemdox";
  try {
    const cfg = loadConfig();
    assert.equal(cfg.apiUrl, "https://secure.example.com/systemdox");
  } finally {
    if (prevKey === undefined) delete process.env.SYSTEMDOX_API_KEY;
    else process.env.SYSTEMDOX_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.SYSTEMDOX_API_URL;
    else process.env.SYSTEMDOX_API_URL = prevUrl;
  }
});
