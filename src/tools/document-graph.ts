import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

/**
 * The document graph over MCP (ADR-224, specs/changes/document-graph/contract.md §5).
 * Three read-only tools on the hosted and the local server. Every answer says
 * how each link is known, and one that was cut says so.
 */

interface GraphNode {
  id: string;
  label: string;
  type: string;
  repo: string;
  path: string;
}

interface NeighbourLink {
  direction: "out" | "in";
  relation: string;
  provenance: string;
  confidence: number;
  file: string;
  line: number;
  other: GraphNode;
}

interface AmbiguousLink {
  reference: string;
  file: string;
  line: number;
  candidates: GraphNode[];
}

interface Neighbours {
  doc: GraphNode;
  links: NeighbourLink[];
  ambiguous: AmbiguousLink[];
  total: number;
  truncated: boolean;
}

interface PathStep {
  from: GraphNode;
  to: GraphNode;
  relation: string;
  provenance: string;
  confidence: number;
  file: string;
  line: number;
  reversed: boolean;
}

interface GraphPath {
  found: boolean;
  hops: number;
  confidence: number;
  steps: PathStep[];
}

interface RepoFreshness {
  repo: string;
  documents: number;
  links: number;
  indexedCommit: string;
  indexedAt: string;
  headCommit: string;
  pushedAt: string;
  behind: boolean;
}

interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  links: { declared: number; extracted: number; inferred: number; ambiguous: number };
  repos: RepoFreshness[];
}

interface RepoLink {
  source: string;
  target: string;
  relation: string;
  provenance: string;
  confidence: number;
  file: string;
  line: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_HOPS = 6;
const MAX_HOPS = 8;

/** Where a link was read from; a declared link was made by a person. */
function place(file: string, line: number): string {
  return file ? `${file}:${line}` : "made by a person";
}

function known(provenance: string, confidence: number): string {
  return `${provenance} ${confidence}`;
}

export function formatNeighbours(answer: Neighbours): string {
  const lines = [`# ${answer.doc.label}`, `\`${answer.doc.id}\``, ""];
  if (answer.links.length === 0) lines.push("No links.");
  for (const link of answer.links) {
    lines.push(
      `- ${link.direction} · ${link.relation} · ${known(link.provenance, link.confidence)} · ` +
        `${link.other.label} · \`${link.other.id}\` · ${place(link.file, link.line)}`
    );
  }
  if (answer.truncated) {
    lines.push("", `Showing ${answer.links.length} of ${answer.total}. Raise limit to see more.`);
  }
  if (answer.ambiguous.length > 0) {
    lines.push("", "## Ambiguous: not drawn, because each could mean several documents");
    for (const entry of answer.ambiguous) {
      const candidates = entry.candidates.map((c) => `${c.label} (${c.repo}, \`${c.id}\`)`);
      lines.push(`- ${entry.reference} at ${place(entry.file, entry.line)}: ${candidates.join("; ")}`);
    }
  }
  return lines.join("\n");
}

export function formatPath(answer: GraphPath, maxHops: number): string {
  if (!answer.found) return `No path within ${maxHops} hops.`;
  const lines = answer.steps.map((step, index) => {
    const arrow = step.reversed ? "<-" : "->";
    return (
      `${index + 1}. ${step.from.label} ${arrow} ${step.relation} ${arrow} ${step.to.label} · ` +
      `${known(step.provenance, step.confidence)} · ${place(step.file, step.line)}`
    );
  });
  return [...lines, "", `Path confidence: ${answer.confidence}`].join("\n");
}

export function formatStats(stats: GraphStats, repoLinks: RepoLink[]): string {
  const { declared, extracted, inferred, ambiguous } = stats.links;
  const lines = [
    `# The graph: ${stats.nodeCount} documents, ${stats.edgeCount} links`,
    "",
    `Links: ${declared} declared · ${extracted} extracted · ${inferred} inferred · ${ambiguous} ambiguous (not drawn)`,
    "",
    "## Repositories",
  ];
  for (const repo of stats.repos) {
    const state = repo.behind
      ? `BEHIND: pushed ${repo.headCommit || "unknown"} at ${repo.pushedAt}, index at ${repo.indexedCommit || "unknown"}`
      : `index at ${repo.indexedCommit || "unknown"}`;
    lines.push(`- ${repo.repo}: ${repo.documents} documents, ${repo.links} links, ${state}`);
  }
  if (repoLinks.length > 0) {
    lines.push("", "## Repository links");
    for (const link of repoLinks) {
      lines.push(
        `- ${link.source} ${link.relation} ${link.target} · ` +
          `${known(link.provenance, link.confidence)} · ${place(link.file, link.line)}`
      );
    }
  }
  return lines.join("\n");
}

function refused(err: unknown) {
  // SYD-K028 and SYD-K029: the API's own words, so a document the caller may
  // not read reads exactly as one that does not exist.
  const status = (err as { status?: unknown }).status;
  if (status !== 404 && status !== 400) throw err;
  return {
    content: [{ type: "text" as const, text: (err as Error).message }],
    isError: true,
  };
}

export function registerDocumentGraph(server: McpServer, apiClient: SystemDoxApiClient): void {
  server.registerTool(
    "get_document_links",
    {
      description:
        "What one document links to and from, strongest first. Each link says how it is known: declared (a person made it), " +
        "extracted (the file says so), or inferred (a reading that could be wrong), with a confidence and the file and line it came from. " +
        "A reference that could mean several documents is listed as ambiguous with its candidates, and is never drawn as a link. " +
        "doc_id is the id get_docs returns. Read-only.",
      inputSchema: {
        doc_id: z.string().min(1).max(400).describe("A document id, as get_docs returns it"),
        direction: z.enum(["out", "in", "both"]).optional().describe("Default both"),
        relation: z
          .enum(["links_to", "cites", "mentions", "satisfies", "references"])
          .optional()
          .describe("Only links of this kind"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Most links to show (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ doc_id, direction, relation, limit }) => {
      const params: Record<string, string> = { doc: doc_id, limit: String(limit ?? DEFAULT_LIMIT) };
      if (direction) params.direction = direction;
      if (relation) params.relation = relation;
      try {
        const answer = await apiClient.get<Neighbours>("/v1/graph/neighbours", params);
        return { content: [{ type: "text" as const, text: formatNeighbours(answer) }] };
      } catch (err) {
        return refused(err);
      }
    }
  );

  server.registerTool(
    "trace_document_path",
    {
      description:
        "The shortest way two documents connect, walking links in either direction. Each step says how it is known, " +
        "and the path is only as strong as its weakest step. Read-only.",
      inputSchema: {
        from: z.string().min(1).max(400).describe("A document id, as get_docs returns it"),
        to: z.string().min(1).max(400).describe("A document id, as get_docs returns it"),
        max_hops: z
          .number()
          .int()
          .min(1)
          .max(MAX_HOPS)
          .optional()
          .describe(`Longest path to look for (default ${DEFAULT_HOPS})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, max_hops }) => {
      const hops = max_hops ?? DEFAULT_HOPS;
      try {
        const answer = await apiClient.get<GraphPath>("/v1/graph/path", {
          from,
          to,
          maxHops: String(hops),
        });
        return { content: [{ type: "text" as const, text: formatPath(answer, hops) }] };
      } catch (err) {
        return refused(err);
      }
    }
  );

  server.registerTool(
    "get_graph_stats",
    {
      description:
        "The state of the graph: links counted by how they are known, each repository's freshness (marked BEHIND when a push " +
        "has not finished indexing), and how repositories depend on each other, from the files that declare it. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // Never from the cache: a repository behind a minute ago may not be now.
      const [stats, repos] = await Promise.all([
        apiClient.getFresh<GraphStats>("/v1/graph/stats"),
        apiClient.getFresh<{ links: RepoLink[] }>("/v1/graph/repos"),
      ]);
      return { content: [{ type: "text" as const, text: formatStats(stats, repos.links) }] };
    }
  );
}
