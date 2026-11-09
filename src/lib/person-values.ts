/**
 * Find a person's details in a team memory file (ADR-217 Amendment 2).
 *
 * The client's half of the one detector of specs/changes/team-setup/contract.md
 * ("People"), held with its twin `backend/layers/common/common/person_values.py`
 * to the shared vectors in `specs/changes/team-setup/person-values.json`
 * (test/person-values.test.mjs here, backend/tests/test_person_values.py there).
 * Change one and the other in the same pull request. It finds:
 *
 * - **a phone number**: an E.164 number (`+44 7700 900123`), or a national
 *   number of 10 or 11 digits starting with 0 in the usual groupings
 *   (`07700 900123`, `020 7946 0321`), normalised to E.164 (+44);
 * - **an email address**: an RFC 5322 addr-spec in its dot-atom form, without
 *   comments or a quoted local part, normalised to lower case;
 * - **a home-folder path**: `C:\Users\<name>`, `/Users/<name>` or
 *   `/home/<name>`, which the sync rewrites to `~`.
 *
 * Anything inside a person token, `` `<con_|ctc_|usr_…>` (<label>) ``, is
 * skipped, so a file the sync rewrote is never found again. The patterns are
 * the backend's, character for character; where Python's `\w` and `\d` are
 * Unicode-aware, these spell the same classes out (`u` flag).
 *
 * `findSecrets` mirrors the backend's `secret.key-prefix` rule
 * (common/authored_skills.py): the first characters of a key, even cut short,
 * are a secret. The server's other secret rules refuse a whole key at upload
 * (SYD-K005); a whole key also matches this prefix rule, so the client skips
 * it either way.
 *
 * Pure: no disk, no network, no logging.
 */

export const PHONE = "phone";
export const EMAIL = "email";
export const HOME_PATH = "home-path";
export type PersonValueKind = typeof PHONE | typeof EMAIL | typeof HOME_PATH;
/** The kinds a value can be answered for (openapi ValueKind); a home path is
 * never answered, only rewritten. */
export const VALUE_KINDS = [PHONE, EMAIL] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** The country a national number (leading 0) belongs to. */
export const NATIONAL_PREFIX = "+44";

export interface Finding {
  kind: PersonValueKind;
  /** As written in the file. */
  value: string;
  /** E.164 for a phone number, lower case for an email address; for a home
   * path, the value itself (it is rewritten, never answered). */
  normalised: string;
  /** 1-based. */
  line: number;
  start: number;
  end: number;
}

export interface SecretFinding {
  kind: "key-prefix";
  line: number;
}

// Python's Unicode `\w` (letters, numbers, `_`) and `\d` (decimal digits).
const W = "[\\p{L}\\p{N}_]";
const D = "\\p{Nd}";
const WORD_OR = (extra: string) => `[\\p{L}\\p{N}_${extra}]`;

/** openapi PersonId, unanchored: THE one copy of the pattern on the client.
 * The person token below and `resolve_person`'s input check
 * (team-setup-types PERSON_ID_RE) are both built from it, so a change to the
 * contract's PersonId is this one line (and the backend's `PERSON_ID` in
 * common/person_values.py). A `con_` (a ULID) or `ctc_` is letters and
 * digits; a `usr_` is shared-auth's `usr_<Cognito sub>`, a UUID with its
 * hyphens (proposal item 22). */
export const PERSON_ID = "(?:(?:con|ctc)_[0-9A-Za-z]{10,40}|usr_[0-9A-Za-z-]{10,40})";

/** `con_…` (label), `ctc_…` (label), `usr_…` (label): a PersonId in
 * backticks, with its role label after it. Skipped by the detector. */
export const PERSON_TOKEN = `\`${PERSON_ID}\`(?:[ \\t]*\\([^()\\n]*\\))?`;

// A phone number is one run of digit groups separated by single spaces or
// hyphens. It may not touch a word, a `+`, a dot, a colon or a slash on either
// side (a version, a time, a path, a URL), nor continue into further digits.
const BEFORE = `(?<!${WORD_OR("+.:/\\\\\\-")})(?<!${D}[ -])`;
const AFTER = `(?!${WORD_OR(":/\\\\")}|\\.${D}|[ -]?${D}|-${W})`;
const E164 = `${BEFORE}\\+${D}+(?:[ -]${D}+)*${AFTER}`;
const NATIONAL = `${BEFORE}0${D}*(?:[ -]${D}+)*${AFTER}`;
const GROUP_SIZES = new Set([2, 3, 4, 5, 6]);

// RFC 5322 dot-atom addr-spec. The local part's first character is a letter,
// a digit or `_`; a backtick is never part of one (Markdown's code fence).
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_{|}~\\-]";
const EMAIL_RE =
  "(?<![A-Za-z0-9!#$%&*+/=?^_{|}~.@\\-])" +
  "[A-Za-z0-9_]" + ATEXT + "*(?:\\." + ATEXT + "+)*" +
  "@(?:[A-Za-z0-9](?:[A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}" +
  "(?![A-Za-z0-9\\-]|\\.[A-Za-z0-9])";

// A home folder: a Windows profile or a macOS or Linux home, up to the name.
// It may not continue a word, a URL path or a variable (https://h/home/x,
// ${HOME}/home/x), and ~ is already the rewritten form.
const HOME_PREFIX = "(?:[A-Za-z]:\\\\+Users\\\\+|[A-Za-z]:/+Users/+|/Users/|/home/)";
const HOME = `(?<!${WORD_OR(".~:/\\\\$}\\-")})${HOME_PREFIX}[^\\\\/\\s"'\`<>|:*?]+`;

// The backend's `secret.key-prefix`: `\b` + a recognisable prefix + 4 or more
// key characters. `\b` before a word character is "not after a word character".
const KEY_PREFIX =
  `(?<!${W})(?:pweb_[a-z]+_key_|sk-ant-|sk_live_|rk_live_|github_pat_|gh[pousr]_|sntrys_|xox[baprs]-)` +
  "[A-Za-z0-9_\\-]{4,}";

const global = (source: string, flags = "") => new RegExp(source, `gu${flags}`);
const whole = (source: string, flags = "") => new RegExp(`^(?:${source})$`, `u${flags}`);

function lineOf(text: string, start: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < start; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** National: 10 or 11 digits starting with 0, in groups of 2 to 6 digits (one
 * unbroken run of 10 or 11 is also a usual way to write one). International:
 * + and 8 to 15 digits (E.164's limit). Lengths count characters, as Python's
 * `len` does for these digits. */
function phoneShape(value: string): boolean {
  const groups = value.replace(/^\++/, "").split(/[ -]/);
  const digits = [...groups.join("")];
  if (value.startsWith("+")) return digits.length >= 8 && digits.length <= 15 && digits[0] !== "0";
  if (digits.length < 10 || digits.length > 11) return false;
  return groups.length === 1 || groups.slice(1).every((g) => GROUP_SIZES.has([...g].length));
}

/**
 * The form an answer is keyed by: E.164 for a phone number, lower case for an
 * email address. Throws when `value` is not one of `kind` (the server answers
 * SYD-K020 for the same value).
 */
export function normalise(kind: string, value: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (kind === PHONE) {
    if (!(whole(E164).test(v) || whole(NATIONAL).test(v)) || !phoneShape(v)) {
      throw new Error("not a phone number");
    }
    const digits = v.replace(/[ -]/g, "");
    return digits.startsWith("+") ? digits : NATIONAL_PREFIX + digits.slice(1);
  }
  if (kind === EMAIL) {
    if (!whole(EMAIL_RE).test(v)) throw new Error("not an email address");
    return v.toLowerCase();
  }
  throw new Error(`not a value kind: ${JSON.stringify(kind)}`);
}

/** Every phone number, email address and home-folder path in `text`, in the
 * order they appear, skipping person tokens. */
export function findPersonValues(text: string): Finding[] {
  if (typeof text !== "string" || !text) return [];
  const skipped = [...text.matchAll(global(PERSON_TOKEN))].map((m) => [m.index!, m.index! + m[0].length]);
  const found: Finding[] = [];

  const add = (kind: PersonValueKind, m: RegExpMatchArray, normalised: string) => {
    const start = m.index!;
    const end = start + m[0].length;
    if (skipped.some(([s, e]) => s <= start && end <= e)) return;
    if (found.some((f) => f.start < end && start < f.end)) return;
    found.push({ kind, value: m[0], normalised, line: lineOf(text, start), start, end });
  };

  for (const m of text.matchAll(global(EMAIL_RE))) add(EMAIL, m, m[0].toLowerCase());
  for (const source of [E164, NATIONAL]) {
    for (const m of text.matchAll(global(source))) {
      if (phoneShape(m[0])) add(PHONE, m, normalise(PHONE, m[0]));
    }
  }
  for (const m of text.matchAll(global(HOME, "i"))) add(HOME_PATH, m, m[0]);
  return found.sort((a, b) => a.start - b.start);
}

/** What replaces a home folder at `start`: `~`, or `$HOME` inside double
 * quotes, where a shell does not expand `~`. */
export function homeStandIn(text: string, start: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const quotes = (text.slice(lineStart, start).match(/"/g) ?? []).length;
  return quotes % 2 === 1 ? "$HOME" : "~";
}

/** `text` with every home-folder path found replaced by `~`: what the sync
 * sends instead (`C:\Users\jbloggs\.claude` → `~\.claude`). */
export function rewriteHomePaths(text: string): string {
  let out = "";
  let last = 0;
  for (const f of findPersonValues(text)) {
    if (f.kind !== HOME_PATH) continue;
    out += text.slice(last, f.start) + homeStandIn(text, f.start);
    last = f.end;
  }
  return out + text.slice(last);
}

/** The kind and line of every key prefix in `text`; never the value. */
export function findSecrets(text: string): SecretFinding[] {
  if (typeof text !== "string" || !text) return [];
  return [...text.matchAll(global(KEY_PREFIX))].map((m) => ({ kind: "key-prefix", line: lineOf(text, m.index!) }));
}
