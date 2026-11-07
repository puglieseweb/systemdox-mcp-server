/**
 * Hosted MCP entry point — AWS Lambda behind API Gateway (REST), serving
 * MCP Streamable HTTP in stateless mode at https://{tenant}.mcp.systemdox.com/mcp
 * (specs/archive/tenant-url-structure, Phase 5).
 *
 * Each POST is handled by a fresh server + web-standard transport (no
 * sessions), which fits Lambda's execution model. Authentication is the
 * platform API key: API Gateway's PwebAuthoriser validates it before this
 * handler runs and puts the tenant in the authorizer context; the handler
 * additionally enforces that the key's tenant matches the subdomain tenant,
 * then uses the same key for the tool calls against the REST API — the
 * hosted server acts strictly as the caller.
 */

import { SystemDoxApiClient } from "./lib/api-client.js";
import { API_URL_DEFAULT, requireHttpsApiUrl } from "./lib/config.js";
import { answerMcpRequest } from "./lib/mcp-answer.js";
import { emitMcpToolCalls } from "./lib/metrics.js";

const MCP_HOST_SUFFIX = ".mcp.systemdox.com";

interface ApiGatewayEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded: boolean;
  requestContext?: {
    authorizer?: Record<string, string | undefined>;
  };
}

interface ApiGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function lowercaseHeaders(
  headers: Record<string, string | undefined> | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

function jsonError(statusCode: number, message: string): ApiGatewayResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  };
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
  const headers = lowercaseHeaders(event.headers);

  // Tenant scoping: on {tenant}.mcp.systemdox.com the API key's tenant
  // (resolved by the API Gateway authorizer) must own the subdomain.
  const host = (headers["host"] ?? "").toLowerCase();
  const keyTenant = event.requestContext?.authorizer?.tenant_slug ?? "";
  if (host.endsWith(MCP_HOST_SUFFIX)) {
    const hostTenant = host.slice(0, -MCP_HOST_SUFFIX.length);
    if (!hostTenant || hostTenant.includes(".") || hostTenant !== keyTenant) {
      return jsonError(403, "API key does not belong to this tenant");
    }
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed — stateless server, POST only" },
        id: null,
      }),
    };
  }

  // API Gateway's PwebAuthoriser only accepts the key via the Authorization
  // header (its sole identity source), so a hosted request always arrives as
  // `Authorization: Bearer pweb_...`. We reuse that same key to call the REST
  // API for tool invocations — the hosted server acts strictly as the caller.
  const authHeader = headers["authorization"] ?? "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!apiKey) {
    return jsonError(401, "Missing bearer API key");
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  // Per-tenant usage telemetry (EMF). Deliberately after the auth/tenant
  // gates — rejected requests never count toward activation.
  emitMcpToolCalls(keyTenant, rawBody);

  // The https pin applies here exactly as it does to the CLI: this path
  // forwards the CUSTOMER's bearer key to the REST API, so a non-https
  // SYSTEMDOX_API_URL would leak their key on the wire. Reading the env var
  // raw bypassed the pin — it must stay behind requireHttpsApiUrl(), and no
  // exception (loopback included) may be reintroduced for this path.
  let apiUrl: string;
  try {
    apiUrl = requireHttpsApiUrl(process.env.SYSTEMDOX_API_URL ?? API_URL_DEFAULT);
  } catch (err) {
    // Misconfiguration, not a client error — fail closed rather than downgrade.
    console.error("Refusing to proxy MCP tool calls:", err);
    return jsonError(500, "Server misconfigured: API URL must use https://");
  }

  const apiClient = new SystemDoxApiClient({
    apiKey,
    apiUrl,
    cacheTtlMs: 0, // per-request client; never cache across invocations
    defaultOrg: undefined,
  });

  return answerMcpRequest(apiClient, {
    url: `https://${host || "localhost"}${event.path || "/mcp"}`,
    headers,
    rawBody,
  });
}
