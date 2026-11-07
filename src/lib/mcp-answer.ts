/**
 * One MCP request, answered by a fresh server over a web-standard transport (no
 * sessions): what `POST /mcp` and `POST /connect` have in common. It fits Lambda's
 * execution model, and each caller keeps its own way of proving who is asking.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, type ServerOptions } from "../server.js";
import type { SystemDoxApiClient } from "./api-client.js";
import { sessionInstructions } from "./session-brief.js";

interface Answer {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Whether this POST opens a session: the one request that carries `instructions`. */
function opensSession(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as { method?: unknown } | { method?: unknown }[];
    return (Array.isArray(parsed) ? parsed : [parsed]).some((m) => m?.method === "initialize");
  } catch {
    return false;
  }
}

export async function answerMcpRequest(
  apiClient: SystemDoxApiClient,
  request: { url: string; headers: Record<string, string>; rawBody: string },
  options: Pick<ServerOptions, "access"> = {}
): Promise<Answer> {
  const { url, rawBody } = request;
  const headers = { ...request.headers };
  // Only a session's first request reads the team setup (ADR-223): every other
  // POST of a stateless server would pay for an answer nobody reads.
  const instructions = opensSession(rawBody) ? await sessionInstructions(apiClient) : undefined;
  const server = createServer(apiClient, { instructions, ...options });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — every POST is independent
    enableJsonResponse: true,
  });

  // The Streamable HTTP transport rejects any POST whose Accept header does
  // not list BOTH application/json and text/event-stream (406), and whose
  // Content-Type is not application/json (415) — both checked before it
  // honours enableJsonResponse. We run stateless JSON-only, so satisfy both
  // gates regardless of what the client sent (some clients send only JSON).
  headers["accept"] = "application/json, text/event-stream";
  if (!(headers["content-type"] ?? "").includes("application/json")) {
    headers["content-type"] = "application/json";
  }

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(url, { method: "POST", headers, body: rawBody }));
    // API Gateway REST buffers the whole response, so hop-by-hop / streaming
    // headers (transfer-encoding, connection, content-length) would be wrong
    // here. Forward only the JSON content-type (and mcp-session-id in case
    // sessions are ever enabled) rather than copying every SDK header.
    const FORWARD = new Set(["content-type", "mcp-session-id"]);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (FORWARD.has(key.toLowerCase())) responseHeaders[key] = value;
    });
    if (!("content-type" in responseHeaders)) {
      responseHeaders["content-type"] = "application/json";
    }
    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: await response.text(),
    };
  } finally {
    // Best-effort cleanup — log rather than swallow so close failures surface
    // in CloudWatch instead of disappearing.
    void transport.close().catch((err) => console.error("MCP transport close failed:", err));
    void server.close().catch((err) => console.error("MCP server close failed:", err));
  }
}
