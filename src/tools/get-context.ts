import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { buildContext } from "../lib/context-builder.js";

export function registerGetContext(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_context",
    {
      title: "Get Context",
      description:
        "Intelligent context aggregator: fetches checks, specs, docs, and tech stack, ranks them by relevance to your current task, and returns the full text of the highest-ranked items within a token budget — each with the ID needed to fetch the rest. Use this instead of calling individual tools when you want curated, relevant context.",
      inputSchema: {
        task_description: z
          .string()
          .describe(
            "What you're working on (e.g., 'add a new REST endpoint for user preferences')"
          ),
        file_paths: z
          .array(z.string())
          .optional()
          .describe(
            "File paths being edited — used for language/category detection"
          ),
        max_tokens: z
          .number()
          .optional()
          .describe("Maximum token budget for the response (default: 4000)"),
      },
    },
    async ({ task_description, file_paths, max_tokens }) => {
      const { text } = await buildContext(apiClient, {
        taskDescription: task_description,
        filePaths: file_paths,
        maxTokens: max_tokens,
      });

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
