import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "./lib/api-client.js";
import { registerGetGuardrails } from "./tools/get-guardrails.js";
import { registerGetSpecs } from "./tools/get-specs.js";
import { registerGetDocs } from "./tools/get-docs.js";
import { registerGetTechStack } from "./tools/get-tech-stack.js";
import { registerGetPlanningContext } from "./tools/get-planning-context.js";
import { registerGetPlanBoard } from "./tools/get-plan-board.js";
import { registerGetChange } from "./tools/get-change.js";
import { registerGetContext } from "./tools/get-context.js";
import { registerGetTeamSetup } from "./tools/get-team-setup.js";
import { registerDocumentGraph } from "./tools/document-graph.js";
import { registerCreateGuardrail } from "./tools/create-guardrail.js";
import { registerUpdateSpec } from "./tools/update-spec.js";
import { registerReportDecision } from "./tools/report-decision.js";
import { registerGetProjectRules } from "./tools/get-project-rules.js";
import { registerCreateProjectRule } from "./tools/create-project-rule.js";
import { registerGetPromptTemplates } from "./tools/get-prompt-templates.js";
import { registerCreatePromptTemplate } from "./tools/create-prompt-template.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerTeamSetupTools } from "./tools/team-setup.js";

// Replaced at build time by tsup with package.json's version, which the publish
// workflow sets from the release tag. Falls back only when the source is run
// unbundled (e.g. ts-node), where no published version exists to report.
declare const __MCP_SERVER_VERSION__: string;
const SERVER_VERSION =
  typeof __MCP_SERVER_VERSION__ === "string" ? __MCP_SERVER_VERSION__ : "0.0.0-dev";

export interface ServerOptions {
  /** True only on the user's own computer (stdio): the skill tools may read
   * and write the skill folder there. The hosted server never touches a disk
   * (ADR-216 §2.2). */
  localFiles?: boolean;
  /** What the server tells every session in its `initialize` answer (ADR-223). */
  instructions?: string;
  /** Why the local server has no key, when it has none. */
  keyProblem?: string;
}

/**
 * Build a SystemDox MCP server with all tools registered against the given
 * API client. Shared by the stdio entry point (index.ts) and the hosted
 * Streamable HTTP entry point (http.ts).
 */
export function createServer(
  apiClient: SystemDoxApiClient,
  { localFiles = false, instructions, keyProblem }: ServerOptions = {}
): McpServer {
  const server = new McpServer(
    {
      name: "systemdox-mcp-server",
      version: SERVER_VERSION,
    },
    instructions ? { instructions } : undefined
  );

  // Read tools
  registerGetGuardrails(server, apiClient);
  registerGetSpecs(server, apiClient);
  registerGetDocs(server, apiClient);
  registerGetTechStack(server, apiClient);
  registerGetPlanningContext(server, apiClient);
  registerGetPlanBoard(server, apiClient);
  registerGetChange(server, apiClient);
  registerGetContext(server, apiClient);
  registerGetProjectRules(server, apiClient);
  registerGetPromptTemplates(server, apiClient);
  registerGetTeamSetup(server, apiClient, { localFiles, keyProblem });
  registerDocumentGraph(server, apiClient);

  // Write tools
  registerCreateGuardrail(server, apiClient);
  registerUpdateSpec(server, apiClient);
  registerReportDecision(server, apiClient);
  registerCreateProjectRule(server, apiClient);
  registerCreatePromptTemplate(server, apiClient);

  // Authored skills: publish, list, install (ADR-216)
  registerSkillTools(server, apiClient, { localFiles });

  // Team setup: publish a part, resolve a person named in a memory, and (local
  // only) sync a team memory (ADR-217)
  registerTeamSetupTools(server, apiClient, { localFiles });

  return server;
}
