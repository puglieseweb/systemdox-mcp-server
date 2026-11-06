import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { legacyToolDescription } from "../lib/deprecation.js";

interface SavedGuardrail {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: string;
}

const DESCRIPTION =
  "Create a new check in SystemDox. Use this when you discover a pattern that should be enforced (banned pattern, required pattern, coding rule).";

const CATEGORIES = [
  "imports",
  "auth",
  "error-handling",
  "architecture",
  "testing",
  "security",
  "conventions",
  "data-access",
] as const;

// A fresh shape per registration — registerTool consumes it.
const inputSchema = () => ({
  title: z.string().describe("Short title for the check"),
  description: z
    .string()
    .describe("Detailed description of what the check enforces and why"),
  severity: z
    .enum(["critical", "high", "medium", "low"])
    .describe("Severity level"),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe("Category (defaults to conventions)"),
  pattern: z
    .string()
    .optional()
    .describe("Bad code pattern that should be avoided"),
  fix: z
    .string()
    .optional()
    .describe("Correct code pattern to use instead"),
  fitness_test: z
    .string()
    .optional()
    .describe("Shell command to detect violations in CI"),
});

export function registerCreateGuardrail(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  const handler = async ({
    title,
    description,
    severity,
    category,
    pattern,
    fix,
    fitness_test,
  }: {
    title: string;
    description: string;
    severity: "critical" | "high" | "medium" | "low";
    category?: (typeof CATEGORIES)[number];
    pattern?: string;
    fix?: string;
    fitness_test?: string;
  }) => {
    const result = await apiClient.post<SavedGuardrail[]>(
      "/v1/guardrails",
      {
        entries: [
          {
            title,
            description,
            severity,
            category: category ?? "conventions",
            pattern: pattern ?? "",
            fix: fix ?? "",
            fitnessTest: fitness_test ?? "",
          },
        ],
      }
    );

    apiClient.invalidateCache("/v1/guardrails");

    const saved = result[0];
    return {
      content: [
        {
          type: "text" as const,
          text: `Check created: **${saved.title}** (id: ${saved.id}, severity: ${saved.severity}, category: ${saved.category})`,
        },
      ],
    };
  };

  server.registerTool(
    "create_check",
    {
      title: "Create Check",
      description: DESCRIPTION,
      inputSchema: inputSchema(),
      annotations: {
        readOnlyHint: false,
      },
    },
    handler
  );

  server.registerTool(
    "create_guardrail",
    {
      title: "Create Check (legacy name)",
      description: legacyToolDescription("create_check", DESCRIPTION),
      inputSchema: inputSchema(),
      annotations: {
        readOnlyHint: false,
      },
    },
    handler
  );
}
