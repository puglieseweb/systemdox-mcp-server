// Ten representative coding tasks, spread across the surfaces a SystemDox tenant
// actually documents: backend handlers, infra, console UI, docs publishing, the
// MCP server itself.
//
// `expect` lists substrings a human says the returned context MUST contain for
// the retrieval to have been useful. They are only meaningful against the
// offline fixture tenant (eval/fixtures/tenant.json) — a live tenant's content
// is unknown to this file, so `--live` reports metrics without pass/fail.
export const tasks = [
  {
    id: "prefs-endpoint",
    task: "add a REST endpoint for user preferences",
    files: ["backend/functions/prefs_api/app.py"],
    expect: ["resolve_principal", "tenant_pk"],
  },
  {
    id: "tenant-isolation-bug",
    task: "fix a tenant isolation bug where the specs list returns another workspace's rows",
    files: ["backend/functions/draft_api/app.py"],
    expect: ["TENANT#", "tenant"],
  },
  {
    id: "console-header",
    task: "add a dark-mode toggle to the console header",
    files: ["apps/app/src/components/layout/Header.tsx"],
    expect: ["header"],
  },
  {
    id: "docs-publish",
    task: "publish documentation to a new tenant subdomain",
    files: ["backend/functions/docs_publish_worker/app.py"],
    expect: ["docs", "publish"],
  },
  {
    id: "sam-route",
    task: "add a CloudFormation route and Lambda function to the backend stack",
    files: ["backend/template.yaml"],
    expect: ["route"],
  },
  {
    id: "mcp-tool",
    task: "wire a new tool into the MCP server and register it",
    files: ["packages/mcp-server/src/tools/get-widgets.ts"],
    expect: ["mcp"],
  },
  {
    id: "dynamo-migration",
    task: "migrate DynamoDB rows to the TENANT# partition scheme",
    files: ["backend/scripts/migrate_partitions.py"],
    expect: ["TENANT#"],
  },
  {
    id: "spec-authoring",
    task: "write a spec for the notifications feature following the shared-specs convention",
    files: ["specs/changes/notifications/requirements.md"],
    expect: ["RFC 2119"],
  },
  {
    id: "frontend-api-service",
    task: "add a typed API service for the preferences endpoint in the console app",
    files: ["apps/app/src/services/preferencesApi.ts"],
    expect: ["BaseApiService"],
  },
  {
    id: "auth-api-key",
    task: "debug why an API key request is rejected by the authoriser",
    files: ["backend/functions/draft_api/app.py"],
    expect: ["Authorization"],
  },
];
