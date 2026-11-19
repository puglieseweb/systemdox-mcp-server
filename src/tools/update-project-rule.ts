import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface SavedRule {
  id: string;
  text: string;
  category: string;
  createdAt: string;
}

const refused = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

export function registerUpdateProjectRule(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "update_project_rule",
    {
      title: "Update Project Rule",
      description:
        "Change a project rule in SystemDox Standards by its id (get_project_rules shows each rule's id). Give new words, a new category, or both; the rule keeps its id. Use this when a rule is out of date or filed under the wrong category.",
      inputSchema: {
        id: z.string().describe("The rule's id, as get_project_rules shows it (e.g. 'rul_…')"),
        text: z
          .string()
          .optional()
          .describe("The rule's new words — one enforceable principle, not blank"),
        category: z
          .enum(["deployment", "architecture", "security", "testing", "process", "other"])
          .optional()
          .describe("The rule's new category"),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ id, text, category }) => {
      if (text === undefined && category === undefined) {
        return refused(`Give new words (text) or a category to change rule ${id}.`);
      }
      if (text !== undefined && text.trim() === "") {
        return refused("A rule's words cannot be empty.");
      }

      let saved: SavedRule;
      try {
        saved = await apiClient.put<SavedRule>(
          `/v1/standards/rules/${encodeURIComponent(id)}`,
          { ...(text !== undefined ? { text } : {}), ...(category !== undefined ? { category } : {}) }
        );
      } catch (err) {
        if ((err as { status?: unknown }).status === 404) {
          return refused(`No project rule ${id} in this workspace.`);
        }
        throw err;
      }

      apiClient.invalidateCache("/v1/standards/rules");

      return {
        content: [
          {
            type: "text" as const,
            text: `Project rule updated: **${saved.text}** (id: ${saved.id}, category: ${saved.category})`,
          },
        ],
      };
    }
  );
}
