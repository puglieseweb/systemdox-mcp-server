import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

interface DocSection {
  heading: string;
  level: number;
  anchor: string;
  chunkId: string;
}

interface DocListResponse {
  items: Array<{
    id: string;
    repo_full_name: string;
    path: string;
    title: string;
    doc_type: string;
    scenario_count: number;
    size: number;
    synced_at: string;
    snippet?: string;
    outline?: DocSection[];
  }>;
  total: number;
  offset: number;
  limit: number;
}

interface DocContentResponse {
  content: string;
  cached?: boolean;
  error?: string;
  heading?: string;
  chunk_id?: string;
  section_resolved?: boolean;
}

// A path filter has to see past the listing's default page of 50.
const PATH_FILTER_LIMIT = "1000";

/** The part of a glob before its first wildcard, which the API can filter on. */
function literalPrefix(pattern: string): string {
  const wildcard = pattern.indexOf("*");
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard);
}

function matchGlob(path: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

export function registerGetDocs(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_docs",
    {
      title: "Get Docs",
      description:
        "Retrieve synced documentation from connected GitHub repositories. Filter by repo, file path pattern, or keyword search. Pass doc_id with section (a heading anchor) or chunk_id to retrieve just that section instead of the whole document.",
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe("Filter by repo (owner/repo format)"),
        path: z
          .string()
          .optional()
          .describe("File path glob pattern (e.g., docs/adr/*.md)"),
        search: z
          .string()
          .optional()
          .describe("Keyword search across document content"),
        doc_id: z
          .string()
          .optional()
          .describe(
            "Specific document ID to retrieve full content"
          ),
        section: z
          .string()
          .optional()
          .describe(
            "Heading anchor (e.g. 'rollback-strategy') — with doc_id, returns just that section"
          ),
        chunk_id: z
          .string()
          .optional()
          .describe(
            "Section chunk id ('{path_hash}#{anchor}') from get_context — with doc_id, returns just that section"
          ),
      },
    },
    async ({ repo, path, search, doc_id, section, chunk_id }) => {
      if (doc_id) {
        // A chunk_id ('{path_hash}#{anchor}') carries the anchor after '#'.
        const anchor =
          section ?? (chunk_id ? chunk_id.split("#").pop() : undefined);
        const doc = await apiClient.get<DocContentResponse>(
          `/v1/docs/${encodeURIComponent(doc_id)}/content`,
          anchor ? { section: anchor } : undefined
        );

        if (doc.error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error retrieving document: ${doc.error}`,
              },
            ],
            isError: true,
          };
        }

        // When a section was requested but didn't resolve, the API degrades to
        // the whole doc — say so rather than implying it's the section.
        let text = doc.content;
        if (anchor && doc.section_resolved === false) {
          text =
            `_Section "${anchor}" not found — returning the full document._\n\n` +
            text;
        } else if (anchor && doc.heading) {
          text = `## ${doc.heading}\n\n${doc.content}`;
        }

        return {
          content: [{ type: "text" as const, text }],
        };
      }

      const params: Record<string, string> = {};
      if (repo) params.repo = repo;
      if (search) params.q = search;
      if (path) {
        params.limit = PATH_FILTER_LIMIT;
        const prefix = literalPrefix(path);
        if (prefix) params.pathPrefix = prefix;
      }

      const response = await apiClient.get<DocListResponse>(
        "/v1/docs",
        params
      );

      let items = response.items;
      const unread = path ? response.total - response.items.length : 0;

      if (path) {
        items = items.filter((item) => matchGlob(item.path, path));
      }

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No documents found${repo ? ` in ${repo}` : ""}${path ? ` matching "${path}"` : ""}${search ? ` for "${search}"` : ""}.`,
            },
          ],
        };
      }

      const text = items
        .map((d) => {
          const sections = (d.outline ?? []).slice(0, 8);
          const sectionHint =
            sections.length > 0
              ? `\n  sections: ${sections.map((s) => s.anchor).join(", ")}`
              : "";
          return (
            `- **${d.title}** — \`${d.repo_full_name}/${d.path}\` (${d.doc_type}, ${d.size} bytes, synced ${d.synced_at})` +
            `\n  doc_id: \`${d.id}\`` +
            (d.snippet ? `\n  > ${d.snippet}` : "") +
            sectionHint
          );
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Found ${items.length} document(s) (${response.total} total):\n\n${text}\n\n` +
              (unread > 0
                ? `${unread} more were not read. Start the path with a folder to narrow it.\n\n`
                : "") +
              "Use doc_id for full content, or doc_id + section to fetch one section.",
          },
        ],
      };
    }
  );
}
