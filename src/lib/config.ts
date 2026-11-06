export interface ServerConfig {
  apiKey: string;
  apiUrl: string;
  cacheTtlMs: number;
  defaultOrg: string | undefined;
}

export const API_URL_DEFAULT = "https://api.puglieseweb.com/systemdox";

/**
 * Fail closed on a non-https API URL. The API key travels as a bearer token in
 * the Authorization header on every request, so an http:// URL would leak it in
 * cleartext. Reject rather than downgrade. Returns the URL unchanged when valid.
 *
 * The pin has NO exceptions, loopback included. A carve-out was tried and
 * removed: it existed only because the release gate stood up a plain-http stub,
 * and #1044 gave that stub TLS, so nothing in CI needs it. Local development
 * against a local API should point at an https origin — the gate's per-run
 * self-signed cert is a worked example. An exception in the shipped product to
 * spare a dev a certificate is not a trade worth making.
 */
export function requireHttpsApiUrl(apiUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `SYSTEMDOX_API_URL is not a valid URL: ${apiUrl}`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `SYSTEMDOX_API_URL must use https:// — refusing to send the API key over ${parsed.protocol}// in cleartext. Got: ${apiUrl}`
    );
  }
  return apiUrl;
}

/** The server's settings from the environment. `apiKey` defaults to
 * SYSTEMDOX_API_KEY; the local server passes the key it resolved (that, then
 * ~/.claude/systemdox/credentials.json: `loadLocalConfig`). */
export function loadConfig(apiKey: string | undefined = process.env.SYSTEMDOX_API_KEY): ServerConfig {
  if (!apiKey) {
    throw new Error(
      "SYSTEMDOX_API_KEY is required. Generate one at your SystemDox settings page."
    );
  }

  const apiUrl = requireHttpsApiUrl(
    process.env.SYSTEMDOX_API_URL ?? API_URL_DEFAULT
  );

  return {
    apiKey,
    apiUrl,
    cacheTtlMs: parseInt(process.env.SYSTEMDOX_CACHE_TTL ?? "300", 10) * 1000,
    defaultOrg: process.env.SYSTEMDOX_DEFAULT_ORG,
  };
}
