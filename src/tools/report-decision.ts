import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface CreatedSpec {
  draftId: string;
  name: string;
}

export function registerReportDecision(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "report_decision",
    {
      title: "Report Decision",
      description:
        "Record an architecture decision made during development. Creates a draft ADR in SystemDox for human review.",
      inputSchema: {
        title: z
          .string()
          .describe("Decision title (e.g., 'Use WebSocket for real-time updates')"),
        context: z
          .string()
          .describe("What prompted this decision — the problem or constraint"),
        decision: z
          .string()
          .describe("What was decided and why"),
        consequences: z
          .string()
          .describe("What this decision means going forward — trade-offs, follow-up work"),
        related_files: z
          .array(z.string())
          .optional()
          .describe("File paths related to this decision"),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ title, context, decision, consequences, related_files }) => {
      const adrTitle = `ADR: ${title}`;

      // Create a draft spec to hold the ADR
      const created = await apiClient.post<CreatedSpec>("/v1/specs", {
        name: adrTitle,
      });

      // Format as ADR and update the proposal content
      const relatedSection =
        related_files && related_files.length > 0
          ? `\n\n## Related Files\n\n${related_files.map((f) => `- \`${f}\``).join("\n")}`
          : "";

      const adrContent =
        `# ${adrTitle}\n\n` +
        `**Date:** ${new Date().toISOString().slice(0, 10)}\n` +
        `**Status:** Draft (pending review)\n\n` +
        `## Context\n\n${context}\n\n` +
        `## Decision\n\n${decision}\n\n` +
        `## Consequences\n\n${consequences}` +
        relatedSection;

      await apiClient.put(`/v1/specs/${created.draftId}`, {
        proposalContent: adrContent,
      });

      apiClient.invalidateCache("/v1/specs");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Architecture decision recorded: **${adrTitle}** (spec id: ${created.draftId})\n\n` +
              `Status: draft — review in SystemDox before publishing.`,
          },
        ],
      };
    }
  );
}
