import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

export function registerDeleteProjectRule(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "delete_project_rule",
    {
      title: "Delete Project Rule",
      description:
        "Delete a project rule from SystemDox Standards by its id (get_project_rules shows each rule's id). Use this when a rule no longer holds; no session sees it afterwards.",
      inputSchema: {
        id: z.string().describe("The rule's id, as get_project_rules shows it (e.g. 'rul_…')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async ({ id }) => {
      try {
        await apiClient.delete<{ deleted: boolean }>(`/v1/standards/rules/${encodeURIComponent(id)}`);
      } catch (err) {
        if ((err as { status?: unknown }).status === 404) {
          return {
            content: [{ type: "text" as const, text: `No project rule ${id} in this workspace.` }],
            isError: true,
          };
        }
        throw err;
      }

      apiClient.invalidateCache("/v1/standards/rules");

      return {
        content: [{ type: "text" as const, text: `Project rule deleted: ${id}` }],
      };
    }
  );
}
