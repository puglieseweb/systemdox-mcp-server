import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

interface TechStackEntry {
  id: string;
  name: string;
  category: string;
  createdAt: string;
  version?: string;
  notes?: string;
}

export function registerGetTechStack(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_tech_stack",
    {
      title: "Get Tech Stack",
      description:
        "Retrieve the configured technology stack (languages, frameworks, databases, infrastructure) with versions and notes.",
    },
    async () => {
      const stack = await apiClient.get<TechStackEntry[]>(
        "/v1/ai/settings/stack"
      );

      if (stack.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tech stack entries configured. Add your stack at ${configLink("/docs/tech-stack", await workspaceBase(apiClient))}`,
            },
          ],
        };
      }

      const grouped = new Map<string, TechStackEntry[]>();
      for (const entry of stack) {
        const list = grouped.get(entry.category) ?? [];
        list.push(entry);
        grouped.set(entry.category, list);
      }

      const sections = Array.from(grouped.entries())
        .map(([category, entries]) => {
          const items = entries
            .map(
              (e) =>
                `- ${e.name}${e.version ? ` v${e.version}` : ""}${e.notes ? ` — ${e.notes}` : ""}`
            )
            .join("\n");
          return `### ${category}\n${items}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Tech stack (${stack.length} entries):\n\n${sections}`,
          },
        ],
      };
    }
  );
}
