# get_context eval harness

`get_context` is the flagship MCP tool: an agent asks *"what do I need to know
for this task"* and gets back curated context inside a token budget. Every knob
in `src/lib/scoring.ts` — four magic weights, `includes()` keyword matching,
`length / 4` token estimation — is a guess about retrieval quality. Without a
harness, changing any of them is a guess about a guess.

This runs ten representative tasks through the **real** `buildContext()` and
prints what came back.

## Run it

```bash
npm run eval                       # offline, against the fixture tenant
node eval/run.mjs --budget 1200    # tighten the budget
node eval/run.mjs --write          # dump each full response to eval/out/
node eval/run.mjs --strict         # exit 1 if a task misses an expectation
node eval/run.mjs --live           # against a real tenant (needs SYSTEMDOX_API_KEY)
```

`npm run eval` builds first. Everything except `--live` is offline and
deterministic — no API key, no network.

## What it reports

| Column | Meaning |
|--------|---------|
| `tokens` | Estimated tokens of the response vs the budget. `!!` marks an overrun (the run then exits 1). |
| `bodies` | Ranked specs/docs whose **full text** was fetched and included. This is the number the tool used to always report as zero. |
| `listed` | Items returned as title + ID only — the agent can still fetch them. |
| `fail` | Body fetches that failed; the item degrades to title + ID rather than vanishing. |
| `expect` | Offline only: substrings a human said the context MUST contain for this task. |
| `top item returned` | The highest-ranked spec/doc, with its ID. |

## What it does and does not prove

**Does:** that `get_context` returns real body text and IDs, that the response
stays inside its token budget, that a failed body fetch degrades instead of
dropping the item, and — offline — that the governing document for a task is
actually retrieved.

**Does not:** that the context *changes what an agent writes*. That needs a model
in the loop and a judge, and is deliberately out of scope here: this harness has
no API key, no cost, and no flake. The `--write` dump exists so a diff of
agent output with and without the context can be run by hand.

The expectations are a crude oracle — substring presence, not relevance.
A task can score `2/2` while the *ordering* is wrong.

## Known findings (2026-07-14, at the time this landed)

- `auth-api-key` ("debug why an API key request is rejected by the authoriser")
  returns the auth doc, but **ranks the frontend-services guide above it**.
  Keyword scoring matches on titles and metadata only — bodies are not scored,
  because scoring happens before the fetch. This is the obvious next thing to fix
  (score against the doc `snippet` the list endpoint can already return for a
  query, or rank in two passes).
- At a 4000-token budget the fixture tenant only uses ~49% of it: the bodies are
  simply short. Utilisation is not a goal; not truncating the *list* is.

## Adding a task

Append to `eval/tasks.mjs`: an `id`, the `task` prompt, the `files` an agent
would have open, and the `expect` substrings. If the task needs new tenant
content, add it to `eval/fixtures/tenant.json` (which mirrors the shapes of
`/v1/guardrails`, `/v1/specs`, `/v1/specs/{id}`, `/v1/docs`,
`/v1/docs/{id}/content`, `/v1/ai/settings/stack` and `/v1/standards/rules`).
