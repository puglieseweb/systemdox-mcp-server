/**
 * Tool names are a public API: they are pinned in `.mcp.json` files and agent
 * permission allowlists that customers have already committed to their own
 * repositories. A rename is therefore additive — the new name is registered
 * alongside the old one, and the old one keeps working.
 *
 * Nothing is removed before this date, and then only once usage telemetry shows
 * no calls against the legacy name.
 */
export const LEGACY_TOOL_REMOVAL_EARLIEST = "2027-01-31";

export function legacyToolDescription(
  canonical: string,
  description: string
): string {
  return (
    `DEPRECATED — use \`${canonical}\` instead. This name still works and will ` +
    `not be removed before ${LEGACY_TOOL_REMOVAL_EARLIEST}. ${description}`
  );
}
