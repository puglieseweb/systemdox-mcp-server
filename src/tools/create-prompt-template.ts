import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface SavedPromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  createdAt: string;
}

export function registerCreatePromptTemplate(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "create_prompt_template",
    {
      title: "Create Prompt Template",
      description:
        "Create a new reusable prompt template in SystemDox Standards. Use this to store preconfigured prompts for common AI tasks like code reviews, documentation generation, or analysis frameworks.",
      inputSchema: {
        name: z.string().describe("Short name for the template"),
        description: z
          .string()
          .optional()
          .describe("Brief description of when to use this template"),
        prompt: z
          .string()
          .describe("The full prompt text that Gen AI will use when generating content"),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ name, description, prompt }) => {
      const saved = await apiClient.post<SavedPromptTemplate>(
        "/v1/standards/prompt-templates",
        {
          name,
          description: description ?? "",
          prompt,
        }
      );

      apiClient.invalidateCache("/v1/standards/prompt-templates");

      return {
        content: [
          {
            type: "text" as const,
            text: `Prompt template created: **${saved.name}** (id: ${saved.id})`,
          },
        ],
      };
    }
  );
}
