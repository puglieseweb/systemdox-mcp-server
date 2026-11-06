import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";
import { configLink, workspaceBase } from "../lib/config-links.js";

interface ProjectSummary {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  description: string;
  url: string;
  itemCount: number;
  statusCounts: { todo: number; inProgress: number; done: number };
}

interface BoardItem {
  id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  repo: string;
  labels: string[];
  assignees: string[];
  fields: Record<string, string>;
}

interface BoardItemsResponse {
  items: BoardItem[];
  projectTitle?: string;
}

type Bucket = "todo" | "inProgress" | "done";

/** The API fetches board items in a single page of this size (GraphQL
 * `items(first: 100)` in planning_api). A full page means there may be more. */
const API_ITEM_PAGE = 100;
const DEFAULT_LIMIT = 50;

const BUCKET_LABELS: Record<Bucket, string> = {
  inProgress: "In Progress",
  todo: "Todo",
  done: "Done",
};

// Agents pick work off the top: what is moving, then what is available, then
// what is finished.
const BUCKET_ORDER: Bucket[] = ["inProgress", "todo", "done"];

const STATUS_ARG_TO_BUCKET: Record<string, Bucket> = {
  todo: "todo",
  in_progress: "inProgress",
  done: "done",
};

/**
 * Bucket one board item by its Status column.
 *
 * Boards name their columns differently, so match loosely — the same
 * done/ship/complete and progress/doing/review matching the backend uses for
 * the board-level counts (planning_api `_status_counts`). Where that helper
 * treats a *missing* Status as todo, this falls back to the issue's own
 * open/closed state, so a closed issue with no Status is never presented to an
 * agent as available work.
 */
export function bucketOf(item: Pick<BoardItem, "state" | "fields">): Bucket {
  const status = (item.fields?.Status ?? "").trim().toLowerCase();
  if (status) {
    if (
      status.includes("done") ||
      status.includes("ship") ||
      status.includes("complete")
    ) {
      return "done";
    }
    if (
      status.includes("progress") ||
      status.includes("doing") ||
      status.includes("review")
    ) {
      return "inProgress";
    }
    return "todo";
  }
  return item.state === "CLOSED" ? "done" : "todo";
}

function formatBoards(boards: ProjectSummary[]): string {
  const lines = boards.map((b) => {
    const c = b.statusCounts ?? { todo: 0, inProgress: 0, done: 0 };
    return (
      `- **${b.title}** — board #${b.number} · ${b.itemCount} item(s) ` +
      `(todo ${c.todo} · in progress ${c.inProgress} · done ${c.done})` +
      (b.description ? `\n  ${b.description}` : "") +
      `\n  ${b.url}`
    );
  });
  return lines.join("\n");
}

function formatItem(item: BoardItem): string {
  const meta: string[] = [];
  if (item.labels.length > 0) meta.push(`labels: ${item.labels.join(", ")}`);
  if (item.assignees.length > 0)
    meta.push(`assignees: ${item.assignees.join(", ")}`);
  const epic = item.fields?.Epic;
  if (epic) meta.push(`epic: ${epic}`);

  return (
    `- #${item.number} ${item.title}${item.repo ? ` — ${item.repo}` : ""}` +
    (meta.length > 0 ? `\n  ${meta.join(" · ")}` : "") +
    (item.url ? `\n  ${item.url}` : "")
  );
}

export function registerGetPlanBoard(
  server: McpServer,
  apiClient: SystemDoxApiClient
): void {
  server.registerTool(
    "get_plan_board",
    {
      title: "Get Plan Board",
      description:
        "Read the GitHub Projects boards connected to this workspace. With no arguments, lists the open boards with their item counts by status. With project_number, lists that board's issues grouped by status (In Progress / Todo / Done), each with issue number, title, repo, labels, assignees and URL — so you can see what is planned or in flight and pick up the right issue. Read-only: this tool cannot create, move, or close board items.",
      inputSchema: {
        project_number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Board number (the N in github.com/orgs/{org}/projects/N). Omit to list the open boards."
          ),
        status: z
          .enum(["todo", "in_progress", "done"])
          .optional()
          .describe(
            "With project_number, return only the items in this status group"
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe(
            `Max items to list (default ${DEFAULT_LIMIT}). Group headings always show the true totals.`
          ),
      },
    },
    async ({ project_number, status, limit }) => {
      // ── No board named: summarise the boards that exist ──────────────
      if (project_number === undefined) {
        const boards = await apiClient.get<ProjectSummary[]>(
          "/v1/planning/projects"
        );

        if (boards.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No project boards found. Connect a GitHub organisation and create a board at ${configLink("/plan", await workspaceBase(apiClient))}`,
              },
            ],
          };
        }

        const open = boards.filter((b) => !b.closed);
        if (open.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No open project boards (${boards.length} closed). Reopen one, or create a board at ${configLink("/plan", await workspaceBase(apiClient))}`,
              },
            ],
          };
        }

        const closedNote =
          boards.length > open.length
            ? `\n\n_${boards.length - open.length} closed board(s) not listed._`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${open.length} open project board(s):\n\n${formatBoards(open)}` +
                closedNote +
                `\n\nCall get_plan_board with project_number to list a board's issues.`,
            },
          ],
        };
      }

      // ── A board was named: list its items grouped by status ──────────
      const response = await apiClient.get<BoardItemsResponse>(
        `/v1/planning/projects/${project_number}/items`
      );
      const allItems = response.items ?? [];
      const boardName = response.projectTitle
        ? `**${response.projectTitle}** — board #${project_number}`
        : `Board #${project_number}`;

      if (allItems.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${boardName} has no issues, or it is not visible to this workspace's GitHub connection. Check the board at ${configLink("/plan", await workspaceBase(apiClient))}`,
            },
          ],
        };
      }

      const grouped: Record<Bucket, BoardItem[]> = {
        inProgress: [],
        todo: [],
        done: [],
      };
      for (const item of allItems) grouped[bucketOf(item)].push(item);

      const wanted = status ? [STATUS_ARG_TO_BUCKET[status]] : BUCKET_ORDER;
      const shown = wanted.reduce((n, b) => n + grouped[b].length, 0);

      if (shown === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${boardName}: no items with status "${status}" (of ${allItems.length} item(s) on the board).`,
            },
          ],
        };
      }

      // Render in bucket order until the cap is reached. Headings carry the
      // true group totals, so a cut section is visible rather than silent.
      const cap = limit ?? DEFAULT_LIMIT;
      let budget = cap;
      const sections: string[] = [];
      let rendered = 0;

      for (const b of wanted) {
        const items = grouped[b];
        if (items.length === 0) continue;
        const slice = items.slice(0, Math.max(budget, 0));
        budget -= slice.length;
        rendered += slice.length;
        const omitted = items.length - slice.length;
        sections.push(
          `### ${BUCKET_LABELS[b]} (${items.length})\n` +
            (slice.length > 0
              ? slice.map(formatItem).join("\n")
              : "_(not listed — item limit reached)_") +
            (omitted > 0 && slice.length > 0
              ? `\n_…${omitted} more not listed._`
              : "")
        );
      }

      const notes: string[] = [];
      if (rendered < shown) {
        notes.push(
          `_Listing ${rendered} of ${shown} matching item(s) — raise limit (max 200) or filter by status to see the rest._`
        );
      }
      if (allItems.length >= API_ITEM_PAGE) {
        notes.push(
          `_The API reads the board's first ${API_ITEM_PAGE} items; a larger board may have more._`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${boardName} — ${allItems.length} item(s)\n\n` +
              sections.join("\n\n") +
              (notes.length > 0 ? `\n\n${notes.join("\n")}` : ""),
          },
        ],
      };
    }
  );
}
