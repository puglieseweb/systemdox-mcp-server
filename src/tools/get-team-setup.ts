import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import {
  CANNOT_SEE,
  SETUP_COMMAND,
  computerState,
  hasPersonParts,
  readTeamSetup,
  type ComputerState,
} from "../lib/session-brief.js";
import type { TeamSetup } from "../lib/team-setup-types.js";

/**
 * The team setup in full, and on the local server what this computer lacks
 * (docs-company ADR-223, specs/archive/session-brief/contract.md). For a client
 * that does not surface `instructions`, and for a list too long for them. Reads
 * only: installing stays with install_skill, and hooks with the person.
 */

const HELD_BECAUSE: Record<string, string> = {
  "not-plain":
    `it is not a plain skill: it has frontmatter beyond a name and a description, files outside its own folders, or a command that runs as it loads. The team plugin carries it, and \`${SETUP_COMMAND}\` shows that before the person accepts`,
  "outside-default-space":
    "it is outside the default space, so the team plugin does not carry it either. The person can read it in the console, then install it with `npx -y @systemdox/mcp-server install-skill <name>`",
  "not-checked": "it could not be checked. Ask again later",
};

function describeSetup(setup: TeamSetup): string[] {
  const lines = [`# Team setup of ${setup.workspace}`, ""];
  const skills = setup.sessionBrief?.skills ?? [];
  const held = setup.sessionBrief?.heldSkills ?? [];
  lines.push(`## Skills a session installs by itself (${skills.length})`, "");
  if (skills.length) {
    for (const s of skills) lines.push(`- **${s.name}** version ${s.latestVersion}: ${s.description}`);
  } else if (!setup.sessionBrief && setup.skills.length) {
    // An API older than ADR-223 lists names and nothing else.
    lines.push(`- ${setup.skills.join(", ")}`);
  } else {
    lines.push("None.");
  }
  lines.push("");
  if (held.length) {
    lines.push(`## Skills that wait for the person (${held.length})`, "");
    for (const h of held) lines.push(`- **${h.name}**: ${HELD_BECAUSE[h.reason] ?? h.reason}`);
    lines.push("", "Do not install these yourself: each is the person's to decide.", "");
  }
  if (setup.plugin) {
    lines.push(`## Team plugin`, "", `\`${setup.workspace}-setup\` version ${setup.plugin.version}.`);
    // Quoted: a command is someone's text, and a line break in one must not read as this answer's next line.
    for (const c of setup.plugin.hookCommands ?? []) lines.push(`- Hook: ${JSON.stringify(c)}`);
    for (const m of setup.plugin.mcpServers ?? []) {
      lines.push(`- MCP server ${JSON.stringify(m.name)}: ${JSON.stringify(m.url ?? [m.command, ...(m.args ?? [])].filter(Boolean).join(" "))}`);
    }
    lines.push("");
  }
  const parts = Object.entries(setup.parts ?? {});
  if (parts.length) {
    lines.push(`## Published parts`, "", ...parts.map(([p, v]) => `- ${p}: version ${v}`), "");
  }
  if (setup.memory?.length) {
    lines.push(`## Team memory`, "", ...setup.memory.map((m) => `- ${m.project}: ${m.fileCount} file(s)`), "");
  }
  return lines;
}

function describeComputer(setup: TeamSetup, state: ComputerState): string[] {
  const lines = ["## This computer", ""];
  if (!setup.sessionBrief) {
    // Nothing to compare with: saying "nothing is missing" would be a guess.
    return [...lines, "This SystemDox API is too old to compare this computer with the team setup."];
  }
  const skills = setup.sessionBrief.skills;
  const latest = new Map(skills.map((s) => [s.name, s.latestVersion]));
  lines.push(
    state.missing.length
      ? `- Missing: ${state.missing.map((name) => `${name} version ${latest.get(name)}`).join(", ")}`
      : `- Missing: none of ${skills.length}`
  );
  if (state.behind.length) {
    lines.push(`- Behind: ${state.behind.map((b) => `${b.name} (version ${b.here} here, latest ${b.latest})`).join(", ")}`);
  }
  if (state.notFromSystemDox.length) lines.push(`- Not from SystemDox, left alone: ${state.notFromSystemDox.join(", ")}`);
  if (setup.plugin) {
    lines.push(
      state.pluginInstalled
        ? `- Team plugin: installed${state.pluginVersion ? `, ${state.pluginVersion}` : ""}; the latest is version ${setup.plugin.version}`
        : "- Team plugin: not installed"
    );
  }
  lines.push("", "## What to do", "");
  const steps: string[] = [];
  if (state.missing.length) steps.push("Call install_skill for each missing skill, at the version named above. These are plain skills: installing writes files and runs nothing.");
  if (state.behind.length) {
    steps.push("Call install_skill for each skill behind, at the latest version named above. If it refuses because files were edited, tell the person and leave them.");
  }
  if (hasPersonParts(setup) && !state.pluginInstalled) {
    steps.push(
      `Hooks, MCP servers, team instructions and memory need the person: \`${SETUP_COMMAND}\` in their own terminal. Never answer its prompts for them.`
    );
  }
  lines.push(...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ["Nothing."]));
  return lines;
}

export function registerGetTeamSetup(
  server: McpServer,
  apiClient: SystemDoxApiClient,
  { localFiles, keyProblem }: { localFiles: boolean; keyProblem?: string }
): void {
  server.registerTool(
    "get_team_setup",
    {
      title: "Get Team Setup",
      description: localFiles
        ? "What this workspace's team setup holds (skills, plugin, hooks, MCP servers, memory) and what this computer lacks, with what to do about it. Call it to check whether this computer is set up. Reads only."
        : "What this workspace's team setup holds (skills, plugin, hooks, MCP servers, memory), and how to check this computer against it. Reads only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const read = await readTeamSetup(apiClient, { keyProblem, timeoutMs: 15_000 });
      if ("problem" in read) return { content: [{ type: "text" as const, text: read.problem }] };
      const lines = describeSetup(read.setup);
      if (localFiles) lines.push(...describeComputer(read.setup, await computerState(read.setup)));
      else lines.push(CANNOT_SEE);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
