import { defineConfig } from "tsup";
import { createRequire } from "node:module";

// The publish workflow rewrites package.json's version (auto-incrementing the
// patch from the latest mcp-v* tag) immediately before building, so reading it
// here is what keeps the version the server reports in its MCP handshake in
// step with the version actually published. Hardcoding it in server.ts drifted
// to 0.1.0 while npm was on 0.1.16.
const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

export default defineConfig({
  define: {
    __MCP_SERVER_VERSION__: JSON.stringify(version),
  },
  // context-builder and api-client are entry points, not merely bundled deps,
  // so the unit tests and the eval harness can drive get_context's real logic
  // without booting a transport.
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/http.ts",
    // The Lambda entry points of ADR-229, which the scenarios drive as built.
    "src/oauth.ts",
    "src/connect.ts",
    "src/lib/context-builder.ts",
    "src/lib/api-client.ts",
    // Entry point so the empty-state config-link unit tests can drive it
    // without a live server.
    "src/lib/config-links.ts",
    // Entry point so the https-pinning unit tests can drive requireHttpsApiUrl
    // and loadConfig without booting the server.
    "src/lib/config.ts",
    // Entry point so the EMF tool-call telemetry unit tests can drive the
    // envelope builder and body parser without a Lambda invocation.
    "src/lib/metrics.ts",
    // An entry point so the session brief's unit tests can drive what a session
    // is told against a fake API client and a temporary home folder.
    "src/lib/session-brief.ts",
    // And so they can connect a session to the real server, handshake included,
    // which index.ts would start on import.
    "src/server.ts",
    // An entry point (not merely bundled) so the section-grounding unit tests
    // can drive get_docs' chunk_id/section handling without a live server.
    "src/tools/get-docs.ts",
    // An entry point so the plan-board unit tests can drive its status
    // bucketing and response formatting against a fake API client.
    "src/tools/get-plan-board.ts",
    // An entry point so the change-page binder and the get_change contract
    // test drive the tool against a faked fetch (ADR-218).
    "src/tools/get-change.ts",
    // Entry points so the authored-skills unit tests drive the folder reader,
    // the install with its edit check, and the three tools against a fake API.
    "src/lib/skills.ts",
    "src/tools/skills.ts",
    "src/install-skill.ts",
    // Entry points so the team-setup unit tests drive the detector, the files
    // in a temporary HOME, plugin-path and the two tools against a fake API.
    "src/lib/person-values.ts",
    "src/lib/team-setup-files.ts",
    "src/plugin-path.ts",
    "src/tools/team-setup.ts",
    // The memory sync: its pure merge, and the command the tests drive with
    // an injected prompt and a fake API.
    "src/lib/memory-sync.ts",
    "src/sync-memory.ts",
    // The team setup that `setup` runs after the MCP server step.
    "src/setup-team.ts",
    // setup's first step (the MCP config entry, the key in credentials.json),
    // which the tests drive in a temporary HOME.
    "src/setup-mcp.ts",
  ],
  // Left out of dist: the published package does not depend on the AWS SDK, and
  // leaves these two entry points out. SAM bundles the SDK into the Lambdas from src.
  external: [/^@aws-sdk\//],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
