import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface SavedRule {
  id: string;
  text: string;
  category: string;
  createdAt: string;
}

export function registerCreateProjectRule(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "create_project_rule",
    {
      title: "Create Project Rule",
      description:
        "Create a new project rule in SystemDox Standards. Use this when you discover a team principle or convention that should be enforced across the project.",
      inputSchema: {
        text: z
          .string()
          .describe(
            "The rule statement — one enforceable principle per rule (e.g. 'All deployments MUST go through GitHub Actions workflows')"
          ),
        category: z
          .enum(["deployment", "architecture", "security", "testing", "process", "other"])
          .describe("Rule category"),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ text, category }) => {
      const saved = await apiClient.post<SavedRule>(
        "/v1/standards/rules",
        { text, category }
      );

      apiClient.invalidateCache("/v1/standards/rules");

      return {
        content: [
          {
            type: "text" as const,
            text: `Project rule created: **${saved.text}** (id: ${saved.id}, category: ${saved.category})`,
          },
        ],
      };
    }
  );
}
