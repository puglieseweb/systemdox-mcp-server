import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { readTextFiles, walk } from "../lib/skills.js";
import { PARTS, PERSON_ID_RE, type FileIn, type PartName, type Person } from "../lib/team-setup-types.js";
import { SYNC_MEMORY_COMMAND, syncMemory, type SyncClient } from "../sync-memory.js";

/**
 * The team setup over MCP (ADR-217 with Amendments 1 and 2,
 * specs/changes/team-setup/contract.md):
 *
 * - `publish_setup_part` publishes one part of the team setup (hooks, MCP
 *   servers, agents, commands, instructions), with publish_skill's reading
 *   rules: the local server reads the folder itself, only the paths the part
 *   accepts, and refuses a link, a binary file or a file past ADR-216's limits
 *   before anything is sent; the hosted server takes `files`.
 * - `resolve_person` reads back a person a memory names by token, for this
 *   session only. It writes nothing and keeps nothing.
 * - `sync_memory` (local server only: it needs the disk) runs `sync-memory`
 *   with no person at a terminal: it never answers a question about a value
 *   and never rewrites a file for one; it names the command for the member.
 *
 * Both act on the key's own workspace, which `GET /team-setup` names.
 */

type Client = Pick<SystemDoxApiClient, "getOwnTeamSetup" | "publishPartVersion" | "resolvePerson"> &
  Partial<SyncClient>;

/** What each part accepts (openapi publishPartVersion): single files at fixed
 * paths, and folders read whole (only `*.md` where `md`). */
const LAYOUT: Record<PartName, { files: string[]; folders: { dir: string; md: boolean }[]; required?: string }> = {
  hooks: { files: ["hooks/hooks.json"], folders: [{ dir: "scripts", md: false }], required: "hooks/hooks.json" },
  mcp: { files: [".mcp.json"], folders: [], required: ".mcp.json" },
  agents: { files: [], folders: [{ dir: "agents", md: true }] },
  commands: { files: [], folders: [{ dir: "commands", md: true }] },
  instructions: { files: ["CLAUDE.md"], folders: [], required: "CLAUDE.md" },
};

/** `~` and `~/…` (or `~\…`) mean the home folder on this computer. */
function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink(); // a Windows junction reports as one too
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Read the files `part` accepts from `directory`, and nothing else. A link on
 * the way to one of them (the file, its folder, anything inside a folder read
 * whole) stops the read before any file is read. Returns the files and what
 * was left out inside the folders read (hidden files, and files that are not
 * `*.md` where only those are accepted).
 */
export async function readPartDirectory(
  part: PartName,
  directory: string
): Promise<{ files: FileIn[]; leftOut: string[] }> {
  const root = resolve(directory);
  const layout = LAYOUT[part];
  const paths: string[] = [];
  const leftOut: string[] = [];
  const links: string[] = [];

  for (const path of layout.files) {
    const segments = path.split("/");
    let present = true;
    for (let i = 1; i <= segments.length; i++) {
      const rel = segments.slice(0, i).join("/");
      if (await isLink(join(root, ...segments.slice(0, i)))) {
        links.push(rel);
        present = false;
        break;
      }
    }
    if (present && existsSync(join(root, ...segments))) paths.push(path);
  }
  for (const { dir, md } of layout.folders) {
    const full = join(root, dir);
    if (await isLink(full)) {
      links.push(dir);
      continue;
    }
    if (!existsSync(full)) continue;
    const walked = await walk(full, { skipHidden: true });
    links.push(...walked.links.map((p) => `${dir}/${p}`));
    leftOut.push(...walked.hidden.map((p) => `${dir}/${p}`));
    for (const p of walked.files) {
      if (md && !p.endsWith(".md")) leftOut.push(`${dir}/${p}`);
      else paths.push(`${dir}/${p}`);
    }
  }

  if (links.length) {
    // A link could pull in a file from anywhere on this computer (~/.ssh, …).
    throw new Error(
      `${links.join(", ")}: links are not followed; copy the file into the folder. Nothing was sent.`
    );
  }
  if (layout.required && !paths.includes(layout.required)) {
    throw new Error(`${root} has no ${layout.required}: the ${part} part needs it. Nothing was sent.`);
  }
  if (!paths.length) {
    throw new Error(
      `${root} has no ${layout.folders.map((f) => `${f.dir}/*.md`).join(" or ")}: nothing to publish for ${part}.`
    );
  }
  return { files: await readTextFiles(root, paths.sort(), `the ${part} part`), leftOut };
}

function describePerson(id: string, person: Person): string {
  const lines = [`**${person.label ?? "(no label)"}**, \`${id}\``];
  if (person.mergedInto) {
    lines.push(`\`${id}\` was merged into \`${person.mergedInto}\`: these are \`${person.mergedInto}\`'s details.`);
  }
  lines.push(`- Name: ${person.name ?? "(none held)"}`);
  lines.push(`- Phone number: ${person.phone ?? "(none held)"}`);
  lines.push(`- Email address: ${person.email ?? "(none held)"}`);
  const token = `\`${person.mergedInto ?? id}\`${person.label ? ` (${person.label})` : ""}`;
  lines.push(
    "",
    "These details are for this session only. Do not write them into a memory file, a note or a commit: " +
      `a memory names this person by the identifier, as ${token}. ` +
      "A memory file that holds the details is offered for rewriting again at the next sync."
  );
  return lines.join("\n");
}

export function registerTeamSetupTools(
  server: McpServer,
  apiClient: Client,
  { localFiles }: { localFiles: boolean }
): void {
  const fileSchema = z.object({
    path: z.string().describe('Path inside the part\'s folder, forward slashes, e.g. "hooks/hooks.json"'),
    content: z.string().describe("The file's full text, exactly as it is"),
  });

  server.registerTool(
    "publish_setup_part",
    {
      title: "Publish Setup Part",
      description:
        "Publish one part of your team's Claude Code setup to SystemDox: `hooks` (hooks/hooks.json and the scripts/ it calls), `mcp` (.mcp.json), `agents` (agents/*.md), `commands` (commands/*.md) or `instructions` (CLAUDE.md). " +
        "Every part but instructions makes a new version of the team plugin, which each member accepts at their next update. Publishing hooks, mcp, agents or commands needs the admin role. " +
        (localFiles
          ? "Pass `directory`: the server reads only the files the part accepts, byte for byte, and refuses a link, a binary file or a file too large before anything is sent. Never retype the files into `files` when the folder is on this computer."
          : "Pass every file of the part in `files`, exactly as it is."),
      inputSchema: {
        part: z.enum(PARTS).describe("Which part of the setup"),
        ...(localFiles
          ? {
              directory: z
                .string()
                .optional()
                .describe(
                  "The folder on this computer: for hooks, the one holding hooks/hooks.json and scripts/; for mcp, the one holding .mcp.json; for instructions, the one holding CLAUDE.md; for agents or commands, the one holding agents/ or commands/"
                ),
            }
          : {}),
        files: z
          .array(fileSchema)
          .optional()
          .describe(localFiles ? "Only when there is no folder to read" : "Every file of the part"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args: { part: PartName; directory?: string; files?: FileIn[] }) => {
      let files: FileIn[];
      let leftOut: string[] = [];
      if (localFiles && args.directory) {
        ({ files, leftOut } = await readPartDirectory(args.part, expandHome(args.directory)));
      } else if (args.files?.length) {
        files = args.files;
      } else {
        throw new Error(localFiles ? "Pass `directory` (or `files`)." : "Pass `files`.");
      }

      const { workspace } = await apiClient.getOwnTeamSetup();
      const saved = await apiClient.publishPartVersion(workspace, args.part, files);
      const lines = [`Published **${saved.part}** version ${saved.version}.`];
      if (saved.part !== "instructions" && saved.pluginVersion !== undefined) {
        lines.push(`Team plugin version ${saved.pluginVersion}; each member accepts it at their next update.`);
      }
      if (saved.replacedValues?.length) {
        lines.push(
          "Replaced by a reference to each member's own environment variable:",
          ...saved.replacedValues.map((r) => `- ${r.server} ${r.field} ${r.name}: \${${r.name}}`)
        );
      }
      if (leftOut.length) lines.push(`Left out (not part of ${args.part}): ${leftOut.join(", ")}`);
      return text(lines.join("\n"));
    }
  );

  server.registerTool(
    "resolve_person",
    {
      title: "Resolve Person",
      description:
        "Read back a person that a team memory names by identifier, written as `con_…` (label), `ctc_…` or `usr_…`: their label, name, phone number and email address, from the vault that holds them. " +
        "The details are for this session only: never write them into a memory file; the memory keeps the identifier. Writes nothing.",
      inputSchema: {
        id: z
          .string()
          .regex(PERSON_ID_RE, "a con_, ctc_ or usr_ identifier, as written in the memory")
          .describe("The identifier, e.g. con_01JC2Q8Y4M7T0X3K5N9P2R6S8V"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { id: string }) => {
      const { workspace } = await apiClient.getOwnTeamSetup();
      const person = await apiClient.resolvePerson(workspace, args.id);
      return text(describePerson(args.id, person));
    }
  );

  if (!localFiles) return;

  server.registerTool(
    "sync_memory",
    {
      title: "Sync Memory",
      description:
        "Sync one project's team memory on this computer with SystemDox: pull the files the team changed, push the ones changed here, keep both texts of a file changed on both sides. " +
        "It never answers for a person: a file that still holds a phone number, an email address or a home-folder path is skipped and listed, " +
        `with the command for the member to run in their own terminal (\`${SYNC_MEMORY_COMMAND}\`). Pass dryRun to see what it would do without writing or sending anything.`,
      inputSchema: {
        project: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a project name: lower case letters, digits and -")
          .optional()
          .describe("The project's team memory, e.g. puglieseweb-ltd; needed when the workspace has more than one"),
        dryRun: z.boolean().optional().describe("Show what would be pulled, pushed, deleted, conflicted and skipped, and change nothing"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args: { project?: string; dryRun?: boolean }) => {
      const lines: string[] = [];
      const code = await syncMemory({
        project: args.project,
        dryRun: !!args.dryRun,
        client: apiClient as SyncClient,
        out: (...l: string[]) => lines.push(...l),
      });
      return { ...text(lines.join("\n")), ...(code ? { isError: true } : {}) };
    }
  );
}
