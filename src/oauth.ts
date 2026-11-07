/**
 * How a client signs in to a workspace's MCP host (ADR-229): the metadata that
 * says how, DCR, the start of the authorization request and the token exchange,
 * and the two console routes that answer a pending request. The rules are
 * specs/changes/connect-mcp-by-sign-in/contract.md; the HTTP surface is the
 * openapi.yaml beside it.
 *
 * The OAuth routes are public at the gateway, so each answers only on an MCP
 * host, and alike on every label: nothing there says which workspaces exist. The
 * console's are behind PwebAuthoriser, and answer on the API.
 */

import { EncryptCommand } from "@aws-sdk/client-kms";
import { createHmac, randomBytes } from "node:crypto";
import { awsDeps, secretKey, type AwsDeps } from "./lib/aws-deps.js";
import {
  ConnectionStore,
  epochSeconds,
  newConnectionRow,
  newTokenRow,
  sha256,
  verifierMatches,
  type Access,
  type Connection,
  type PendingRequest,
  type TokenRow,
} from "./lib/connection-store.js";
import {
  MAX_CLIENT_ID,
  cleanClientName,
  clientMayReturnTo,
  isLoopback,
  redirectAllowed,
  resolveClient,
  returnHostOf,
  signClientId,
  type Client,
} from "./lib/oauth-clients.js";
import {
  json,
  MCP_HOST_SUFFIX_DEFAULT,
  lowercaseHeaders,
  mcpHost,
  notOnThisHost,
  oauthError,
  rawBody,
  type ApiGatewayEvent,
  type ApiGatewayResult,
} from "./lib/oauth-http.js";

const REQUEST_LIFETIME_MS = 600_000;
const CODE_LIFETIME_MS = 60_000;
const ACCESS_LIFETIME_MS = 3_600_000;
const REUSE_WINDOW_MS = 30_000;
const SCOPES = ["systemdox.read", "systemdox.write"];
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_REDIRECT = 2048;
const MAX_NAME = 80;
const MAX_REDIRECTS = 4;
const MAX_STATE = 1024;
const MAX_SCOPE = 256;

const CONSOLE_URL_DEFAULT = "https://app.systemdox.com";
const REQUEST_ID = /^cnr_[0-9a-z]{26}$/;
const KEY_NAME_LIMIT = 100;
const AUTH_API_TIMEOUT_MS = 15_000;

/**
 * shared-auth's preset `product-owner`, named scope by scope: the mint refuses a
 * label that disagrees with its scopes. `member` reads documents only, so the
 * checks and specs would come back empty. Read mode drops the write scopes.
 */
const CONNECTION_BINDING = {
  space: "*",
  scopes: ["build:read", "build:write", "capture:read", "capture:write", "docs:read"],
  preset: "product-owner",
};

const NOT_UNDERSTOOD = "That answer was not understood.";

/** The answers of `contract.md` §9. */
const CONSOLE_ERRORS = {
  gone: [404, "SYD-C001", "This request has expired. Start again from Claude."],
  otherWorkspace: [409, "SYD-C002", "You are signed in to another workspace."],
  secondFactor: [403, "SYD-C003", "Confirm your second factor."],
  notAnOwner: [403, "SYD-C004", "An owner or admin of this workspace has to connect."],
  notMinted: [502, "SYD-C005", "We could not finish that. Try again."],
  answered: [409, "SYD-C006", "This request was already answered."],
  narrower: [403, "SYD-C007", "Your own access in a space is narrower than a connection needs."],
} as const;

interface Host {
  host: string;
  label: string;
  issuer: string;
}

type Route = (event: ApiGatewayEvent, host: Host) => Promise<ApiGatewayResult>;
type ConsoleRoute = (event: ApiGatewayEvent) => Promise<ApiGatewayResult>;

/** What the gateway's authoriser put in the context: never the client's word. */
interface Principal {
  organisationId: string;
  userId: string;
  slug: string;
  role: string;
  support: boolean;
}

function principalOf(event: ApiGatewayEvent): Principal {
  const context = event.requestContext?.authorizer ?? {};
  return {
    organisationId: context.tenant_id ?? "",
    userId: context.user_id ?? "",
    slug: context.tenant_slug ?? "",
    role: context.role ?? "",
    support: context.access === "support",
  };
}

/** The API's exact-origin rule (layers/common/common/resolver.py): `*` is one label. */
function corsHeaders(event: ApiGatewayEvent): Record<string, string> {
  const origin = lowercaseHeaders(event.headers)["origin"];
  if (!origin) return {};
  const allowed = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const literal = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^./]+");
      return new RegExp(`^${literal}$`).test(origin);
    });
  return allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

function problem(
  event: ApiGatewayEvent,
  [status, code, detail]: readonly [number, string, string],
  reason?: string
): ApiGatewayResult {
  return json(status, { code, detail, ...(reason ? { reason } : {}) }, corsHeaders(event));
}

/** Crockford base32, lower case: a ULID as `openapi.yaml` spells a request id. */
function ulid(now: number): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let time = "";
  for (let rest = now, i = 0; i < 10; i += 1, rest = Math.floor(rest / 32)) {
    time = alphabet[rest % 32] + time;
  }
  const random = [...randomBytes(16)].map((byte) => alphabet[byte % 32]).join("");
  return time + random;
}

function protectedResource(host: Host): ApiGatewayResult {
  return json(200, {
    resource: `${host.issuer}/connect`,
    authorization_servers: [host.issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
  });
}

function authorizationServer(host: Host): ApiGatewayResult {
  return json(200, {
    issuer: host.issuer,
    authorization_endpoint: `${host.issuer}/oauth/authorize`,
    token_endpoint: `${host.issuer}/oauth/token`,
    registration_endpoint: `${host.issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
}

function parseRegistration(text: string): { name: string; redirects: string[] } | ApiGatewayResult {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", "The registration is not JSON.");
  }
  const { client_name: name = "", redirect_uris: redirects, token_endpoint_auth_method: method } = doc ?? {};
  if (typeof name !== "string" || name.length > MAX_NAME) {
    return oauthError(400, "invalid_client_metadata", "The client's name is not valid.");
  }
  if (method !== undefined && method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Only public clients can register.");
  }
  if (
    !Array.isArray(redirects) ||
    redirects.length < 1 ||
    redirects.length > MAX_REDIRECTS ||
    !redirects.every((uri) => typeof uri === "string" && uri.length <= MAX_REDIRECT)
  ) {
    return oauthError(400, "invalid_client_metadata", "The redirect addresses are not valid.");
  }
  if (!redirects.every((uri) => redirectAllowed(uri as string))) {
    return oauthError(400, "invalid_redirect_uri", "This address may not receive a connection.");
  }
  return { name: cleanClientName(name), redirects: redirects as string[] };
}

/** The page for a client or redirect we cannot trust. It echoes nothing it was sent. */
function untrusted(): ApiGatewayResult {
  return {
    statusCode: 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "no-store",
    },
    body:
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SystemDox</title></head>' +
      "<body><h1>This request cannot be trusted</h1>" +
      "<p>Nothing was connected. Start again from Claude.</p></body></html>",
  };
}

/** Back to a checked redirect, with `iss` on it as on every redirect (RFC 9207). */
function backToClient(redirectUri: string, params: Record<string, string | undefined>, issuer: string): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}

const redirectTo = (location: string): ApiGatewayResult => ({
  statusCode: 302,
  headers: { Location: location, "Cache-Control": "no-store" },
  body: "",
});

/** What a checked client asked for that it cannot have, as an RFC 6749 error. */
function refusal(query: Record<string, string | undefined>, host: Host): string | null {
  if (query.response_type !== "code") return "unsupported_response_type";
  if (query.code_challenge_method !== "S256" || !CHALLENGE.test(query.code_challenge ?? "")) return "invalid_request";
  if ((query.state?.length ?? 0) > MAX_STATE || (query.scope?.length ?? 0) > MAX_SCOPE) return "invalid_request";
  if (query.resource !== undefined && query.resource !== `${host.issuer}/connect`) return "invalid_target";
  return null;
}

async function keepRequest(
  store: ConnectionStore,
  now: number,
  client: Client,
  query: Record<string, string | undefined>,
  host: Host
): Promise<string> {
  const requestId = `cnr_${ulid(now)}`;
  const redirectUri = query.redirect_uri as string;
  await store.putRequest(requestId, {
    clientId: client.clientId,
    clientName: client.name,
    clientNameVerified: client.verified,
    redirectUri,
    returnHost: returnHostOf(redirectUri),
    loopback: isLoopback(redirectUri),
    challenge: query.code_challenge as string,
    ...(query.state === undefined ? {} : { state: query.state }),
    label: host.label,
    expiresAt: now + REQUEST_LIFETIME_MS,
    ttl: epochSeconds(now + REQUEST_LIFETIME_MS),
  });
  return requestId;
}

function authApiUrl(): string {
  const url = process.env.AUTH_API_URL;
  if (!url) throw new Error("AUTH_API_URL is not configured");
  return url.replace(/\/+$/, "");
}

/** `<client name> (<return host>) YYYY-MM-DD`, cut to the route's 100 characters. */
function keyName(request: PendingRequest, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${request.clientName || "Client"} (${request.returnHost}) ${day}`.slice(0, KEY_NAME_LIMIT);
}

interface MintedKey {
  keyId: string;
  key: string;
  expiresAt: string;
}

/** What the auth API answered. A body that is not JSON names no refusal, and says so in the log. */
async function answerOf(res: Response): Promise<Partial<MintedKey> & { code?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Partial<MintedKey> & { code?: string };
  } catch (err) {
    console.error("The key mint's answer is not JSON:", res.status, (err as Error).name);
    return {};
  }
}

/** The mint's answer: the key, or which of §5's refusals it is. */
async function mintKey(
  authorization: string,
  request: PendingRequest,
  access: Access,
  now: number
): Promise<MintedKey | { refused: keyof typeof CONSOLE_ERRORS; reason?: string }> {
  let res: Response;
  try {
    res = await fetch(`${authApiUrl()}/api-keys`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName(request, now),
        services: [],
        bindings: [CONNECTION_BINDING],
        mode: access,
      }),
      signal: AbortSignal.timeout(AUTH_API_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("The key mint did not answer:", (err as Error).name);
    return { refused: "notMinted" };
  }
  const body = await answerOf(res);
  if (res.ok && body.keyId && body.key && body.expiresAt) return body as MintedKey;
  switch (body.code) {
    case "insufficient_role":
    case "support_session_forbidden":
      return { refused: "notAnOwner" };
    case "aal2_required":
    case "step_up_required":
      return { refused: "secondFactor", reason: body.code };
    case "binding_exceeds_creator":
      return { refused: "narrower" };
    default:
      console.error("The key mint refused:", res.status, body.code ?? "no code");
      return { refused: "notMinted" };
  }
}

/** A failed revoke is only logged: the old key still expires, and is listed in Settings. */
async function revokeKey(authorization: string, keyId: string): Promise<void> {
  try {
    const res = await fetch(`${authApiUrl()}/api-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(AUTH_API_TIMEOUT_MS),
    });
    if (!res.ok) console.error("A replaced connection's key was not revoked:", res.status, keyId);
  } catch (err) {
    console.error("A replaced connection's key was not revoked:", (err as Error).name, keyId);
  }
}

/** The issuer of a request, answered on the API, away from its MCP host. */
const issuerOf = (request: PendingRequest): string =>
  `https://${request.label}.${process.env.MCP_HOST_SUFFIX ?? MCP_HOST_SUFFIX_DEFAULT}`;

const scopeOf = (access: Access): string =>
  access === "write" ? "systemdox.read systemdox.write" : "systemdox.read";

const invalidGrant = (): ApiGatewayResult => oauthError(400, "invalid_grant", "Sign in again.");

/** The record of a connection's life. It names rows, and never holds a token, a code or a key. */
function audit(
  level: "log" | "warn",
  name: string,
  { organisationId, connectionId }: Connection,
  fields: Record<string, unknown>
): void {
  console[level](JSON.stringify({ event: name, organisationId, connectionId, ...fields }));
}

export function createHandler(deps: () => AwsDeps): (event: ApiGatewayEvent) => Promise<ApiGatewayResult> {
  const clientKey = secretKey(deps, "MCP_CLIENT_SIGNING_KEY_SECRET_ARN");
  const pairKey = secretKey(deps, "MCP_TOKEN_DERIVATION_KEY_SECRET_ARN");
  const store = () => new ConnectionStore(deps().ddb, pairKey);

  /**
   * The pair a used code or refresh token gives, derived by HMAC from it, so a
   * retry returns the same pair with nothing stored in plaintext (§3).
   */
  async function issuePair(secret: string, connection: Connection): Promise<ApiGatewayResult> {
    const key = await pairKey();
    const derive = (purpose: string) => createHmac("sha256", key).update(`${purpose}|${secret}`).digest("base64url");
    const accessToken = `sdxa_${derive("access")}`;
    const refreshToken = `sdxr_${derive("refresh")}`;
    const now = deps().now();
    const fields = { organisationId: connection.organisationId, connectionId: connection.connectionId };
    const accessHash = sha256(accessToken);
    await store().putTokenOnce(
      accessHash,
      newTokenRow(accessHash, {
        ...fields,
        kind: "access",
        expiresAt: now + ACCESS_LIFETIME_MS,
        ttl: epochSeconds(now + ACCESS_LIFETIME_MS),
      })
    );
    const refreshHash = sha256(refreshToken);
    await store().putTokenOnce(
      refreshHash,
      newTokenRow(refreshHash, {
        ...fields,
        kind: "refresh",
        expiresAt: connection.expiresAt,
        ttl: connection.ttl,
      })
    );
    return json(
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_LIFETIME_MS / 1000,
        refresh_token: refreshToken,
        scope: scopeOf(connection.access),
      },
      { "Cache-Control": "no-store" }
    );
  }

  /** The connection a row belongs to, if it is alive and this host's. */
  async function liveConnection(row: TokenRow, host: Host): Promise<Connection | null> {
    const connection = await store().connection(row.organisationId, row.connectionId);
    if (!connection || connection.label !== host.label || connection.expiresAt <= deps().now()) return null;
    return connection;
  }

  /**
   * Spends a code or refresh token. Within 30 seconds of being spent it gives the
   * same pair, because clients retry. After that it ends the connection, as a
   * sign of theft.
   */
  async function spend(secret: string, row: TokenRow, connection: Connection): Promise<ApiGatewayResult> {
    const hash = sha256(secret);
    const now = deps().now();
    let replacedAt = row.replacedAt;
    if (replacedAt === undefined && !(await store().spendToken(hash, row, now))) {
      replacedAt = (await store().token(hash))?.replacedAt ?? now;
    }
    if (replacedAt !== undefined && now - replacedAt > REUSE_WINDOW_MS) {
      await store().endConnection(connection);
      audit("warn", "mcp.connection.ended", connection, { reason: "token_reused", kind: row.kind });
      return invalidGrant();
    }
    return issuePair(secret, connection);
  }

  async function exchangeCode(form: URLSearchParams, host: Host): Promise<ApiGatewayResult> {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const clientId = form.get("client_id");
    const verifier = form.get("code_verifier");
    if (!code || !redirectUri || !clientId || !verifier) {
      return oauthError(400, "invalid_request", "The request is missing a value.");
    }
    const row = await store().token(sha256(code));
    if (!row || row.kind !== "code" || !row.challenge) return invalidGrant();
    if (row.clientHash !== sha256(clientId) || row.redirectUri !== redirectUri) return invalidGrant();
    // Before anything else about the code: a wrong verifier changes nothing, so
    // an intercepted code cannot end a connection.
    if (!verifierMatches(verifier, row.challenge)) return invalidGrant();
    const connection = await liveConnection(row, host);
    if (!connection) return invalidGrant();
    if (row.replacedAt === undefined && row.expiresAt <= deps().now()) return invalidGrant();
    return spend(code, row, connection);
  }

  async function exchangeRefresh(form: URLSearchParams, host: Host): Promise<ApiGatewayResult> {
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (!refreshToken || !clientId) return oauthError(400, "invalid_request", "The request is missing a value.");
    const row = await store().token(sha256(refreshToken));
    if (!row || row.kind !== "refresh") return invalidGrant();
    const connection = await liveConnection(row, host);
    if (!connection || connection.clientHash !== sha256(clientId)) return invalidGrant();
    return spend(refreshToken, row, connection);
  }

  const token: Route = async (event, host) => {
    const form = new URLSearchParams(rawBody(event));
    const resource = form.get("resource");
    if (resource !== null && resource !== `${host.issuer}/connect`) {
      return oauthError(400, "invalid_target", "This token is for another address.");
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return exchangeCode(form, host);
    if (grant === "refresh_token") return exchangeRefresh(form, host);
    return grant
      ? oauthError(400, "unsupported_grant_type", "This grant is not supported.")
      : oauthError(400, "invalid_request", "The request names no grant.");
  };

  /** A live request, or none: the handler checks every expiry itself. */
  async function pendingRequest(event: ApiGatewayEvent): Promise<{ id: string; row: PendingRequest } | null> {
    const id = event.pathParameters?.requestId ?? "";
    if (!REQUEST_ID.test(id)) return null;
    const row = await store().request(id);
    // The MAC proves the row, and the rule is checked again at this use, as at
    // /oauth/authorize. What the person reads is derived from where the code goes.
    if (!row || row.expiresAt <= deps().now() || !redirectAllowed(row.redirectUri)) return null;
    return { id, row: { ...row, returnHost: returnHostOf(row.redirectUri), loopback: isLoopback(row.redirectUri) } };
  }

  const getConnectionRequest: ConsoleRoute = async (event) => {
    const pending = await pendingRequest(event);
    if (!pending) return problem(event, CONSOLE_ERRORS.gone);
    const { id, row } = pending;
    const principal = principalOf(event);
    return json(
      200,
      {
        requestId: id,
        clientName: row.clientName,
        clientNameVerified: row.clientNameVerified,
        returnHost: row.returnHost,
        loopback: row.loopback,
        workspace: row.label,
        activeWorkspace: principal.slug,
        canApprove: !principal.support && ["owner", "admin"].includes(principal.role),
        expiresAt: new Date(row.expiresAt).toISOString(),
      },
      corsHeaders(event)
    );
  };

  async function approve(event: ApiGatewayEvent, id: string, row: PendingRequest, access: Access): Promise<ApiGatewayResult> {
    const principal = principalOf(event);
    const now = deps().now();
    if (!(await store().claimRequest(id, now))) return problem(event, CONSOLE_ERRORS.answered);

    const authorization = lowercaseHeaders(event.headers)["authorization"] ?? "";
    const minted = await mintKey(authorization, row, access, now);
    if ("refused" in minted) {
      await store().releaseRequest(id);
      return problem(event, CONSOLE_ERRORS[minted.refused], minted.reason);
    }

    const connectionId = `mcn_${ulid(now)}`;
    const code = `sdxk_${randomBytes(32).toString("base64url")}`;
    try {
      const { CiphertextBlob } = await deps().kms.send(
        new EncryptCommand({
          KeyId: process.env.MCP_CONNECTION_KEY_ID,
          Plaintext: Buffer.from(minted.key),
          EncryptionContext: { organisation: principal.organisationId, connection: connectionId },
        })
      );
      const connection = newConnectionRow({
        connectionId,
        organisationId: principal.organisationId,
        ownerId: principal.userId,
        label: row.label,
        returnHost: row.returnHost,
        loopback: row.loopback,
        access,
        clientHash: sha256(row.clientId),
        keyId: minted.keyId,
        encryptedKey: Buffer.from(CiphertextBlob as Uint8Array).toString("base64"),
        expiresAt: Date.parse(minted.expiresAt),
      });
      // Kept with the connection, not for the code's 60 seconds: a code spent
      // twice has to be seen for what it is after the code would have run out.
      const codeHash = sha256(code);
      const codeRow = newTokenRow(codeHash, {
        organisationId: principal.organisationId,
        connectionId,
        kind: "code",
        expiresAt: now + CODE_LIFETIME_MS,
        ttl: connection.ttl,
        challenge: row.challenge,
        redirectUri: row.redirectUri,
        clientHash: connection.clientHash,
      });
      const previous = row.loopback
        ? []
        : (await store().connectionsOf(principal.userId, principal.organisationId)).filter(
            (old) => !old.loopback && old.returnHost === row.returnHost
          );
      await store().writeConnection(connection, codeHash, codeRow);
      // A loopback connection is never replaced: `localhost` is a different
      // computer each time.
      for (const old of previous) {
        await revokeKey(authorization, old.keyId);
        await store().endConnection(old);
      }
      audit("log", "mcp.connection.approved", connection, {
        returnHost: row.returnHost,
        loopback: row.loopback,
        access,
        replaced: previous.length,
      });
    } catch (err) {
      console.error("A connection was not stored:", (err as Error).name);
      await revokeKey(authorization, minted.keyId);
      await store().releaseRequest(id);
      return problem(event, CONSOLE_ERRORS.notMinted);
    }
    return json(
      200,
      { redirectTo: backToClient(row.redirectUri, { code, state: row.state }, issuerOf(row)) },
      corsHeaders(event)
    );
  }

  const answerConnectionRequest: ConsoleRoute = async (event) => {
    let answer: { decision?: unknown; access?: unknown };
    try {
      answer = JSON.parse(rawBody(event) || "{}") as typeof answer;
    } catch {
      return json(400, { detail: NOT_UNDERSTOOD }, corsHeaders(event));
    }
    const { decision, access = "read" } = answer ?? {};
    if ((decision !== "approve" && decision !== "decline") || (access !== "read" && access !== "write")) {
      return json(400, { detail: NOT_UNDERSTOOD }, corsHeaders(event));
    }
    const pending = await pendingRequest(event);
    if (!pending) return problem(event, CONSOLE_ERRORS.gone);
    const { id, row } = pending;
    if (principalOf(event).slug !== row.label) return problem(event, CONSOLE_ERRORS.otherWorkspace);
    if (decision === "approve") return approve(event, id, row, access);
    if (!(await store().deleteRequest(id))) return problem(event, CONSOLE_ERRORS.answered);
    return json(
      200,
      { redirectTo: backToClient(row.redirectUri, { error: "access_denied", state: row.state }, issuerOf(row)) },
      corsHeaders(event)
    );
  };

  const register: Route = async (event) => {
    const registration = parseRegistration(rawBody(event));
    if ("statusCode" in registration) return registration;
    const clientId = signClientId(registration.name, registration.redirects, await clientKey());
    if (clientId.length > MAX_CLIENT_ID) {
      return oauthError(400, "invalid_client_metadata", "The registration is too long.");
    }
    return json(
      201,
      {
        client_id: clientId,
        ...(registration.name ? { client_name: registration.name } : {}),
        redirect_uris: registration.redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { "Cache-Control": "no-store" }
    );
  };

  const authorize: Route = async (event, host) => {
    const query = event.queryStringParameters ?? {};
    const redirectUri = query.redirect_uri;
    if (!query.client_id || !redirectUri || redirectUri.length > MAX_REDIRECT) return untrusted();
    const client = await resolveClient(query.client_id, clientKey, deps().now());
    if (!client || !clientMayReturnTo(client, redirectUri)) return untrusted();
    const error = refusal(query, host);
    if (error) return redirectTo(backToClient(redirectUri, { error, state: query.state }, host.issuer));
    const requestId = await keepRequest(store(), deps().now(), client, query, host);
    const consoleUrl = process.env.CONSOLE_URL ?? CONSOLE_URL_DEFAULT;
    const approval = new URL("/approve-connection", consoleUrl);
    approval.searchParams.set("request", requestId);
    approval.searchParams.set("workspace", host.label);
    return redirectTo(approval.toString());
  };

  /** Every route of this function; test_route_coverage.py reads these keys. */
  const routes: Record<string, Route> = {
    "GET /.well-known/oauth-protected-resource/connect": async (_event, host) => protectedResource(host),
    "GET /.well-known/oauth-protected-resource": async (_event, host) => protectedResource(host),
    "GET /.well-known/oauth-authorization-server": async (_event, host) => authorizationServer(host),
    "POST /oauth/register": register,
    "GET /oauth/authorize": authorize,
    "POST /oauth/token": token,
  };

  /** Behind PwebAuthoriser, on the API: never an MCP host's. */
  const consoleRoutes: Record<string, ConsoleRoute> = {
    "GET /v1/connection-requests/{requestId}": getConnectionRequest,
    "POST /v1/connection-requests/{requestId}": answerConnectionRequest,
  };

  return async (event) => {
    const routeKey = `${event.httpMethod} ${event.resource ?? event.path}`;
    const consoleRoute = consoleRoutes[routeKey];
    if (consoleRoute) {
      try {
        return await consoleRoute(event);
      } catch (err) {
        console.error("Console route failed:", (err as Error).name, (err as Error).message);
        return problem(event, CONSOLE_ERRORS.notMinted);
      }
    }
    const host = mcpHost(event);
    if (!host) return notOnThisHost();
    const route = routes[routeKey];
    if (!route) return notOnThisHost();
    try {
      return await route(event, host);
    } catch (err) {
      console.error("OAuth route failed:", (err as Error).name, (err as Error).message);
      return oauthError(500, "server_error");
    }
  };
}

export const handler = createHandler(awsDeps);
