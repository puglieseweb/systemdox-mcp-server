import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { specLabel } from "../lib/spec-label.js";

interface SpecSummary {
  draftId: string;
  name: string;
  repoFullName: string;
  status: string;
  requirementCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SpecDetail {
  draftId: string;
  name: string;
  repoFullName: string;
  status: string;
  proposalContent: string;
  taskContent: string;
  requirements: Array<{
    reqId: string;
    name: string;
    content: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export function registerGetSpecs(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_specs",
    {
      title: "Get Specs",
      description:
        "Retrieve SystemDox specifications (proposal, requirements with RFC 2119 keywords, Given/When/Then scenarios). Get a specific spec by ID, filter by status, or search by keyword.",
      inputSchema: {
        draft_id: z
          .string()
          .optional()
          .describe("Specific spec ID to retrieve with full content"),
        status: z
          .enum(["draft", "ready", "archived"])
          .optional()
          .describe("Filter by status"),
        search: z
          .string()
          .optional()
          .describe("Keyword search across spec names"),
      },
    },
    async ({ draft_id, status, search }) => {
      if (draft_id) {
        const spec = await apiClient.get<SpecDetail>(
          `/v1/specs/${draft_id}`
        );

        const sections = [`# ${spec.name}\n\n**Status:** ${spec.status}`];

        if (spec.proposalContent) {
          sections.push(`## Proposal\n\n${spec.proposalContent}`);
        }

        if (spec.requirements.length > 0) {
          const reqs = spec.requirements
            .map((r) => `### ${r.name}\n\n${r.content}`)
            .join("\n\n");
          sections.push(`## Requirements\n\n${reqs}`);
        }

        if (spec.taskContent) {
          sections.push(`## Tasks\n\n${spec.taskContent}`);
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n\n") }],
        };
      }

      const specs = await apiClient.get<SpecSummary[]>("/v1/specs");

      let filtered = specs;

      if (status) {
        filtered = filtered.filter((s) => s.status === status);
      }

      if (search) {
        const term = search.toLowerCase();
        filtered = filtered.filter((s) =>
          s.name.toLowerCase().includes(term)
        );
      }

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No specs found${status ? ` with status "${status}"` : ""}${search ? ` matching "${search}"` : ""}.`,
            },
          ],
        };
      }

      const text = filtered
        .map(
          (s) =>
            `- **${s.name}** (${s.draftId}) — ${s.status}, ${specLabel(s)}` +
            (s.repoFullName ? `, repo: ${s.repoFullName}` : "")
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${filtered.length} spec(s):\n\n${text}`,
          },
        ],
      };
    }
  );
}
