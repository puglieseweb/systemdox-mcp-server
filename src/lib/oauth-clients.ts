/**
 * Which clients may connect (`contract.md` §2): the redirect rule, the signed
 * client id that DCR hands out, and the client metadata document (CIMD).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CIMD_HOST = "claude.ai";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LOOPBACK_PATH = "/callback";

const CLIENT_ID_PREFIX = "sdxc_";
export const MAX_CLIENT_ID = 4096;

const CIMD_TIMEOUT_MS = 3_000;
const CIMD_MAX_BYTES = 16 * 1024;
const CIMD_CACHE_MS = 3_600_000;
const CIMD_CACHE_ENTRIES = 100;

/** The stack's allow-list: exact redirect addresses, and the hosts of their CIMD documents. */
function allowList(): string[] {
  return (process.env.MCP_CLIENT_ALLOW_LIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A client states its own name, and a person reads it on the approval page, so
 * it may not hold what makes text read other than it is: control characters,
 * line separators, and format characters such as a right-to-left override.
 */
export const cleanClientName = (name: string): string => name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isLoopback(redirectUri: string): boolean {
  const url = parseUrl(redirectUri);
  return (
    !!url &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.pathname === LOOPBACK_PATH &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

export function redirectAllowed(redirectUri: string): boolean {
  return redirectUri === CLAUDE_CALLBACK || isLoopback(redirectUri) || allowList().includes(redirectUri);
}

/** A loopback redirect's port changes every session, so it is not compared. */
function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  if (!isLoopback(registered) || !isLoopback(asked)) return false;
  return new URL(registered).hostname === new URL(asked).hostname;
}

/** The host a person is shown, and that a connection is kept against. */
export const returnHostOf = (redirectUri: string): string => new URL(redirectUri).hostname;

export interface Client {
  clientId: string;
  name: string;
  /** True only for a name read from a CIMD document we fetched. */
  verified: boolean;
  redirectUris: string[];
}

function signature(payload: string, key: string): Buffer {
  return createHmac("sha256", key).update(`client-id|${payload}`).digest();
}

/** The same name and redirects always sign to the same id, so no row is kept. */
export function signClientId(name: string, redirectUris: string[], key: string): string {
  const payload = Buffer.from(JSON.stringify({ n: name, r: redirectUris })).toString("base64url");
  return `${CLIENT_ID_PREFIX}${payload}.${signature(payload, key).toString("base64url")}`;
}

function verifySignedClient(clientId: string, key: string): Client | null {
  const [payload, sent, extra] = clientId.slice(CLIENT_ID_PREFIX.length).split(".");
  if (!payload || !sent || extra !== undefined) return null;
  const expected = signature(payload, key);
  const given = Buffer.from(sent, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { n, r } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n?: unknown; r?: unknown };
    if (typeof n !== "string" || !Array.isArray(r) || !r.every((uri) => typeof uri === "string")) return null;
    return { clientId, name: n, verified: false, redirectUris: r as string[] };
  } catch {
    return null;
  }
}

function cimdHostAllowed(host: string): boolean {
  return host === CIMD_HOST || allowList().some((entry) => parseUrl(entry)?.hostname === host);
}

const cimdCache = new Map<string, { client: Client; until: number }>();

/** Reads at most `limit` bytes, so a document cannot be made to fill the function. */
async function readLimited(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchCimdClient(clientId: string): Promise<Client | null> {
  const res = await fetch(clientId, {
    redirect: "manual",
    signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (res.status !== 200) return null;
  const text = await readLimited(res, CIMD_MAX_BYTES);
  if (text === null) return null;
  const doc = JSON.parse(text) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
  if (doc.client_id !== clientId) return null;
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((uri) => typeof uri === "string")) return null;
  return {
    clientId,
    name: typeof doc.client_name === "string" ? cleanClientName(doc.client_name) : "",
    verified: typeof doc.client_name === "string",
    redirectUris: doc.redirect_uris as string[],
  };
}

async function cimdClient(clientId: string, now: number): Promise<Client | null> {
  const url = parseUrl(clientId);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (!cimdHostAllowed(url.hostname)) return null;
  const cached = cimdCache.get(clientId);
  if (cached && cached.until > now) return cached.client;
  let client: Client | null;
  try {
    client = await fetchCimdClient(clientId);
  } catch {
    return null; // Timed out, unreachable or not JSON: not a client we can trust.
  }
  if (!client) return null;
  if (cimdCache.size >= CIMD_CACHE_ENTRIES) cimdCache.delete(cimdCache.keys().next().value as string);
  cimdCache.set(clientId, { client, until: now + CIMD_CACHE_MS });
  return client;
}

/** The client named by a `client_id`, or null when it cannot be trusted. */
export async function resolveClient(clientId: string, signingKey: () => Promise<string>, now: number): Promise<Client | null> {
  if (clientId.length > MAX_CLIENT_ID) return null;
  if (clientId.startsWith(CLIENT_ID_PREFIX)) return verifySignedClient(clientId, await signingKey());
  return cimdClient(clientId, now);
}

/** Whether this client may return to this address, checked again at every use. */
export function clientMayReturnTo(client: Client, redirectUri: string): boolean {
  return redirectAllowed(redirectUri) && client.redirectUris.some((uri) => sameRedirect(uri, redirectUri));
}
