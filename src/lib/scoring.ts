import { detectCategories, detectLanguages } from "./language.js";

export interface ScoredItem {
  type: "guardrail" | "spec" | "doc" | "stack";
  id: string;
  title: string;
  content: string;
  score: number;
  tokenEstimate: number;
}

interface ScorableItem {
  type: "guardrail" | "spec" | "doc" | "stack";
  id: string;
  title: string;
  content: string;
  language?: string;
  category?: string;
  severity?: string;
  updatedAt?: string;
  /** Where a document's repository file lives. */
  path?: string;
  /** 0 to 1, from the order the document search returned it in. */
  relevance?: number;
}

const WEIGHT_PATH = 0.4;
const WEIGHT_KEYWORD = 0.3;
const WEIGHT_RECENCY = 0.15;
const WEIGHT_SEVERITY = 0.15;

const SEVERITY_SCORES: Record<string, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

// A spec or document is relevant because it matches the task, never because it
// is recent: a sync stamps every document with the same time. A title must cover
// this share of the task's words to count, so one common word cannot carry it.
const MIN_TITLE_SHARE = 1 / 3;

// A changelog entry says what happened, not how the system works, so a decision
// or a design about the same words comes first.
const RECORD_PATH = /(^|\/)changelog\//;
const RECORD_FACTOR = 0.5;

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Clip text to a token allowance, backing off to the last paragraph or line
 * break in the final quarter so the cut lands between thoughts rather than
 * mid-sentence.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number
): { text: string; truncated: boolean } {
  const maxChars = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };

  const head = text.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.75);
  const paragraph = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");

  let cut = maxChars;
  if (paragraph >= floor) cut = paragraph;
  else if (line >= floor) cut = line;

  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}

function scorePathMatch(
  item: ScorableItem,
  languages: string[],
  categories: string[]
): number {
  if (languages.length === 0 && categories.length === 0) return 0.5;

  let score = 0;
  const itemLang = item.language?.toLowerCase() ?? "";
  const itemCat = item.category?.toLowerCase() ?? "";

  if (itemLang && languages.some((l) => itemLang.includes(l))) {
    score += 0.6;
  }

  if (itemCat && categories.some((c) => itemCat.includes(c))) {
    score += 0.4;
  }

  return Math.min(score, 1.0);
}

function scoreKeywordMatch(item: ScorableItem, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const searchable = `${item.title} ${item.content}`.toLowerCase();
  let matches = 0;
  for (const kw of keywords) {
    if (searchable.includes(kw)) matches++;
  }

  return Math.min(matches / keywords.length, 1.0);
}

function scoreRecency(item: ScorableItem): number {
  if (!item.updatedAt) return 0.5;

  const now = Date.now();
  const updated = new Date(item.updatedAt).getTime();
  const daysSince = (now - updated) / (1000 * 60 * 60 * 24);

  if (daysSince <= 7) return 1.0;
  if (daysSince <= 30) return 0.75;
  if (daysSince <= 90) return 0.5;
  return 0.25;
}

function scoreSeverity(item: ScorableItem): number {
  if (!item.severity) return 0.5;
  return SEVERITY_SCORES[item.severity] ?? 0.5;
}

/** One word's stem, so "links" and "link" count as the same word. */
function stem(word: string): string {
  return word.length > 3 ? word.replace(/s$/, "") : word;
}

function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stem)
  );
}

/** The share of the task's distinct words that the title holds. */
function titleShare(title: string, keywords: string[]): number {
  const wanted = stems(keywords.join(" "));
  if (wanted.size === 0) return 0;
  const held = stems(title);
  let matches = 0;
  for (const word of wanted) {
    if (held.has(word)) matches++;
  }
  return matches / wanted.size;
}

function scoreReference(item: ScorableItem, keywords: string[]): number {
  const share = titleShare(item.title, keywords);
  const score = Math.max(
    item.relevance ?? 0,
    share >= MIN_TITLE_SHARE ? share : 0
  );
  return RECORD_PATH.test(item.path ?? "") ? score * RECORD_FACTOR : score;
}

export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "between",
    "through", "after", "before", "during", "without", "this", "that",
    "these", "those", "it", "its", "and", "or", "but", "not", "no",
    "all", "each", "every", "both", "few", "more", "most", "other",
    "some", "such", "than", "too", "very", "just", "also", "only",
    "new", "add", "update", "fix", "change", "make", "use", "get",
    "set", "need", "want", "implement", "create",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

export function scoreItems(
  items: ScorableItem[],
  taskDescription: string,
  filePaths: string[]
): ScoredItem[] {
  const languages = detectLanguages(filePaths);
  const categories = detectCategories(filePaths);
  const keywords = extractKeywords(taskDescription);

  return items
    .map((item) => {
      const pathScore = scorePathMatch(item, languages, categories);
      const keywordScore = scoreKeywordMatch(item, keywords);
      const recencyScore = scoreRecency(item);
      const severityScore = scoreSeverity(item);

      const isReference = item.type === "spec" || item.type === "doc";
      const score =
        isReference && keywords.length > 0
          ? scoreReference(item, keywords)
          : pathScore * WEIGHT_PATH +
            keywordScore * WEIGHT_KEYWORD +
            recencyScore * WEIGHT_RECENCY +
            severityScore * WEIGHT_SEVERITY;

      return {
        type: item.type,
        id: item.id,
        title: item.title,
        content: item.content,
        score,
        tokenEstimate: estimateTokens(item.content),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function selectWithinBudget(
  items: ScoredItem[],
  maxTokens: number
): { selected: ScoredItem[]; tokensUsed: number; totalItems: number } {
  const selected: ScoredItem[] = [];
  let tokensUsed = 0;

  for (const item of items) {
    if (tokensUsed + item.tokenEstimate > maxTokens) continue;
    selected.push(item);
    tokensUsed += item.tokenEstimate;
  }

  return { selected, tokensUsed, totalItems: items.length };
}
