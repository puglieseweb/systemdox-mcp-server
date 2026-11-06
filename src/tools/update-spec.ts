import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface SpecDetail {
  draftId: string;
  name: string;
  status: string;
  proposalContent: string;
  taskContent: string;
  requirements: Array<{
    reqId: string;
    name: string;
    content: string;
  }>;
}

export function registerUpdateSpec(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "update_spec",
    {
      title: "Update Spec",
      description:
        "Update an existing SystemDox spec's proposal, tasks, or requirements. Only draft specs can be modified — published specs must be versioned first.",
      inputSchema: {
        draft_id: z.string().describe("ID of the spec to update"),
        section: z
          .enum(["proposal", "tasks", "requirements"])
          .describe("Which section to update"),
        content: z
          .string()
          .describe(
            "New markdown content for the section. For requirements, provide the full requirement content."
          ),
        requirement_name: z
          .string()
          .optional()
          .describe(
            "Name of the requirement (required when section is 'requirements')"
          ),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ draft_id, section, content, requirement_name }) => {
      // Fetch current spec to check status
      const spec = await apiClient.get<SpecDetail>(`/v1/specs/${draft_id}`);

      if (spec.status !== "draft") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot modify spec "${spec.name}" — status is "${spec.status}". Only draft specs can be updated.`,
            },
          ],
          isError: true,
        };
      }

      const body: Record<string, unknown> = {};

      if (section === "proposal") {
        body.proposalContent = content;
      } else if (section === "tasks") {
        body.taskContent = content;
      } else if (section === "requirements") {
        const existing = spec.requirements;
        const newReq = {
          name: requirement_name ?? "Untitled Requirement",
          content,
        };
        body.requirements = [...existing, newReq];
      }

      await apiClient.put(`/v1/specs/${draft_id}`, body);

      apiClient.invalidateCache(`/v1/specs/${draft_id}`);
      apiClient.invalidateCache("/v1/specs");

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated spec "${spec.name}" — ${section} section modified.`,
          },
        ],
      };
    }
  );
}
