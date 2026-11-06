import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";
import {
  ENTRY_FILE,
  MANIFEST_FILE,
  defaultSkillDir,
  afterInstall,
  describeInstall,
  fenceFor,
  frontmatterName,
  installSkill,
  readSkillDirectory,
  type SkillFileIn,
  type SkillVersionFiles,
} from "../lib/skills.js";

/**
 * Authored skills over MCP (ADR-216 §2.2): publish_skill, list_skills,
 * install_skill. The local (stdio) server reads and writes the skill folder
 * itself, so the model never retypes a file; the hosted server cannot see the
 * user's disk, so there the agent passes the files and writes them.
 */

interface SkillSummary {
  name: string;
  description: string;
  latestVersion: number;
  spaceId: string;
  updatedAt: string;
}

interface VersionSummary {
  name: string;
  version: number;
  fileCount: number;
  totalBytes: number;
}

const SKILLS = "/v1/standards/skills";

/** `~` and `~/…` (or `~\…`) mean the home folder on this computer. */
function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export function registerSkillTools(
  server: McpServer,
  apiClient: SystemDoxApiClient,
  { localFiles }: { localFiles: boolean }
): void {
  const fileSchema = z.object({
    path: z.string().describe('Path inside the skill folder, forward slashes, e.g. "references/guide.md"'),
    content: z.string().describe("The file's full text, exactly as it is"),
  });

  server.registerTool(
    "publish_skill",
    {
      title: "Publish Skill",
      description: localFiles
        ? "Publish a Claude Code skill folder (SKILL.md plus its references and scripts) to SystemDox so it can be installed on any computer. Pass `directory` (e.g. ~/.claude/skills/<name>): the server reads the files itself, byte for byte. Publishing a name again makes a new version. Never retype the files into `files` when the folder is on this computer."
        : "Publish a Claude Code skill (SKILL.md plus its references and scripts) to SystemDox so it can be installed on any computer. Pass every file of the folder in `files`, exactly as it is. Publishing a name again makes a new version.",
      inputSchema: {
        ...(localFiles
          ? {
              directory: z
                .string()
                .optional()
                .describe("The skill folder on this computer, holding SKILL.md at its root"),
            }
          : {}),
        files: z
          .array(fileSchema)
          .optional()
          .describe(localFiles ? "Only when there is no folder to read" : "Every file of the skill folder"),
        name: z
          .string()
          .optional()
          .describe("The skill's name; defaults to SKILL.md's frontmatter name and must match it"),
        spaceId: z.string().optional().describe("Space for a NEW skill (default: your default space)"),
        note: z
          .string()
          .max(500)
          .optional()
          .describe("A short change note for this version, shown in the console's history (e.g. \"Fix the GA4 step\")"),
        baseVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The version these files were edited from. When given, the publish is refused (SYD-K017) if someone published a newer version since, instead of replacing their changes"
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async (args: {
      directory?: string;
      files?: SkillFileIn[];
      name?: string;
      spaceId?: string;
      note?: string;
      baseVersion?: number;
    }) => {
      let files: SkillFileIn[];
      let name: string | undefined;
      let skipped: string[] = [];
      if (localFiles && args.directory) {
        ({ name, files, skipped } = await readSkillDirectory(expandHome(args.directory)));
      } else if (args.files?.length) {
        files = args.files;
        const entry = files.find((f) => f.path === ENTRY_FILE);
        name = entry ? frontmatterName(entry.content) : undefined;
      } else {
        throw new Error(localFiles ? "Pass `directory` (or `files`)." : "Pass `files`.");
      }
      name = args.name ?? name;
      if (!name) throw new Error(`${ENTRY_FILE} has no frontmatter name; pass \`name\`.`);

      const saved = await apiClient.post<VersionSummary>(
        `${SKILLS}/${encodeURIComponent(name)}/versions`,
        {
          files,
          ...(args.spaceId ? { spaceId: args.spaceId } : {}),
          ...(args.note ? { note: args.note } : {}),
          ...(args.baseVersion ? { baseVersion: args.baseVersion } : {}),
        }
      );
      apiClient.invalidateCache(SKILLS);
      return text(
        `Published **${saved.name}** version ${saved.version} (${saved.fileCount} file(s), ${saved.totalBytes} bytes).\n` +
          `Install it anywhere with: npx -y @systemdox/mcp-server install-skill ${saved.name}` +
          (skipped.length ? `\nLeft out (hidden files are never part of a skill): ${skipped.join(", ")}` : "")
      );
    }
  );

  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description:
        "List the Claude Code skills published to SystemDox that you can install: name, description, latest version. Use install_skill to install one.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { skills } = await apiClient.get<{ skills: SkillSummary[] }>(SKILLS);
      if (!skills.length) {
        return text(
          `No skills published yet. Publish one with publish_skill; they appear at ${configLink("/docs/team-setup/skills", await workspaceBase(apiClient))}`
        );
      }
      return text(
        `${skills.length} skill(s):\n\n` +
          skills
            .map((s) => `- **${s.name}** (version ${s.latestVersion}, updated ${s.updatedAt.slice(0, 10)}): ${s.description}`)
            .join("\n")
      );
    }
  );

  server.registerTool(
    "install_skill",
    {
      title: "Install Skill",
      description: localFiles
        ? "Install a skill published to SystemDox onto this computer (default ~/.claude/skills/<name>/). Refuses, naming the files, when a file there was edited since it was installed, unless overwrite is true. Never runs anything."
        : "Fetch a skill published to SystemDox so you can install it: returns every file and the folder to write them into (default ~/.claude/skills/<name>/). Write each file exactly, then the manifest it shows.",
      inputSchema: {
        name: z.string().describe("The skill's name"),
        version: z.number().int().positive().optional().describe("A version number (default: the latest)"),
        target: z.string().optional().describe("Folder to install into, e.g. a repo's .claude/skills/<name>"),
        ...(localFiles
          ? { overwrite: z.boolean().optional().describe("Replace files edited since they were installed") }
          : {}),
      },
      annotations: { readOnlyHint: !localFiles },
    },
    async (args: { name: string; version?: number; target?: string; overwrite?: boolean }) => {
      const version = await apiClient.getFresh<SkillVersionFiles>(
        `${SKILLS}/${encodeURIComponent(args.name)}/versions/${args.version ?? "latest"}`
      );
      if (localFiles) {
        const dest = args.target ? expandHome(args.target) : defaultSkillDir(version.name);
        // A skill folder is named after its skill: a target such as .git/hooks
        // (a prompt-injected one, say) is refused, not written into.
        if (basename(resolve(dest)) !== version.name) {
          throw new Error(`target must be a folder named ${version.name} (e.g. .claude/skills/${version.name}); got ${dest}`);
        }
        const result = await installSkill(version, dest, { overwrite: args.overwrite });
        return text(describeInstall(version.name, result));
      }
      // The hosted server's own home folder means nothing to the user's computer.
      const dest = args.target ?? `~/.claude/skills/${version.name}`;

      const manifest = {
        name: version.name,
        version: version.version,
        installedAt: "<now, ISO 8601>",
        files: Object.fromEntries(version.files.map((f) => [f.path, f.sha256])),
      };
      const body = version.files
        .map((f) => {
          const fence = fenceFor(f.content);
          return `### ${f.path}\n\n${fence}\n${f.content}${f.content.endsWith("\n") ? "" : "\n"}${fence}`;
        })
        .join("\n\n");
      return text(
        `Skill **${version.name}** version ${version.version}: write these ${version.files.length} file(s) into ${dest}/ exactly as shown (the content between the fences), creating folders as needed. ` +
          `If a file there differs from ${MANIFEST_FILE}'s hash for it, it was edited: ask before replacing it. ` +
          `Then write ${MANIFEST_FILE} with this content. ${afterInstall(`${dest}/SKILL.md`)}\n\n` +
          `### ${MANIFEST_FILE}\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n${body}`
      );
    }
  );
}
