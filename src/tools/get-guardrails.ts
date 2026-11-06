import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { detectLanguage } from "../lib/language.js";
import { legacyToolDescription } from "../lib/deprecation.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

export interface Guardrail {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  pattern: string;
  fix: string;
  fitnessTest: string;
  createdAt: string;
  updatedAt: string;
}

const DESCRIPTION =
  "Retrieve SystemDox checks (banned patterns, required patterns, coding rules). Filter by language, category, or file path to get only relevant checks.";

// A fresh shape per registration — registerTool consumes it.
const inputSchema = () => ({
  language: z
    .string()
    .optional()
    .describe(
      "Filter by programming language (python, typescript, javascript, cloudformation)"
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Filter by category (imports, auth, error-handling, architecture, testing, security, conventions, data-access)"
    ),
  file_path: z
    .string()
    .optional()
    .describe(
      "File path being edited — language is auto-detected from the extension"
    ),
});

export function registerGetGuardrails(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  const handler = async ({
    language,
    category,
    file_path,
  }: {
    language?: string;
    category?: string;
    file_path?: string;
  }) => {
    const guardrails = await apiClient.get<Guardrail[]>("/v1/guardrails");

    let filtered = guardrails;

    const lang = language ?? (file_path ? detectLanguage(file_path)?.language : undefined);

    if (lang) {
      filtered = filtered.filter((g) =>
        g.description.toLowerCase().includes(lang.toLowerCase()) ||
        g.category.toLowerCase().includes(lang.toLowerCase()) ||
        g.title.toLowerCase().includes(lang.toLowerCase())
      );
    }

    if (category) {
      filtered = filtered.filter(
        (g) => g.category.toLowerCase() === category.toLowerCase()
      );
    }

    if (filtered.length === 0) {
      // Nothing configured at all → say where to start; checks exist but the
      // filter excluded them → keep naming the filter instead.
      const text =
        guardrails.length === 0
          ? `No checks found. Add checks at ${configLink("/docs/guardrails", await workspaceBase(apiClient))}`
          : `No checks found${lang ? ` for language "${lang}"` : ""}${category ? ` in category "${category}"` : ""}.`;
      return {
        content: [{ type: "text" as const, text }],
      };
    }

    const text = filtered
      .map(
        (g) =>
          `## ${g.title} [${g.severity}]\n\n${g.description}\n\n` +
          (g.pattern ? `**Bad pattern:**\n\`\`\`\n${g.pattern}\n\`\`\`\n\n` : "") +
          (g.fix ? `**Correct pattern:**\n\`\`\`\n${g.fix}\n\`\`\`\n\n` : "") +
          (g.fitnessTest ? `**Detection:** \`${g.fitnessTest}\`\n` : "")
      )
      .join("\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${filtered.length} check(s):\n\n${text}`,
        },
      ],
    };
  };

  server.registerTool(
    "get_checks",
    {
      title: "Get Checks",
      description: DESCRIPTION,
      inputSchema: inputSchema(),
    },
    handler
  );

  server.registerTool(
    "get_guardrails",
    {
      title: "Get Checks (legacy name)",
      description: legacyToolDescription("get_checks", DESCRIPTION),
      inputSchema: inputSchema(),
    },
    handler
  );
}
