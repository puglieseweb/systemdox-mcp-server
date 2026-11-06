import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  createdAt: string;
}

export function registerGetPromptTemplates(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_prompt_templates",
    {
      title: "Get Prompt Templates",
      description:
        "Retrieve reusable prompt templates from SystemDox Standards. These are preconfigured prompts that Gen AI should use when generating content — e.g. code review checklists, documentation templates, or analysis frameworks.",
      inputSchema: {},
    },
    async () => {
      const templates = await apiClient.get<PromptTemplate[]>(
        "/v1/standards/prompt-templates"
      );

      if (templates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No prompt templates found. Add templates at ${configLink("/docs/prompts", await workspaceBase(apiClient))}`,
            },
          ],
        };
      }

      const text = templates
        .map(
          (t) =>
            `## ${t.name}\n\n` +
            (t.description ? `*${t.description}*\n\n` : "") +
            `\`\`\`\n${t.prompt}\n\`\`\``
        )
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${templates.length} prompt template(s):\n\n${text}`,
          },
        ],
      };
    }
  );
}
