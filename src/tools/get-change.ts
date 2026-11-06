import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemDoxApiClient } from "../lib/api-client.js";

/**
 * get_change (ADR-218, specs/changes/change-page/contract.md §5.1): one change
 * as SystemDox last synced it, in one read of GET /v1/changes/{owner}/{repo}/{slug}
 * (openapi.yaml, operationId getChange). The answer is Markdown — the title,
 * key and size; the parts with their states and pull requests; the decision;
 * the contract files; every feature file with its scenarios as
 * `id · state · title`; the plan; the release pull requests — then the Change
 * object whole in a fenced JSON block, and last the brief's verdict. A build
 * session calls it first and stops when the brief is not passed (the
 * *Implement story* prompt template's first step).
 */

// ── The Change schema of openapi.yaml (components.schemas) ──────────────────

/** ADR-218 §2.3.2's five words, read from GitHub, never written by SystemDox. */
export type State = "not yet" | "waiting for your review" | "passed" | "being built" | "done";

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "merged";
  base: string;
  repo: string;
  openedAt: string;
  mergedAt: string | null;
  url: string;
  approvingReview: { by: string; at: string } | null;
}

export interface TrackedFile {
  path: string;
  docId: string;
  pullRequest: PullRequest | null;
  /** The file's last commit belongs to no pull request; it counts as merged. */
  direct: boolean;
}

export interface ScenarioCounts {
  proposed: number;
  built: number;
  defect: number;
  unbuilt: number;
  open: number;
  untagged: number;
  total: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** The state tag without `@`; empty when untagged. */
  state: "proposed" | "built" | "defect" | "unbuilt" | "open" | "";
  steps: string[];
}

export interface FeatureFile extends TrackedFile {
  title: string;
  runner: "pytest-bdd" | "vitest" | "node:test" | "";
  scenarios: Scenario[];
  counts: ScenarioCounts;
}

export interface Board {
  number: number;
  title: string;
  url: string;
  items: { todo: number; inProgress: number; done: number; truncated: boolean };
}

export interface Change {
  key: string;
  owner: string;
  repo: string;
  slug: string;
  title: string;
  size: "small" | "ordinary" | "foundational";
  archived: boolean;
  /** `decision` is null when the change has no decision (a small change). */
  states: { decision: State | null; contract: State; behaviour: State; plan: State; release: State };
  counts: ScenarioCounts;
  waitingForReview: PullRequest[];
  lastActivity: string;
  syncedAt: string;
  proposal: TrackedFile;
  decision: { adr: string; title: string; status: string; docId: string; pullRequest: PullRequest | null } | null;
  contract: {
    files: TrackedFile[];
    operations: { method: string; path: string; operationId: string; summary: string }[];
    channels: { name: string; address: string; messages: string[] }[];
  };
  behaviour: { files: FeatureFile[]; counts: ScenarioCounts };
  plan: { file: TrackedFile | null; draftId: string | null; board: Board | null };
  release: { prs: PullRequest[] };
}

type Part = keyof Change["states"];

// ── The rules ───────────────────────────────────────────────────────────────

/** The path parameters' patterns (openapi.yaml GitHubName and Slug): the tool
 * takes the repository as owner/name, each half a GitHubName. */
const GITHUB_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const REPO_RE = new RegExp(`^${GITHUB_NAME}/${GITHUB_NAME}$`);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX = 64;

/** The parts in the page's order (contract.md §1, §6). */
const PARTS: Part[] = ["decision", "contract", "behaviour", "plan", "release"];

/** The brief is the first four; the release is not part of it. */
const BRIEF: Part[] = ["decision", "contract", "behaviour", "plan"];

/**
 * A part has passed its review once it reads *passed* or a word after it:
 * behaviour and plan read *being built*, then *done*, once the build starts
 * (contract.md §2.2), and a build session must not stop on the build's own
 * progress. *not yet* and *waiting for your review* — and anything else a row
 * could hold — are a brief that waits: the check fails closed.
 */
const PAST_REVIEW: ReadonlySet<string> = new Set<State>(["passed", "being built", "done"]);

/**
 * The answer's last line (contract.md §5.1): "The brief is passed", or "The
 * brief is not passed: <part> is <state>", naming each part that waits in the
 * page's order. A change without a decision (`states.decision` null) is not
 * held up by one.
 */
export function briefVerdict(states: Change["states"]): string {
  const waiting = BRIEF.filter(
    (part) => !(part === "decision" && states.decision === null) && !PAST_REVIEW.has(String(states[part]))
  ).map((part) => `${part} is ${states[part] ?? "unknown"}`);
  return waiting.length === 0
    ? "The brief is passed"
    : `The brief is not passed: ${waiting.join(", ")}`;
}

// ── The answer ──────────────────────────────────────────────────────────────

function prLink(pr: PullRequest): string {
  return `[${pr.repo}#${pr.number}](${pr.url}) ${pr.state}`;
}

/** Where a tracked file stands: its pull request, or pushed without one. */
function fileSource(file: TrackedFile): string {
  if (file.pullRequest) return prLink(file.pullRequest);
  return file.direct ? "committed directly" : "—";
}

/** The pull requests behind a part, each once, the open ones first: an open
 * one is what the part waits on. */
function partPullRequests(change: Change, part: Part): PullRequest[] {
  const files: (TrackedFile | null)[] =
    part === "contract" ? change.contract.files
    : part === "behaviour" ? change.behaviour.files
    : part === "plan" ? [change.plan.file]
    : [];
  const prs =
    part === "decision" ? [change.decision?.pullRequest ?? null]
    : part === "release" ? change.release.prs
    : files.map((file) => file?.pullRequest ?? null);
  const unique = new Map<string, PullRequest>();
  for (const pr of prs) {
    if (pr && !unique.has(`${pr.repo}#${pr.number}`)) unique.set(`${pr.repo}#${pr.number}`, pr);
  }
  return [...unique.values()].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"));
}

function countsLine(counts: ScenarioCounts): string {
  const tags = (["proposed", "built", "defect", "unbuilt", "open", "untagged"] as const)
    .filter((tag) => counts[tag] > 0)
    .map((tag) => `${counts[tag]} ${tag}`);
  return `${counts.total} scenario(s)` + (tags.length > 0 ? `: ${tags.join(", ")}` : "");
}

function partsTable(change: Change): string {
  const rows = PARTS.filter((part) => !(part === "decision" && change.states.decision === null)).map((part) => {
    const prs = partPullRequests(change, part);
    return `| ${part} | ${change.states[part]} | ${prs.length > 0 ? prs.map(prLink).join(", ") : "—"} |`;
  });
  return ["| Part | State | Pull request |", "|---|---|---|", ...rows].join("\n");
}

function decisionSection(change: Change): string {
  const decision = change.decision;
  if (decision === null) return "## Decision\n\nNone: the proposal names no ADR (a small change).";
  // Status and title are empty when no connected repository holds the record.
  const status = decision.status || "no record in a connected repository";
  return `## Decision\n\n${decision.adr} · ${status}${decision.title ? ` — ${decision.title}` : ""}`;
}

function contractSection(change: Change): string {
  const files = change.contract.files;
  return (
    "## Contract\n\n" +
    (files.length > 0
      ? files.map((file) => `- ${file.path} — ${fileSource(file)}`).join("\n")
      : "No contract file yet (openapi.yaml, asyncapi.yaml or contract.md).")
  );
}

function behaviourSection(change: Change): string {
  const { files, counts } = change.behaviour;
  if (files.length === 0) {
    return (
      "## Behaviour\n\nNo feature file names this change. A feature file joins it when its path or its first " +
      `ten lines name \`${change.slug}\`${change.decision ? ` or ${change.decision.adr}` : ""}.`
    );
  }
  const blocks = files.map((file) =>
    [
      `### ${file.path}`,
      "",
      [file.title, file.runner ? `runner ${file.runner}` : "", fileSource(file), countsLine(file.counts)]
        .filter(Boolean)
        .join(" · "),
      "",
      ...file.scenarios.map((s) => `- ${s.id || "(no id)"} · ${s.state || "untagged"} · ${s.title}`),
    ].join("\n")
  );
  return ["## Behaviour", countsLine(counts), ...blocks].join("\n\n");
}

function planSection(change: Change): string {
  const { file, draftId, board } = change.plan;
  const boardLine = board
    ? `[#${board.number} ${board.title}](${board.url}) — todo ${board.items.todo} · in progress ` +
      `${board.items.inProgress} · done ${board.items.done}` +
      (board.items.truncated ? " (counted over its first 500 items)" : "")
    : "none";
  return [
    "## Plan",
    "",
    `- plan.md: ${file ? `${file.path} — ${fileSource(file)}` : "none"}`,
    `- Draft: ${draftId ?? "none"}`,
    `- Board: ${boardLine}`,
  ].join("\n");
}

function releaseSection(change: Change): string {
  const lines = change.release.prs.map(
    (pr) =>
      `- ${prLink(pr)} · ${pr.title} · ` +
      (pr.approvingReview
        ? `approved by ${pr.approvingReview.by} at ${pr.approvingReview.at}`
        : "no approving review on its head yet")
  );
  return `## Release\n\n${lines.length > 0 ? lines.join("\n") : "No release pull request is open."}`;
}

/** The answer of contract.md §5.1, its verdict on the last line. */
export function formatChange(change: Change): string {
  const header =
    `# ${change.title}\n\n` +
    `\`${change.key}\` · size: ${change.size}` +
    (change.archived ? " · archived: read-only, done" : "") +
    ` · synced ${change.syncedAt}`;
  return [
    header,
    partsTable(change),
    decisionSection(change),
    contractSection(change),
    behaviourSection(change),
    planSection(change),
    releaseSection(change),
    // Compact: a change's every scenario with its steps rides in this block.
    "```json\n" + JSON.stringify(change) + "\n```",
    briefVerdict(change.states),
  ].join("\n\n");
}

export function registerGetChange(
  server: McpServer,
  apiClient: Pick<SystemDoxApiClient, "getFresh">
): void {
  server.registerTool(
    "get_change",
    {
      title: "Get Change",
      description:
        "Read one change (a specs/changes/<slug>/ folder of a connected repository) as SystemDox last synced it from GitHub: " +
        "the state of each part of its brief (decision, contract, behaviour, plan) and of its release, each with its pull request; " +
        "the decision's ADR and status; the contract files; every feature file that names the change, with its scenarios as id · state · title; " +
        "the plan (plan.md, the draft, the board); the release pull requests; and the Change object as JSON. " +
        'The last line says "The brief is passed" or "The brief is not passed: <part> is <state>". ' +
        "Call it before building a story, and stop if the brief is not passed or the story's scenarios are not proposed. Read-only.",
      inputSchema: {
        repo: z
          .string()
          .regex(REPO_RE, "the repository as owner/name, e.g. acme/booking-api")
          .describe("The repository that holds the change, as owner/name"),
        slug: z
          .string()
          .max(SLUG_MAX)
          .regex(SLUG_RE, "a change folder's name: lower-case words joined by -, e.g. customer-reminders")
          .describe("The change's folder name: specs/changes/<slug>/"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, slug }) => {
      const [owner, name] = repo.split("/");
      let change: Change;
      try {
        // Never from the cache: a build session acts on the brief as it is
        // now, and the owner may have merged a minute ago.
        change = await apiClient.getFresh<Change>(
          `/v1/changes/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`
        );
      } catch (err) {
        // SYD-K023: no such change, or one the caller may not read — the same
        // answer, so the caller learns nothing (contract.md §1). Any other
        // refusal is the API's own error, as the client reports it.
        if ((err as { status?: unknown }).status === 404) {
          return {
            content: [{ type: "text" as const, text: `No such change ${repo}/${slug}` }],
            isError: true,
          };
        }
        throw err;
      }
      return { content: [{ type: "text" as const, text: formatChange(change) }] };
    }
  );
}
