import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

interface PlanningContext {
  repoSummaries: Array<{
    repo: string;
    purpose: string;
    summary: string;
    conventions: string[];
    claudeMd?: string;
  }>;
  dependencies: Array<{
    from: string;
    to: string;
    relationship: string;
    /** ADR-224 §2.5: parsed from a file, or named only by a model. */
    provenance?: "extracted" | "inferred";
  }>;
  adrs: Array<{
    title: string;
    repo: string;
  }>;
  /** Every decision indexed. adrs holds the newest of them. */
  adrTotal?: number;
  specs: Array<{
    name: string;
    status: string;
  }>;
  targetRepo: string | null;
}

export function registerGetPlanningContext(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_planning_context",
    {
      title: "Get Planning Context",
      description:
        "Retrieve org-wide planning context: connected repos with summaries, cross-repo dependencies, ADRs, and active specs. Optionally focus on a target repo.",
      inputSchema: {
        target_repo: z
          .string()
          .optional()
          .describe(
            "Focus on a specific repo (owner/repo format) to get its CLAUDE.md and relevant context"
          ),
      },
    },
    async ({ target_repo }) => {
      const params: Record<string, string> = {};
      if (target_repo) params.targetRepo = target_repo;

      const ctx = await apiClient.get<PlanningContext>(
        "/v1/org/planning-context",
        params
      );

      const sections: string[] = [];

      // Repos
      if (ctx.repoSummaries.length > 0) {
        const repos = ctx.repoSummaries
          .map(
            (r) =>
              `#### ${r.repo}\n${r.purpose}\n\n${r.summary}` +
              (r.conventions.length > 0
                ? `\n\n**Conventions:**\n${r.conventions.map((c) => `- ${c}`).join("\n")}`
                : "")
          )
          .join("\n\n");
        sections.push(`## Repositories (${ctx.repoSummaries.length})\n\n${repos}`);
      }

      // Dependencies
      if (ctx.dependencies.length > 0) {
        const deps = ctx.dependencies
          .map((d) => `- ${d.from} → ${d.to}${d.provenance === "inferred" ? " (inferred)" : ""}`)
          .join("\n");
        sections.push(`## Cross-Repo Dependencies\n\n${deps}`);
      }

      // ADRs
      if (ctx.adrs.length > 0) {
        const adrs = ctx.adrs
          .map((a) => `- ${a.title}${a.repo ? ` (${a.repo})` : ""}`)
          .join("\n");
        const total = ctx.adrTotal ?? ctx.adrs.length;
        const count =
          total > ctx.adrs.length
            ? `${ctx.adrs.length} newest of ${total}`
            : `${ctx.adrs.length}`;
        sections.push(`## Architecture Decision Records (${count})\n\n${adrs}`);
      }

      // Specs
      if (ctx.specs.length > 0) {
        const specs = ctx.specs
          .map((s) => `- ${s.name} [${s.status}]`)
          .join("\n");
        sections.push(`## Specs (${ctx.specs.length})\n\n${specs}`);
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No planning context available. Connect repositories at ${configLink("/settings/github", await workspaceBase(apiClient))}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n\n"),
          },
        ],
      };
    }
  );
}
