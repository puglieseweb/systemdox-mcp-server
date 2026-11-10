# @systemdox/mcp-server

> Your architecture, in your agents' context window.

[SystemDox](https://www.systemdox.com) is the document plane for AI-assisted
engineering: your standards — specs, architecture decision records, checks,
project rules, docs — versioned in git and delivered into your coding agents'
context at write time. This MCP server is how Claude Code, Cursor, and any
MCP-compatible tool read that context — and write decisions back.

**Why teams use it**

- **Write-time context** — `get_context` ranks the checks, specs, and docs
  relevant to the task at hand and fetches their bodies within a token budget,
  so the agent starts from your architecture instead of guessing it.
- **Both directions** — agents call `report_decision` and `update_spec` as they
  work, so decision records exist as a by-product of shipping, not as
  archaeology afterwards.
- **One source for every agent** — no per-developer rules-file forks; every
  session in every repository starts from the same governed, versioned context.
- **Scoped by key** — the API key is the boundary: a department-scoped key sees
  only its own space's checks, specs, and docs.

**Get started in about a minute**

1. SystemDox is in private preview. [Request early access](https://www.systemdox.com)
   to get a workspace.
2. Connect a GitHub repository.
3. Paste `https://<your-workspace>.mcp.systemdox.com/connect` into Claude and
   sign in, or generate an API key (workspace settings) and add the server to
   your tool — hosted (Option A) or local (Option B) below.

Docs: [MCP setup guide](https://www.systemdox.com/guides/mcp-setup) ·
[Documentation standard](https://www.systemdox.com/guides/documentation-standard) ·
[Why write-time context](https://www.systemdox.com/blog/architecture-only-exists-at-write-time)

---

## Connect by signing in

Your workspace has its own address. Paste it into Claude's Settings → Connectors,
or run:

```bash
claude mcp add --transport http systemdox https://<your-workspace>.mcp.systemdox.com/connect
```

Your browser opens SystemDox. Sign in with your passkey and approve; if your
account has no passkey yet, the page offers to add one. It only reads unless you
choose to allow writes. Claude holds a token for an hour, renewed for you, and the
API key behind the connection stays with SystemDox. Only an owner or admin of the
workspace can connect this way for now.

## With an API key

There are two more ways to run it, for scripts, CI and other tools. Both
authenticate with a SystemDox API key (generate one on your SystemDox settings
page) and act strictly as the caller — every tool call is scoped to that key's
tenant.

## Option A — Hosted endpoint (no install)

SystemDox hosts the server at a per-tenant subdomain, speaking MCP Streamable
HTTP. Point any HTTP-capable MCP client at it — nothing to install or update.

```jsonc
{
  "mcpServers": {
    "systemdox": {
      "type": "http",
      "url": "https://<your-workspace>.mcp.systemdox.com/mcp",
      "headers": {
        // Reference the key via an env var — never commit the literal key.
        "Authorization": "Bearer ${SYSTEMDOX_API_KEY}"
      }
    }
  }
}
```

> **Never commit the literal key.** The `pweb_` prefix is deliberately scanner-friendly,
> and a key in a committed `.mcp.json` is a long-lived read/write credential retained in
> git history across every clone, fork, and CI log. MCP clients that expand environment
> variables in `.mcp.json` (e.g. Claude Code) resolve `${SYSTEMDOX_API_KEY}` at load time;
> deliver the value from your shell, a secret manager, or your CI secret store. For clients
> that don't expand variables, inject the key at deploy time and keep the file untracked.

- **URL** — `https://<your-workspace>.mcp.systemdox.com/mcp`. `<your-workspace>`
  is your tenant's **slug**; it must match the tenant that owns the API key, or
  the request is rejected `403`. Set a slug on the workspace first (owner/admin →
  workspace settings) if you don't have one.
- **Auth** — the key must be sent as `Authorization: Bearer <key>`. (An
  `X-API-Key`-only request is rejected at the gateway.)
- **Transport** — stateless request/response (JSON); each call is independent,
  which suits serverless hosting. There is no long-lived SSE stream.
- **Scope** — the key is the boundary. A key bound to a single space (a
  "department" key) sees only that space's context; org-wide planner endpoints
  (`get_planning_context`, `get_plan_board`) are barred to it and answer `403`.
  Give each
  department's repo its own key via `${SYSTEMDOX_API_KEY}`, and an agent in one
  department never sees another's checks, specs, or docs.

## Option B — Local (stdio) via npx

Run the server locally as a stdio subprocess of your MCP client. Useful offline,
or when you'd rather not depend on the hosted endpoint.

```bash
npx @systemdox/mcp-server setup
```

…or configure it directly:

```jsonc
{
  "mcpServers": {
    "systemdox": {
      "command": "npx",
      "args": ["@systemdox/mcp-server"],
      "env": {
        // Provided by your shell / secret store — not committed in the file.
        "SYSTEMDOX_API_KEY": "${SYSTEMDOX_API_KEY}"
      }
    }
  }
}
```

> The package is published to the public npm registry — `npx` resolves it with no
> registry configuration and no credentials.

## Environment variables (stdio mode)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SYSTEMDOX_API_KEY` | no | the key in `~/.claude/systemdox/credentials.json` | Your SystemDox API key. `setup` stores it in `~/.claude/systemdox/credentials.json` and nowhere else, so the server reads it there when this is not set |
| `SYSTEMDOX_WORKSPACE` | no | — | The workspace whose key to read when `credentials.json` holds several |
| `SYSTEMDOX_API_URL` | no | `https://api.puglieseweb.com/systemdox` | REST API base URL |
| `SYSTEMDOX_CACHE_TTL` | no | `300` | Response cache TTL (seconds) |

## Tools

Read: `get_checks`, `get_specs`, `get_docs`, `get_tech_stack`,
`get_planning_context`, `get_plan_board`, `get_change`, `get_context`,
`get_project_rules`, `get_prompt_templates`, `get_team_setup`, `get_document_links`,
`trace_document_path`, `get_graph_stats`. Write: `create_check`,
`update_spec`, `report_decision`, `create_project_rule`,
`create_prompt_template`. Write tools require an API key with `editor`+ role.

Skills (ADR-216): `publish_skill`, `list_skills`, `install_skill`. A Claude
Code skill folder (`SKILL.md` plus its references and scripts) is published
whole; publishing a name again makes a new version. In stdio mode the server
reads and writes the folder itself (`publish_skill { directory }`,
`install_skill { name }` into `~/.claude/skills/<name>/`), refusing to replace
a file edited since it was installed unless `overwrite` is set. In hosted mode
the agent passes and writes the files. Without an agent:

```bash
npx -y @systemdox/mcp-server install-skill <name> [--version n] [--target dir] [--overwrite]
```

Exit codes: `0` installed, `1` usage / no key / API error, `2` refused because
files there were edited.

### What every session is told (ADR-223)

Installing this server is enough for a computer to know what its team uses. When
a session connects, the server answers with `instructions`, which Claude Code puts
in the session's system prompt with no tool call:

- the workspace, and to call `get_context` before writing code;
- each skill your team put in the team setup, with when to use it;
- what this computer lacks. A missing or older skill is installed with
  `install_skill`, which writes files and runs nothing. A file you edited is never
  replaced, and a folder that did not come from SystemDox is left alone.

Hooks, MCP servers, team instructions and memory run or load by themselves, so they
still wait for you: `setup`, in your own terminal, below. An agent never answers its
prompts. So does a team skill that is not plain (anything in its frontmatter beyond a
name and a description, files outside its own folders, or a `!`-command) or that sits
outside the default space: a session is told its name and not to install it. A skill may
not hold `.claude-plugin/`, which would make it a plugin. The hosted server cannot see
your disk, so it says how to check.

**`get_team_setup`** (both servers, read-only) answers the same question in full:
every skill, hook command and MCP server, and on your own computer what is missing
and what to do. Use it with a client that does not surface `instructions`.

If this computer has no key, or SystemDox refuses it, the server still connects and
tells the session what to do. See the words a session gets in the console, under
**Docs › Team setup › What every session is told**.

### Team setup (ADR-217)

Your workspace's Claude Code setup (hooks, MCP servers, agents, commands, the
skills your team chose, and one team `CLAUDE.md`) is published to SystemDox and
reaches every member's computer as one plugin, `<workspace>-setup`.

- **`publish_setup_part`** (both servers) publishes one part: `hooks`
  (`hooks/hooks.json` and the `scripts/` it calls), `mcp` (`.mcp.json`),
  `agents` (`agents/*.md`), `commands` (`commands/*.md`) or `instructions`
  (`CLAUDE.md`). On your own computer pass `directory`: only the files the part
  accepts are read, and a link, a binary file or a file over the limits stops it
  before anything is sent. Every part but `instructions` makes a new plugin
  version, which each member accepts at their next update. For `mcp`, every
  `env` and `headers` value is replaced by a `${NAME}` reference to each
  member's own environment variable. Publishing any part needs `build:write`
  on the default space (SYD-A001 otherwise); only an admin or owner mints such a
  key, and each member accepts every new plugin version in their own terminal.
- **`resolve_person`** (both servers) reads back a person a team memory names
  by identifier (`` `con_…` (reseller, sales) ``): their label, name, phone
  number and email address. The details are for that session only; the memory
  keeps the identifier. It writes nothing.
- **`sync_memory`** (your own computer only) syncs a project's team memory, as
  `sync-memory` below does with no one at the terminal: it never answers a
  question about a person and never rewrites a file for one. A file that still
  holds a phone number, an email address or a home-folder path is skipped and
  listed with the command to run yourself. Inputs: `project`, `dryRun`.

How the team memory works, for a member and for a team lead, is in the guide
[Team memory](https://www.systemdox.com/guides/team-memory).

One command sets up your computer, and the same command updates it:

```bash
npx -y @systemdox/mcp-server setup [--project <name>] [--dir <checkout>] [--import <folder>]... [--yes] [--overwrite] [--choose]
```

- **The key must be able to sync.** In the console, Settings › API keys, press
  **Key for Claude Code team setup**. A key made with the form's defaults is a
  **Reader** key: it reads the team setup, but SystemDox refuses its pushes
  (`SYD-A001`), so it cannot sync a team memory.
- **The key is kept.** On a computer that already has a key (in
  `SYSTEMDOX_API_KEY`, or stored by an earlier `setup`), `setup` shows it by its
  last four characters, as the console lists keys: press Enter to keep it, or
  paste a new key to replace it. A key is never shown as you paste it. A kept
  key that SystemDox refuses (revoked or expired) is replaced once, at the same
  prompt. The API URL and the AI tools are asked once; `--choose` asks again.
- **The workspace's first team memory needs a name.** With no team memory yet,
  `setup` asks for one at a terminal (Enter skips it), or take it from
  `--project <name>`. Later computers find the only team memory by themselves,
  and with several they ask which is the checkout's.
- **A key that cannot sync is caught first.** Before it shows anything, `setup`
  asks SystemDox whether the key may push the project (`blobs/missing` with no
  hashes, which stores nothing). A Reader key may not: the memory is left out,
  the plan says which key to make, and the plugin and the instructions are
  still set up.

- It first writes the SystemDox MCP server into your AI tool's config, without
  your key: the key is stored once, in `~/.claude/systemdox/credentials.json`
  (readable by you alone), and a key an earlier `setup` wrote into that config
  is removed from it. Then, when your workspace has anything published, it checks that
  Claude Code is 2.1.316 or later (`claude update` otherwise) and shows you
  everything it will add: the marketplace entry for `~/.claude/settings.json`,
  the plugin with every hook command and every MCP server's command or URL
  verbatim, the import block for `~/.claude/CLAUDE.md`, each team memory with
  its file count and folder, every folder its first sync will import, and the
  `autoMemoryDirectory` it will set. On an
  update it shows only what changed, with a line diff for hooks and
  instructions. Nothing changes until you answer `y`.
- Then, in this order: the team instructions into `~/.claude/systemdox/<workspace>/CLAUDE.md`
  (if you edited that file, it stops unless `--overwrite`); one marked import
  block into `~/.claude/CLAUDE.md`; one `extraKnownMarketplaces` entry,
  `systemdox-<workspace>`, into `~/.claude/settings.json` (nothing else in
  either file is touched); and, for the project (`--project`, or the only
  one), `autoMemoryDirectory` in `<checkout>/.claude/settings.local.json`
  (`--dir`, or the current folder), followed by its first sync. That first sync
  on this computer imports the memory Claude Code already kept for the checkout
  (`~/.claude/projects/<folder>/memory/`, for the checkout and, inside a Git
  repository, its top folder) and each folder `--import` names, in that order;
  those folders are not changed. A later run imports nothing.
- Two steps are left for you, because Claude Code registers a marketplace only
  once a session has started: open Claude Code once in any folder and close
  it, then run `claude plugin install <workspace>-setup@systemdox-<workspace>`
  in your own terminal and accept the command it shows. When the plugin is
  already installed and a newer version exists, `setup` prints
  `claude plugin update <workspace>-setup@systemdox-<workspace>` instead. `setup` never adds the
  marketplace through `claude` and never enables the plugin for you.
- `--yes` answers for you only without a terminal, and only for what you have
  accepted before; anything new or changed is listed and stops the run.
- Exit codes: `0` done, `1` usage / no key / API error, `2` your edited team
  `CLAUDE.md` would be replaced (named), `3` Claude Code missing or too old,
  `4` not confirmed (you answered N, or `--yes` met something new).

Each project's team memory is synced file by file with one command, which you
run in your own terminal:

```bash
npx -y @systemdox/mcp-server sync-memory [--project <name>] [--dir <folder>] [--import <folder>]... [--dry-run]
```

- The folder is `--dir`, or `~/.claude/systemdox/<workspace>/memory/<project>/`.
  Only `feedback`, `project` and `reference` memories and `MEMORY.md` are
  shared, the `type` read at the top of the frontmatter or under `metadata:`
  (the form Claude Code writes); a `user` memory, a file with `share: false` and a
  `<name>.local-<date>.md` conflict copy never leave your computer, and the
  sync never touches them.
- A file changed only here goes up, one changed only by the team comes down,
  and one changed on both sides keeps the team's text under its name and yours
  beside it as `<name>.local-<date>.md`. `MEMORY.md` is merged line by line.
- Each phone number or email address is asked about once for the whole
  workspace: `m` a member's contact, `p` someone else (with a role label, never
  a name), `o` ours, not a person, `x` leave these files out (`share: false`),
  `s` skip for now. After one `y/N` over the whole diff, each person becomes
  their identifier (`` `con_…` (reseller, sales) ``) and a home folder `~`.
- `--import <folder>` merges another copy of the same memory in (your first
  sync), keeping every difference as a pair; it may be repeated, the folders
  taken in order, and none of them is changed.
  `--dry-run` shows what would be pulled, pushed, deleted, conflicted and
  skipped, and how many values are still to answer; it asks, writes and sends
  nothing.
- Exit codes: `0` synced (conflict copies and skipped files are listed, not
  errors), `1` usage / no key / API error, `2` the team memory moved on twice
  while syncing (your folder holds the merge; run it again).

When your workspace has a team memory, the team plugin runs the sync for you
at the start (a new or resumed session) and the end of every session:

```bash
npx -y @systemdox/mcp-server sync-memory --hook <workspace>
```

- It syncs only the projects this computer synced before (the first sync is
  yours, in your terminal), asks nothing and rewrites nothing.
- It prints one line per project, which Claude Code adds to the session, plus a
  line naming any conflict copy to tidy and one naming the files waiting for you
  (the first five, then how many more), with the command to run. A value is
  never printed. The full report is appended to
  `~/.claude/systemdox/<workspace>/sync-memory.log`.
- One run at a time per workspace (`sync.lock`), a 20-second budget counted from
  the start of the process, and exit `0` always: offline or slow, it says the
  memory was not synced and the next session tries again.
- A key for another workspace, or a team memory SystemDox no longer serves,
  syncs nothing and leaves the folder as it is. Every file is written whole
  (a temporary file, then a rename).

Claude Code runs two commands itself; you never type them:

```bash
npx -y @systemdox/mcp-server marketplace-auth
npx -y @systemdox/mcp-server plugin-path <workspace> --version <n> --sha256 <hash>
```

- `marketplace-auth` gives Claude Code the header for your team's marketplace.
  It gives your key only for a SystemDox team marketplace on the API's own host
  (`SYSTEMDOX_API_URL`, https), and only for that workspace; anything else gets
  nothing and exit `1`. No network call, nothing written.
- `plugin-path` prints the folder of your team's plugin version. A version
  already on your computer is printed with no network call. Otherwise it
  downloads the zip, refuses it unless its SHA-256 is the one Claude Code
  named, refuses an entry that is absolute, contains `..`, is a link or takes
  the plugin past 20 MB, and only then unpacks it into
  `~/.claude/systemdox/<workspace>/plugin/<n>/`. Exit codes: `0` the folder is
  printed, `1` usage / no key / API error, `2` the SHA-256 differs or an entry
  was refused.

Both read your key from `SYSTEMDOX_API_KEY`, then from
`~/.claude/systemdox/credentials.json` for the workspace (readable by you
alone). A key is never written into a settings file, a plugin entry or a
command line.

### `get_change` (ADR-218)

`get_change { repo, slug }` reads one change, a `specs/changes/<slug>/` folder
of a connected repository, as SystemDox last synced it from GitHub: each part
of its brief (decision, contract, behaviour, plan) and its release with its
state and pull request, the contract files, every scenario as
`id · state · title`, the plan and the release pull requests, then the change
as JSON. The last line is `The brief is passed` or
`The brief is not passed: <part> is <state>`: a build session calls it first
and stops on the second. A change the key may not read answers
`No such change <repo>/<slug>`, as one that does not exist.

### `get_context`

The aggregator. It ranks checks, specs and docs against the task, then
spends the token budget **fetching the bodies** of the highest-ranked specs and
docs (`/v1/specs/{id}`, `/v1/docs/{id}/content`) — concurrently, clipped to a
fair share of what's left. Every item carries the `draft_id` / `doc_id` needed to
fetch it in full, so nothing is a dead end: items whose body did not fit, or
whose fetch failed, still appear as a title + ID. Tech stack and project rules
are always included; the budget is spent on bodies, never on truncating the
list. Retrieval quality is measured by `eval/` — see [eval/README.md](./eval/README.md).

### Deprecated tool names

`get_guardrails` and `create_guardrail` were renamed to `get_checks` and
`create_check`. **The old names still work.** They are registered as aliases of
the same handlers and accept the same arguments, so an `.mcp.json` or agent
permission allowlist that pins them keeps working unchanged.

| Old name | New name | Removed no earlier than |
|----------|----------|-------------------------|
| `get_guardrails` | `get_checks` | 2027-01-31 |
| `create_guardrail` | `create_check` | 2027-01-31 |

Removal also requires usage telemetry showing no calls against the old name.
The `/guardrails/*` REST routes are **not** deprecated and are not changing.

## Source and licence

The source is public at
[puglieseweb/systemdox-mcp-server](https://github.com/puglieseweb/systemdox-mcp-server),
a read-only mirror of this package. It is developed in the SystemDox monorepo,
and every change that reaches its main branch is copied to the mirror as one
commit. Issues are welcome on the mirror; a pull request there is read, and
any change it proposes is made in the monorepo. In the mirror, `npm ci` and
`npm run build` build the package on its own, and `npm test` runs its tests;
three of them read shared examples from the monorepo's `specs/` and pass only
there. ISC licence, © 2026 PuglieseWeb LTD.

## Development

```bash
pnpm install         # from the monorepo root (pnpm workspace)
pnpm --filter @systemdox/mcp-server build       # tsup + tsc
pnpm --filter @systemdox/mcp-server test        # unit tests (node:test)
pnpm --filter @systemdox/mcp-server test:http   # offline handler smoke test
pnpm --filter @systemdox/mcp-server eval        # get_context retrieval eval
node scripts/mcp-release-gate.mjs               # from the monorepo root
```

Entry points: `src/index.ts` (stdio), `src/http.ts` (hosted HTTP handler),
`src/cli.ts` (`setup` command: `src/setup-mcp.ts`, then `src/setup-team.ts`). Tool registration is shared via
`src/server.ts` (`createServer`). The hosted handler is deployed as a Lambda by
the product-systemdox backend stack (`systemdox-backend-prod`), reached through
the `*.mcp.systemdox.com` custom domain.

## Publishing

`.github/workflows/mcp-server-publish.yml` publishes to **registry.npmjs.org**
under the public `@systemdox` scope, authenticating with the `NPM_TOKEN` repo
secret. The publish step uses a throwaway npmrc containing only the public
registry: the repo-root `.npmrc` maps `@puglieseweb` to GitHub Packages (needed
for *installing* the org's private packages) and must never leak into a publish
of this package — that is how it previously landed in a private registry that
`npx` 404s for every customer.

`scripts/mcp-release-gate.mjs` is the standing guard: it reads the install
command out of the product source and runs it against the public registry with
no org credentials.
