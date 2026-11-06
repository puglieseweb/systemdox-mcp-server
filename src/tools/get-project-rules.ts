import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

export interface ProjectRule {
  id: string;
  text: string;
  category: string;
  createdAt: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  deployment: "Deployment",
  architecture: "Architecture",
  security: "Security",
  testing: "Testing",
  process: "Process",
  other: "Other",
};

export function registerGetProjectRules(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_project_rules",
    {
      title: "Get Project Rules",
      description:
        "Retrieve project rules defined in SystemDox Standards. These are team-defined principles covering deployment, architecture, security, testing, and process. Filter by category to get only relevant rules.",
      inputSchema: {
        category: z
          .enum(["deployment", "architecture", "security", "testing", "process", "other"])
          .optional()
          .describe("Filter by rule category"),
      },
    },
    async ({ category }) => {
      const rules = await apiClient.get<ProjectRule[]>(
        "/v1/standards/rules"
      );

      let filtered = rules;

      if (category) {
        filtered = filtered.filter(
          (r) => r.category.toLowerCase() === category.toLowerCase()
        );
      }

      if (filtered.length === 0) {
        // Nothing configured at all → say where to start; rules exist but the
        // filter excluded them → keep naming the filter instead.
        const text =
          rules.length === 0
            ? `No project rules found. Add rules at ${configLink("/docs/rules", await workspaceBase(apiClient))}`
            : `No project rules found${category ? ` in category "${category}"` : ""}.`;
        return {
          content: [{ type: "text" as const, text }],
        };
      }

      // Group by category
      const grouped = new Map<string, ProjectRule[]>();
      for (const rule of filtered) {
        const cat = rule.category || "other";
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat)!.push(rule);
      }

      let text = `Found ${filtered.length} project rule(s):\n\n`;
      for (const [cat, catRules] of grouped) {
        const label = CATEGORY_LABELS[cat] ?? cat;
        text += `## ${label}\n\n`;
        for (const rule of catRules) {
          text += `- ${rule.text}\n`;
        }
        text += "\n";
      }

      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    }
  );
}
