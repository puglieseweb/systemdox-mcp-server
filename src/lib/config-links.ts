import type { SystemDoxApiClient } from "./api-client.js";

interface PortalAccessResponse {
  host?: string;
}

/**
 * The tenant's workspace base URL (https://{slug}.systemdox.com), or null
 * when it can't be resolved. The slug is the first label of the portal host
 * that GET /v1/docs/portal-access reports — the API builds that host as
 * `{slug}.{DOCS_DOMAIN}`, so the first label is the slug whichever docs
 * domain is live. The GET goes through the api client's response cache, so
 * repeated empty states don't re-fetch.
 */
export async function workspaceBase(
  apiClient: SystemDoxApiClient
): Promise<string | null> {
  try {
    const access = await apiClient.get<PortalAccessResponse>(
      "/v1/docs/portal-access"
    );
    const slug = (access.host ?? "").split(".")[0];
    return slug ? `https://${slug}.systemdox.com` : null;
  } catch {
    // Restricted key or older API — fall back to the path-only hint.
    return null;
  }
}

/**
 * Where to add missing configuration: a full URL when the workspace base is
 * known, the in-app path otherwise.
 *
 * Mirrored by apps/app/src/pages/ai/mcpPreview.ts — keep the output
 * byte-identical when either side changes.
 */
export function configLink(path: string, base: string | null): string {
  return base ? `${base}${path}` : `${path} in your SystemDox workspace`;
}
