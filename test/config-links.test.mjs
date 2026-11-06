// Unit tests for the empty-state config links (src/lib/config-links.ts).
// Offline: a fake API client stands in for the SystemDox REST API. Build first
// (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { configLink, workspaceBase } from "../dist/lib/config-links.js";

function fakeClient(response) {
  return {
    get: async (path) => {
      assert.equal(path, "/v1/docs/portal-access");
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("workspaceBase resolves the tenant app URL from the portal host", async () => {
  // The portal host is {slug}.{DOCS_DOMAIN}; only the slug carries over.
  const base = await workspaceBase(fakeClient({ host: "acme.kb.systemdox.com" }));
  assert.equal(base, "https://acme.systemdox.com");
});

test("workspaceBase is null when the portal host is missing or empty", async () => {
  assert.equal(await workspaceBase(fakeClient({})), null);
  assert.equal(await workspaceBase(fakeClient({ host: "" })), null);
});

test("workspaceBase is null when the endpoint is unavailable", async () => {
  const base = await workspaceBase(fakeClient(new Error("403")));
  assert.equal(base, null);
});

test("configLink builds a full URL when the base is known", () => {
  assert.equal(
    configLink("/docs/tech-stack", "https://acme.systemdox.com"),
    "https://acme.systemdox.com/docs/tech-stack"
  );
});

test("configLink falls back to the in-app path", () => {
  assert.equal(
    configLink("/docs/tech-stack", null),
    "/docs/tech-stack in your SystemDox workspace"
  );
});
