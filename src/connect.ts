/**
 * `POST /connect`: the MCP endpoint for a connection (ADR-229, contract.md §7).
 *
 * Public at the gateway, because a static gateway answer cannot name a workspace,
 * so this handler is the authentication: an opaque token, hashed and looked up,
 * for this host's connection. The API key behind it is decrypted for this request
 * only, and the tools then run exactly as they do on `POST /mcp`. Claude holds the
 * token and never the key, which is what keeps the MCP rule against passing a
 * client's token through to another service.
 */

import { DecryptCommand } from "@aws-sdk/client-kms";
import { awsDeps, secretKey, type AwsDeps } from "./lib/aws-deps.js";
import { SystemDoxApiClient, type ApiAnswer } from "./lib/api-client.js";
import { API_URL_DEFAULT, requireHttpsApiUrl } from "./lib/config.js";
import { ConnectionStore, sha256, type Connection, type TokenRow } from "./lib/connection-store.js";
import { answerMcpRequest } from "./lib/mcp-answer.js";
import { emitMcpToolCalls } from "./lib/metrics.js";
import {
  json,
  lowercaseHeaders,
  mcpHost,
  notOnThisHost,
  rawBody,
  type ApiGatewayEvent,
  type ApiGatewayResult,
} from "./lib/oauth-http.js";

const ACCESS_PREFIX = "sdxa_";

/** How long, and how often, a key must be refused before a connection ends. */
const REFUSED_FOR_MS = 3_600_000;
const REFUSED_CALLS = 3;

const SUSPENDED = new Set([
  "USER_SUSPENDED",
  "MEMBER_SUSPENDED",
  "MEMBERSHIP_REVOKED",
  "ORG_SUSPENDED",
  "ORG_PENDING_DELETION",
]);

const REFUSED_WORDS =
  "SystemDox refused this connection. If its key was revoked, or the service is down, try again later; " +
  "if it goes on, remove the connection and add it again.";
const SUSPENDED_WORDS =
  "Access to this SystemDox workspace is suspended. The connection is kept, and works again when access is restored.";

interface Host {
  host: string;
  label: string;
  issuer: string;
}

/** What starts sign-in: the header names this host's metadata. */
function signInFirst(host: Host): ApiGatewayResult {
  const metadata = `${host.issuer}/.well-known/oauth-protected-resource/connect`;
  return json(
    401,
    { error: "invalid_token", error_description: "Sign in to SystemDox." },
    { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` }
  );
}

const postOnly = (): ApiGatewayResult =>
  json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { Allow: "POST" });

/** What the REST API said about this connection's key during this request. */
class Refusals {
  succeeded = false;
  unauthorized = false;
  suspended = false;

  readonly hear = ({ status, code }: ApiAnswer): void => {
    if (status >= 200 && status < 300) this.succeeded = true;
    if (status === 401 && code === undefined) this.unauthorized = true;
    if (status === 403 && code !== undefined && SUSPENDED.has(code)) this.suspended = true;
  };
}

/** Each `tools/call` of the request, answered with these words as a tool error. */
function asToolError(answer: ApiGatewayResult, requestBody: string, words: string): ApiGatewayResult {
  try {
    const sent = JSON.parse(requestBody) as { id?: unknown; method?: unknown } | { id?: unknown; method?: unknown }[];
    const calls = new Set(
      (Array.isArray(sent) ? sent : [sent]).filter((m) => m?.method === "tools/call").map((m) => m.id)
    );
    const rewrite = (message: { id?: unknown }) =>
      calls.has(message.id)
        ? {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: words }], isError: true },
          }
        : message;
    const parsed = JSON.parse(answer.body) as { id?: unknown } | { id?: unknown }[];
    return { ...answer, body: JSON.stringify(Array.isArray(parsed) ? parsed.map(rewrite) : rewrite(parsed)) };
  } catch {
    return answer; // Not a JSON-RPC answer: nothing to say it in.
  }
}

export function createHandler(deps: () => AwsDeps): (event: ApiGatewayEvent) => Promise<ApiGatewayResult> {
  const macKey = secretKey(deps, "MCP_TOKEN_DERIVATION_KEY_SECRET_ARN");
  const store = () => new ConnectionStore(deps().ddb, macKey);

  /** The connection this request's token holds, on this host, or none. */
  async function connectionOf(
    headers: Record<string, string>,
    host: Host
  ): Promise<{ row: TokenRow; connection: Connection } | null> {
    const authorization = headers["authorization"] ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    const row = await store().token(sha256(token));
    const now = deps().now();
    if (!row || row.kind !== "access" || row.expiresAt <= now) return null;
    const connection = await store().connection(row.organisationId, row.connectionId);
    if (!connection || connection.label !== host.label || connection.expiresAt <= now) return null;
    return { row, connection };
  }

  /**
   * The key, for this request only. It is never logged or kept between calls. The
   * context comes from the checked token row, never from the connection row, so a
   * rewritten row cannot name another organisation's connection and have it opened.
   */
  async function openKey(connection: Connection, row: TokenRow): Promise<string> {
    const { Plaintext } = await deps().kms.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(connection.encryptedKey, "base64"),
        EncryptionContext: { organisation: row.organisationId, connection: row.connectionId },
      })
    );
    return Buffer.from(Plaintext as Uint8Array).toString("utf8");
  }

  /** A bare 401 cannot be told from an outage, so it ends nothing until confirmed. */
  async function keyRefused(connection: Connection, answer: ApiGatewayResult, body: string, host: Host): Promise<ApiGatewayResult> {
    const now = deps().now();
    const noted = await store().noteKeyRefused(connection, now);
    if (!noted) return signInFirst(host);
    const refusedFor = now - (noted.keyRefusedAt ?? now);
    if (refusedFor > REFUSED_FOR_MS && (noted.keyRefusedCalls ?? 0) >= REFUSED_CALLS) {
      await store().endConnection(connection);
      return signInFirst(host);
    }
    return asToolError(answer, body, REFUSED_WORDS);
  }

  const post = async (event: ApiGatewayEvent, host: Host): Promise<ApiGatewayResult> => {
    const headers = lowercaseHeaders(event.headers);
    const held = await connectionOf(headers, host);
    if (!held) return signInFirst(host);
    const { row, connection } = held;
    const body = rawBody(event);

    // Per-tenant usage telemetry, as `/mcp`: after the gate, so a refused
    // request never counts toward activation.
    emitMcpToolCalls(host.label, body);

    // The https pin, as `/mcp`: this path sends a customer's key to the REST API.
    const apiUrl = requireHttpsApiUrl(process.env.SYSTEMDOX_API_URL ?? API_URL_DEFAULT);
    const refusals = new Refusals();
    const apiClient = new SystemDoxApiClient({
      apiKey: await openKey(connection, row),
      apiUrl,
      cacheTtlMs: 0, // per-request client; never cache across invocations
      defaultOrg: undefined,
      onAnswer: refusals.hear,
    });
    const answer = await answerMcpRequest(
      apiClient,
      { url: `${host.issuer}/connect`, headers, rawBody: body },
      { access: connection.access }
    );

    if (refusals.succeeded) {
      if (connection.keyRefusedAt !== undefined) await store().clearKeyRefused(connection);
      return answer;
    }
    if (refusals.unauthorized) return keyRefused(connection, answer, body, host);
    if (refusals.suspended) return asToolError(answer, body, SUSPENDED_WORDS);
    return answer;
  };

  /** Every route of this function; test_route_coverage.py reads these keys. */
  const routes: Record<string, (event: ApiGatewayEvent, host: Host) => Promise<ApiGatewayResult>> = {
    "POST /connect": post,
    "GET /connect": async () => postOnly(),
  };

  return async (event) => {
    const host = mcpHost(event);
    if (!host) return notOnThisHost();
    const route = routes[`${event.httpMethod} ${event.resource ?? event.path}`];
    if (!route) return notOnThisHost();
    try {
      return await route(event, host);
    } catch (err) {
      console.error("POST /connect failed:", (err as Error).name, (err as Error).message);
      return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };
}

export const handler = createHandler(awsDeps);
