/**
 * What the OAuth routes and `POST /connect` share about an API Gateway request
 * (ADR-229): the event, the answer, and where the request really arrived.
 */

export interface ApiGatewayEvent {
  httpMethod: string;
  path: string;
  /** The template's route: the same on every host, whatever base path mapped it. */
  resource?: string;
  headers: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded: boolean;
  requestContext?: {
    /** Set by API Gateway. A client can neither add nor change it. */
    domainName?: string;
    authorizer?: Record<string, string | undefined>;
  };
}

export interface ApiGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const MCP_HOST_SUFFIX_DEFAULT = "mcp.systemdox.com";

/** A DNS label: what a workspace slug can be. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function lowercaseHeaders(
  headers: Record<string, string | undefined> | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

export function rawBody(event: ApiGatewayEvent): string {
  return event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
}

/** The host a request arrived on, as the gateway saw it (`contract.md` §1), and never a header. */
function requestHost(event: ApiGatewayEvent): string {
  return (event.requestContext?.domainName ?? "").toLowerCase();
}

/**
 * The MCP host a request arrived on, or null anywhere else: the API domain and
 * execute-api reach the same stage, and these routes must not answer there.
 * Every label answers alike, so it says nothing about which workspaces exist.
 */
export function mcpHost(event: ApiGatewayEvent): { host: string; label: string; issuer: string } | null {
  const suffix = `.${process.env.MCP_HOST_SUFFIX ?? MCP_HOST_SUFFIX_DEFAULT}`;
  const host = requestHost(event);
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return LABEL.test(label) ? { host, label, issuer: `https://${host}` } : null;
}

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): ApiGatewayResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** The answer on any host that is not an MCP host (`openapi.yaml` NotOnThisHost). */
export const notOnThisHost = (): ApiGatewayResult => json(404, { error: "not_found" });

export function oauthError(statusCode: number, error: string, description?: string): ApiGatewayResult {
  return json(statusCode, description ? { error, error_description: description } : { error }, {
    "Cache-Control": "no-store",
  });
}
