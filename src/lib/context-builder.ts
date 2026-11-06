import { detectLanguages } from "./language.js";
import {
  estimateTokens,
  extractKeywords,
  scoreItems,
  selectWithinBudget,
  truncateToTokens,
  type ScoredItem,
} from "./scoring.js";
import { isDecisionDraft, specLabel } from "./spec-label.js";

export { estimateTokens } from "./scoring.js";

/**
 * Structural subset of SystemDoxApiClient. Keeps the builder testable with a
 * fake client and free of transport/auth concerns.
 */
export interface ContextApiClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

export interface Guardrail {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  pattern: string;
  fix: string;
  updatedAt: string;
}

export interface SpecSummary {
  draftId: string;
  name: string;
  status: string;
  requirementCount: number;
  updatedAt: string;
}

/** Documentation capability states (GET /v1/doc-repos — guided-repo-setup).
 *  'disabled' is a workspace's deliberate opt-out: those concerns must not
 *  be advertised to agents at all. */
interface DocReposResponse {
  capabilities?: Partial<
    Record<
      'requirements' | 'design' | 'specs' | 'fitness' | 'components',
      { status?: string }
    >
  >;
}

interface SpecDetail {
  draftId: string;
  name: string;
  status: string;
  proposalContent?: string;
  taskContent?: string;
  requirements?: Array<{ reqId: string; name: string; content: string }>;
}

/** One heading-scoped section of a document (#865). */
export interface DocSection {
  heading: string;
  level: number;
  anchor: string;
  chunkId: string;
}

export interface DocListResponse {
  items: Array<{
    id: string;
    repo_full_name: string;
    path: string;
    title: string;
    doc_type: string;
    size: number;
    synced_at: string;
    /** Structured section outline, when the doc has been re-indexed (#865). */
    outline?: DocSection[];
  }>;
}

interface DocContentResponse {
  content?: string;
  cached?: boolean;
  error?: string;
  /** Section-scoped fields, present when ?section= resolved (#865). */
  heading?: string;
  chunk_id?: string;
  section_resolved?: boolean;
}

export interface TechStackEntry {
  id: string;
  name: string;
  category: string;
  version?: string;
  notes?: string;
}

export interface ProjectRule {
  id: string;
  text: string;
  category: string;
  createdAt: string;
}

export interface BuildContextOptions {
  taskDescription: string;
  filePaths?: string[];
  maxTokens?: number;
}

export interface ContextStats {
  budget: number;
  tokensUsed: number;
  /** Ranked spec/doc items whose full text was fetched and included. */
  itemsWithBody: number;
  /** Items whose body fetch failed — listed by title + ID instead. */
  bodyFailures: number;
  /** Ranked items that appear only as a title + ID (no body fetched). */
  itemsListed: number;
  /** Ranked items that did not fit at all. */
  itemsOmitted: number;
  guardrails: number;
}

export interface ContextResult {
  text: string;
  stats: ContextStats;
}

const DEFAULT_BUDGET = 4000;

// Section headings, item separators and the footer are not individually
// accounted; this covers them.
const RESERVE_TOKENS = 200;

// Guardrails ship their body already, so they can starve the fetched bodies —
// which are the whole point of the tool. Cap their share of the budget.
const GUARDRAIL_SHARE = 0.35;

// Below this a body is too clipped to be worth its tokens — list the item instead.
const MIN_BODY_TOKENS = 150;
const MAX_HYDRATED = 8;

// The bibliography tail: enough for the agent to follow up, never enough to
// crowd out the bodies.
const MAX_TAIL = 10;
const TAIL_SHARE = 0.15;
const TRUNCATION_NOTICE_TOKENS = 30;

// The stack is useful, not binding: it may not crowd out what the task needs.
const STACK_SHARE = 0.1;

// However tight the budget, this many references are named with their IDs.
const MIN_REFERENCES = 3;

// /v1/docs answers a page, far short of a workspace's documents, so candidates
// come from its search. A task is a sentence, and a URL has limits.
const SEARCH_RESULTS = 30;
const MAX_QUERY_CHARS = 300;

type RefType = "spec" | "doc";

interface RefMeta {
  type: RefType;
  id: string;
  title: string;
  /** Compact one-liner for the bibliography tail. */
  listLine: string;
  /** How the agent fetches the full text itself. */
  fetchHint: string;
  /** Section pointer (#865, docs only): the section this ref is scoped to,
   * plus a rendered `path#anchor · chunk_id · deep-link` line. */
  section?: DocSection;
  pointer?: string;
}

function formatGuardrail(g: Guardrail): string {
  let text = `## ${g.title} [${g.severity}]\n\n${g.description}`;
  if (g.pattern) text += `\n\n**Bad:** \`\`\`\n${g.pattern}\n\`\`\``;
  if (g.fix) text += `\n\n**Good:** \`\`\`\n${g.fix}\n\`\`\``;
  return text;
}

function formatSpecHeadline(s: SpecSummary): string {
  return (
    `### ${s.name}\n` +
    `\`draft_id: ${s.draftId}\` · ${s.status} · ${specLabel(s)}`
  );
}

function formatDocHeadline(d: DocListResponse["items"][0]): string {
  return (
    `### ${d.title}\n` +
    `\`doc_id: ${d.id}\` · \`${d.repo_full_name}/${d.path}\` · ${d.doc_type}`
  );
}

function formatStack(entries: TechStackEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${e.name}${e.version ? ` v${e.version}` : ""}${e.notes ? ` — ${e.notes}` : ""}`
    )
    .join("\n");
}

/** The stack entries the budget allows, those the task names first. */
function selectStack(
  entries: TechStackEntry[],
  words: string[],
  maxTokens: number
): { text: string; hidden: number } {
  const named = (e: TechStackEntry) => {
    const entry = `${e.name} ${e.notes ?? ""}`.toLowerCase();
    return words.some((w) => entry.includes(w));
  };
  const ordered = [...entries.filter(named), ...entries.filter((e) => !named(e))];

  const shown: TechStackEntry[] = [];
  for (const entry of ordered) {
    if (shown.length > 0 && estimateTokens(formatStack([...shown, entry])) > maxTokens) {
      break;
    }
    shown.push(entry);
  }
  return { text: formatStack(shown), hidden: entries.length - shown.length };
}

function formatRules(rules: ProjectRule[]): string {
  const byCategory = new Map<string, ProjectRule[]>();
  for (const r of rules) {
    const cat = r.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  let text = "";
  for (const [cat, catRules] of byCategory) {
    text += `### ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`;
    for (const r of catRules) {
      text += `- ${r.text}\n`;
    }
    text += "\n";
  }
  return `## Project Rules (${rules.length})\n\n${text.trim()}`;
}

/**
 * The documents to rank. The search reads the whole workspace, in order of
 * relevance. The listing is the fallback for a search that fails or finds
 * nothing, and its order says nothing about the task.
 */
async function findDocs(
  api: ContextApiClient,
  taskDescription: string
): Promise<DocListResponse & { searched: boolean }> {
  const query = taskDescription.trim().slice(0, MAX_QUERY_CHARS);
  if (query) {
    try {
      const found = await api.get<DocListResponse>("/v1/docs", {
        q: query,
        limit: String(SEARCH_RESULTS),
      });
      if (found.items.length > 0) return { ...found, searched: true };
    } catch {
      // The listing below still answers.
    }
  }
  const listed = await api.get<DocListResponse>("/v1/docs");
  return { ...listed, searched: false };
}

async function fetchSpecBody(
  api: ContextApiClient,
  draftId: string
): Promise<string> {
  const spec = await api.get<SpecDetail>(
    `/v1/specs/${encodeURIComponent(draftId)}`
  );

  const parts: string[] = [];
  if (spec.proposalContent) {
    parts.push(`**Proposal**\n\n${spec.proposalContent}`);
  }
  for (const r of spec.requirements ?? []) {
    parts.push(`**${r.name}**\n\n${r.content}`);
  }
  if (spec.taskContent) {
    parts.push(`**Tasks**\n\n${spec.taskContent}`);
  }

  const body = parts.join("\n\n").trim();
  if (!body) throw new Error("spec has no content");
  return body;
}

async function fetchDocBody(
  api: ContextApiClient,
  docId: string,
  anchor?: string
): Promise<string> {
  const doc = await api.get<DocContentResponse>(
    `/v1/docs/${encodeURIComponent(docId)}/content`,
    anchor ? { section: anchor } : undefined
  );

  // The endpoint reports GitHub/installation failures in-band with a 200.
  if (doc.error) throw new Error(doc.error);

  const body = (doc.content ?? "").trim();
  if (!body) throw new Error("document is empty");
  return body;
}

// A section deep-links to its GitHub blob — always resolvable for a synced
// repo, no publish step required, and github-slugger anchors match ours for
// the common case. (Retrieval by chunk_id goes through get_docs, not this URL.)
function githubDeepLink(
  repoFullName: string,
  path: string,
  anchor: string
): string {
  return `https://github.com/${repoFullName}/blob/HEAD/${path}#${anchor}`;
}

function formatSectionPointer(
  repoFullName: string,
  path: string,
  s: DocSection
): string {
  return (
    `\`${path}#${s.anchor}\` · \`chunk_id: ${s.chunkId}\` · ` +
    `[${s.heading}](${githubDeepLink(repoFullName, path, s.anchor)})`
  );
}

const SECTION_STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with",
  "how", "why", "what", "add", "new", "use", "using", "update", "fix",
]);

/**
 * Pick the section whose heading best matches the task, so a doc that matched
 * on one keyword is scoped to the relevant section rather than truncated from
 * its top. Falls back to the first section; returns undefined for an
 * outline-less (not-yet-reindexed) doc so it degrades to whole-doc behaviour.
 */
function selectSection(
  outline: DocSection[] | undefined,
  taskDescription: string
): DocSection | undefined {
  if (!outline || outline.length === 0) return undefined;

  const keywords = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SECTION_STOP_WORDS.has(w));

  let best = outline[0];
  let bestScore = -1;
  for (const s of outline) {
    const heading = s.heading.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (heading.includes(kw)) score++;
    // Prefer the earliest of equally-scoring sections (document order).
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

interface Hydrated {
  item: ScoredItem;
  meta: RefMeta;
  body?: string;
  error?: string;
}

async function hydrate(
  api: ContextApiClient,
  item: ScoredItem,
  meta: RefMeta
): Promise<Hydrated> {
  try {
    const body =
      meta.type === "spec"
        ? await fetchSpecBody(api, meta.id)
        : await fetchDocBody(api, meta.id, meta.section?.anchor);
    return { item, meta, body };
  } catch (err) {
    return {
      item,
      meta,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rank every context item against the task, then spend the token budget on the
 * *bodies* of the highest-ranked specs and docs — fetched concurrently, clipped
 * to a fair share of what's left, and always accompanied by the ID the agent
 * needs to fetch the rest itself.
 */
export async function buildContext(
  api: ContextApiClient,
  { taskDescription, filePaths = [], maxTokens }: BuildContextOptions
): Promise<ContextResult> {
  const budget = maxTokens ?? DEFAULT_BUDGET;

  // One read failing still answers with the others. All of them failing is not
  // "nothing found": with no key, or a refused one, that reply told an agent the
  // team has no rules (ADR-223), so the failure is thrown instead.
  const failures: unknown[] = [];
  const orEmpty =
    <T>(empty: T) =>
    (err: unknown): T => {
      failures.push(err);
      return empty;
    };
  const [rawGuardrails, rawSpecs, docs, stack, rules, docRepos] = await Promise.all([
    api.get<Guardrail[]>("/v1/guardrails").catch(orEmpty([] as Guardrail[])),
    api.get<SpecSummary[]>("/v1/specs").catch(orEmpty([] as SpecSummary[])),
    findDocs(api, taskDescription).catch(
      orEmpty({ items: [], searched: false } as DocListResponse & { searched: boolean })
    ),
    api
      .get<TechStackEntry[]>("/v1/ai/settings/stack")
      .catch(orEmpty([] as TechStackEntry[])),
    api
      .get<ProjectRule[]>("/v1/standards/rules")
      .catch(orEmpty([] as ProjectRule[])),
    // Capability states — FAIL-OPEN: an unreadable config (older backend, a
    // blip) gates nothing, it can never hide working context.
    api.get<DocReposResponse>("/v1/doc-repos").catch(() => null),
  ]);
  if (failures.length === 5) throw failures[0];

  // A 'disabled' capability is the workspace's deliberate opt-out
  // (guided-repo-setup Phase D): its concerns are not advertised to agents.
  const disabled = (key: "requirements" | "design" | "specs" | "fitness" | "components") =>
    docRepos?.capabilities?.[key]?.status === "disabled";

  // fitness backs the whole Checks concern — drop its items before ranking so
  // the "## Checks" section never renders. The specs listing carries no
  // docType, so it gates as a whole only when every spec-document concern
  // (requirements, design, specs) is disabled. /v1/docs (indexed repo docs)
  // stays ungated: it spans READMEs and general documentation well beyond the
  // components capability.
  const guardrails = disabled("fitness") ? [] : rawGuardrails;
  const specs =
    disabled("requirements") && disabled("design") && disabled("specs")
      ? []
      : rawSpecs;

  const refs = new Map<string, RefMeta>();
  const key = (type: string, id: string) => `${type}:${id}`;

  // report_decision keeps a draft of a decision. Once its ADR is indexed, the
  // ADR is the one to read.
  const docTitles = new Set(docs.items.map((d) => d.title));
  const isCopyOfDoc = (s: SpecSummary) =>
    isDecisionDraft(s.name) && docTitles.has(s.name.slice("ADR: ".length));

  const scorable = [
    ...guardrails.map((g) => ({
      type: "guardrail" as const,
      id: g.id,
      title: g.title,
      content: formatGuardrail(g),
      category: g.category,
      severity: g.severity,
      updatedAt: g.updatedAt,
    })),
    ...specs
      .filter((s) => s.status !== "archived" && !isCopyOfDoc(s))
      .map((s) => {
        refs.set(key("spec", s.draftId), {
          type: "spec",
          id: s.draftId,
          title: s.name,
          listLine: `- **${s.name}** — \`draft_id: ${s.draftId}\` (${s.status}, ${specLabel(s)})`,
          fetchHint: `get_specs(draft_id="${s.draftId}")`,
        });
        return {
          type: "spec" as const,
          id: s.draftId,
          title: s.name,
          content: formatSpecHeadline(s),
          updatedAt: s.updatedAt,
        };
      }),
    ...docs.items.map((d, position) => {
      const section = selectSection(d.outline, taskDescription);
      const pointer = section
        ? formatSectionPointer(d.repo_full_name, d.path, section)
        : undefined;
      refs.set(key("doc", d.id), {
        type: "doc",
        id: d.id,
        title: d.title,
        section,
        pointer,
        listLine:
          `- **${d.title}** — \`doc_id: ${d.id}\` (\`${d.repo_full_name}/${d.path}\`)` +
          (pointer ? `\n  ↳ ${pointer}` : ""),
        fetchHint: section
          ? `get_docs(doc_id="${d.id}", section="${section.anchor}")`
          : `get_docs(doc_id="${d.id}")`,
      });
      return {
        type: "doc" as const,
        id: d.id,
        title: d.title,
        content: formatDocHeadline(d),
        category: d.doc_type === "adr" ? "architecture" : undefined,
        updatedAt: d.synced_at,
        path: d.path,
        relevance: docs.searched
          ? 1 - position / (2 * docs.items.length)
          : undefined,
      };
    }),
  ];

  const ranked = scoreItems(scorable, taskDescription, filePaths);

  const sections: string[] = [];
  let overhead = 0;

  // Project rules govern every task: they are never ranked away, only charged
  // against the budget. The stack is capped, and the rest is one call away.
  if (stack.length > 0) {
    const { text, hidden } = selectStack(
      stack,
      [...extractKeywords(taskDescription), ...detectLanguages(filePaths)],
      Math.floor(budget * STACK_SHARE)
    );
    const section =
      `## Tech Stack\n\n${text}` +
      (hidden > 0 ? `\n\n_${hidden} more with \`get_tech_stack\`._` : "");
    sections.push(section);
    overhead += estimateTokens(section);
  }
  if (rules.length > 0) {
    const section = formatRules(rules);
    sections.push(section);
    overhead += estimateTokens(section);
  }

  let remaining = budget - RESERVE_TOKENS - overhead;

  const rankedGuardrails = ranked.filter((i) => i.type === "guardrail");
  const { selected: selectedGuardrails, tokensUsed: guardrailTokens } =
    selectWithinBudget(
      rankedGuardrails,
      Math.max(0, Math.floor(remaining * GUARDRAIL_SHARE))
    );
  remaining -= guardrailTokens;

  const rankedRefs = ranked.filter(
    (i) => i.type === "spec" || i.type === "doc"
  );

  // How many bodies can we afford at all? Each costs its headline plus a body
  // worth reading.
  const avgHeadline = rankedRefs.length
    ? Math.ceil(
        rankedRefs
          .slice(0, MAX_HYDRATED)
          .reduce((sum, i) => sum + i.tokenEstimate, 0) /
          Math.min(rankedRefs.length, MAX_HYDRATED)
      )
    : 0;
  const affordable = Math.floor(
    Math.max(0, remaining) / (MIN_BODY_TOKENS + avgHeadline)
  );
  const shortlist = rankedRefs.slice(
    0,
    Math.max(0, Math.min(MAX_HYDRATED, affordable))
  );

  // Headlines ship whatever happens: a title + ID the agent can follow is the
  // floor, not the ceiling.
  for (const item of shortlist) {
    remaining -= item.tokenEstimate;
  }
  remaining = Math.max(0, remaining);

  const hydrated = await Promise.all(
    shortlist.map((item) =>
      hydrate(api, item, refs.get(key(item.type, item.id))!)
    )
  );

  const tailCandidates = rankedRefs
    .slice(shortlist.length, shortlist.length + MAX_TAIL)
    .map((i) => refs.get(key(i.type, i.id))!);
  const tailCost = tailCandidates.reduce(
    (sum, m) => sum + estimateTokens(m.listLine),
    0
  );
  const tailReserve = Math.min(
    tailCost,
    Math.floor(remaining * TAIL_SHARE)
  );

  // Fair-share the body budget in rank order, recomputing the cap each round so
  // a short body hands its unspent allowance to the next item.
  const bodyBudgetStart = Math.max(0, remaining - tailReserve);
  let bodyBudget = bodyBudgetStart;
  let itemsLeft = hydrated.length;
  let itemsWithBody = 0;
  let bodyFailures = 0;

  const blocks: string[] = [];

  for (const h of hydrated) {
    itemsLeft--;

    // A doc's headline carries its section pointer (path#anchor · chunk_id ·
    // deep-link) so even a budget-omitted section is citable and fetchable.
    const headline = h.meta.pointer
      ? `${h.item.content}\n${h.meta.pointer}`
      : h.item.content;

    // The headline is already paid for; charge whatever the block adds on top.
    const emit = (block: string) => {
      bodyBudget -= Math.max(
        0,
        estimateTokens(block) - h.item.tokenEstimate
      );
      blocks.push(block);
    };

    if (h.error !== undefined) {
      bodyFailures++;
      emit(
        `${headline}\n\n_Body unavailable (${h.error}) — retry with \`${h.meta.fetchHint}\`._`
      );
      continue;
    }

    const available = Math.max(0, bodyBudget);
    const allowance = Math.min(
      Math.max(MIN_BODY_TOKENS, Math.floor(available / (itemsLeft + 1))),
      available
    );

    if (allowance < MIN_BODY_TOKENS) {
      emit(
        `${headline}\n\n_Body omitted (token budget exhausted) — fetch with \`${h.meta.fetchHint}\`._`
      );
      continue;
    }

    const { text: body, truncated } = truncateToTokens(
      h.body!,
      allowance - TRUNCATION_NOTICE_TOKENS
    );
    itemsWithBody++;
    emit(
      `${headline}\n\n${body}` +
        (truncated
          ? `\n\n_[truncated to fit the token budget — full text via \`${h.meta.fetchHint}\`]_`
          : "")
    );
  }

  remaining = Math.max(0, remaining - (bodyBudgetStart - bodyBudget));

  if (selectedGuardrails.length > 0) {
    sections.push(
      `## Checks (${selectedGuardrails.length})\n\n` +
        selectedGuardrails.map((i) => i.content).join("\n\n---\n\n")
    );
  }

  if (blocks.length > 0) {
    sections.push(
      `## Relevant Specs & Docs (${blocks.length})\n\n` +
        `_Highest-ranked items — docs are scoped to their most relevant section. ` +
        `Each carries the ID / \`chunk_id\` to fetch more._\n\n` +
        blocks.join("\n\n---\n\n")
    );
  }

  // Bibliography tail — titles + IDs only, for anything the budget could not
  // carry the body of.
  const tailLines: string[] = [];
  for (const meta of tailCandidates) {
    const cost = estimateTokens(meta.listLine);
    const named = blocks.length + tailLines.length;
    if (cost > remaining && named >= MIN_REFERENCES) break;
    tailLines.push(meta.listLine);
    remaining = Math.max(0, remaining - cost);
  }

  if (tailLines.length > 0) {
    sections.push(
      `## Also Indexed (${tailLines.length})\n\n` +
        `_Ranked lower — fetch with \`get_specs\` / \`get_docs\` if you need them._\n\n` +
        tailLines.join("\n")
    );
  }

  const itemsListed = blocks.length - itemsWithBody + tailLines.length;
  const itemsOmitted =
    ranked.length -
    selectedGuardrails.length -
    blocks.length -
    tailLines.length;

  const body = sections.join("\n\n");
  const tokensUsed = estimateTokens(body);

  const stats: ContextStats = {
    budget,
    tokensUsed,
    itemsWithBody,
    bodyFailures,
    itemsListed,
    itemsOmitted: Math.max(0, itemsOmitted),
    guardrails: selectedGuardrails.length,
  };

  if (sections.length === 0) {
    // Some reads failed: "nothing found" would read as an all-clear to an agent told
    // to obey what this returns.
    const text = failures.length
      ? `No context found for this task, but ${failures.length} of 5 reads failed, so this is not an all-clear: the team's rules may not have been read.`
      : "No relevant context found for this task.";
    return { text, stats };
  }

  const footer =
    `\n\n---\n_Context: ${itemsWithBody} full text, ${itemsListed} listed, ` +
    `${stats.itemsOmitted} omitted · ~${tokensUsed} of ${budget} tokens` +
    (bodyFailures > 0 ? ` · ${bodyFailures} body fetch(es) failed` : "") +
    (failures.length > 0 ? ` · ${failures.length} of 5 reads failed` : "") +
    `_`;

  return { text: body + footer, stats };
}
