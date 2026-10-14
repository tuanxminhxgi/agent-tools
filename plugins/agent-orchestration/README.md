# agent-orchestration

A task queue for AI agents in Claude Code. Tasks are markdown files with YAML front-matter;
**only the verifier may mark a task `done`** (when every check command exits 0); a Stop hook
chains the agent onto the next task; a planner splits requirements into tasks and asks questions
without stopping; a conductor runs planner, parallel workers, QA/reviewers and a bug-fix loop; and
each task gets the simplest orchestration pattern that is reliable enough.

Design: [`docs/task-queue.md`](docs/task-queue.md) (state · done · loop) ·
[`docs/orchestration.md`](docs/orchestration.md) (patterns, lanes, roles, bug loop, conductor,
observability). Changes: [`CHANGELOG.md`](CHANGELOG.md).

## Requirements

- Node >= 20. No dependencies, nothing to `npm install`.
- The project is a git repository (one commit per finished task; worktrees for parallel workers).
- Optional: the GitHub CLI `gh` for CI watching.

## Install

```
/plugin marketplace add <path or git URL of the repo containing .claude-plugin/marketplace.json>
/plugin install agent-orchestration@agent-tools
```

Then, inside your project:

```
/agent-orchestration:init
```

This creates (never overwriting anything that exists):

| Path | What |
|---|---|
| `tasks/INDEX.md` | task index; a line containing "critical path" sets priorities |
| `tasks/_templates/{task,bug,question}.md` | file templates - their headings are parsed by the harness |
| `tasks/questions/` | questions the planner files for humans |
| `requirements/README.md` | requirement template, input for the planner |
| `.claude/agent-queue.config.json` | project rules, every key commented |
| `.claude/agents/{planner,developer,qa,security,fixer}.md` | role prompts - tailor them to your project |
| `AGENTS.md` | a rules section for agents is appended (once) |
| `.gitignore` | queue state, log and worktree paths are appended |

Running `init` again changes nothing.

## Quick start

1. Edit `.claude/agent-queue.config.json` (see [Configuration](#configuration)), or start from one
   of the examples in [`templates/examples/`](templates/examples/).
2. Write a task from `tasks/_templates/task.md` (set `status: todo`, fill in `verify:` and the seven
   answers of `## Orchestration analysis`), or write a requirement in `requirements/` and let the
   planner create the tasks.
3. `/agent-orchestration:task doctor` - checks the backlog's invariants.
4. `/agent-orchestration:task start T-001` - from now on the Stop hook verifies, commits and chains.

## Commands

```
/agent-orchestration:task status            backlog table
/agent-orchestration:task next              next task (with --plain: exit 1 = nothing left, 2 = gated)
/agent-orchestration:task prompt T-001      full prompt for an agent
/agent-orchestration:task start T-001       todo → doing; the Stop hook takes over from here
/agent-orchestration:task verify T-001      run the checks without changing state
/agent-orchestration:task done T-001        checks pass → done (no shortcut)
/agent-orchestration:task done T-001 --manual-ok   a HUMAN confirms the visual checks
/agent-orchestration:task release [id]      → todo
/agent-orchestration:task approve T-001     needs-human → doing
/agent-orchestration:task pattern [id]      orchestration pattern + reason; escalation for doing tasks
/agent-orchestration:task inbox             regenerate tasks/INBOX.md (what needs a human)
/agent-orchestration:task planner sync|next planner bookkeeping
/agent-orchestration:task review T-001 --role <role>   re-run one reviewer on a finished task
/agent-orchestration:task usage | quality   tokens and agent quality from the event log
/agent-orchestration:task doctor            check backlog invariants
```

Add `--json` to any command when calling it from a script. `help` lists everything.

## Ways to run the loop

Never run two of these on the same backlog at the same time.

| Mechanism | Use it for |
|---|---|
| **Stop hook** (installed with the plugin) | a few tasks in a row inside your interactive session (`AGENT_QUEUE_MAX_CHAIN`, default 5) |
| `run-backlog.sh [n]` | a long backlog, one `claude -p` per task with a clean context and its own log |
| `run-planner.sh [n]` | the planner alone: splits `requirements/*.md` into tasks, asks questions in `tasks/INBOX.md` without stopping |
| `node <plugin dir>/scripts/conductor.mjs [--dry-run] [--max-rounds N]` | the whole system: planner lane, parallel workers in worktrees, role chain, verify, merge, bug loop |

The scripts live in the plugin's `scripts/` directory (find the path with `/plugin`); run them from
inside your project - they locate the project root via `CLAUDE_PROJECT_DIR` or the git root. Headless
sessions have nobody to click "allow": each role gets a narrow allow-list built from its
`.claude/agents/<role>.md` `tools:` and its `bash` patterns. `AGENT_QUEUE_SKIP_PERMISSIONS=1` runs
with `--dangerously-skip-permissions` instead - only after you have reviewed the backlog about to run.
Start the conductor with `--dry-run` first: it only reads and prints the plan.

## Configuration

`.claude/agent-queue.config.json` holds everything project-specific; the plugin code contains only
generic defaults. Arrays you declare **replace** the default (they are not merged); objects are merged
one level deep. A broken file is an error, never silently guessed around. The template
([`templates/agent-queue.config.json`](templates/agent-queue.config.json)) comments every key.

| Key | Default | Meaning |
|---|---|---|
| `projectName` | `null` | used in prompts (init fills it in) |
| `cliHint` | `node scripts/agent-queue/cli.mjs` (template: `/agent-orchestration:task`) | how the CLI is spelled in prompts and reports |
| `risk.moneyKeywords` | `[]` | substrings of paths/title that mean money → high risk, approval before start |
| `risk.migrationPaths` | `[]` | substrings of paths that mean a schema migration → high risk, approval before start |
| `risk.highPatterns` | auth, permission, guard, upload, `\.routes\.`, middleware, session | regexes on `touches` → high risk (QA + security) |
| `risk.mediumPatterns` | `[]` | regexes on `touches` → medium risk (QA) |
| `skills` | `[]` | `{skill, domain, globs, roots, reminder}` - skill reminders on edit and in task prompts |
| `domains` | `e2e/**` → e2e; `scripts/**`, `.claude/**`, `.github/**` → infra | extra `{domain, globs}` used to infer a task's domains |
| `locks` | `lockfile` (package.json + lockfiles) | exclusive locks → serial lane; `!glob` excludes |
| `resources` | `{}` | countable resources `{verify: [regex], limit, serial?}` |
| `testDb` | `commands`: `npm test`, `vitest`, `npm run test` · `envFile: null` · `envVar: "TEST_DATABASE_URL"` · `schemaParam: false` | verify commands that need a test DB, the variable holding its URL and the `.env` file that may define it; each worker gets its own Postgres schema via `options=-c search_path=…` (`schemaParam: true` also adds `schema=…`, read by e.g. Prisma's migration engine) |
| `commit` | `typeKeywords`: English keywords for test · docs · fix · refactor · perf · build · feat · `trailers: ["Co-Authored-By: Claude <noreply@anthropic.com>"]` | commit messages: the conventional-commit type is the first key whose keywords occur in the task title/scope (else `chore`); `trailers` are appended to every message |
| `diffIgnore` | tests, `*.md`, `__fixtures__` | not counted toward diff-size thresholds |
| `worker` | `linkDirs: ["node_modules"]`, `cloneDirs: []` | dependency dirs shared with worker worktrees |
| `workers` | `3` | parallel workers |
| `roles` | developer · qa · security · planner | role table - see below |
| `headings` | English (see below) | headings of the task/bug/question file format |
| `ci` | `null` | `{workflow, branch, gate: "warn"\|"block", localHint?}` - CI watch via `gh`; `localHint` = command shown in the INBOX to rerun a red job locally (`<job>` placeholder) |
| `dashboard` | `{port: 4400, tokenWarnPerTask: null}` | read-only dashboard |
| `childSession` | lean: `{strictMcp: true, skills: false, chrome: false, toolsFromRole: true}` | what headless child sessions load |
| `compactWindow` | `200000` | auto-compact window (tokens) for child sessions |
| `sessionChain` | `{enabled: false, ...}` | resume one developer session across tasks - off; measured as more expensive |

### Headings

The harness reads and writes some markdown headings, so they are part of the file format:

| Key | Default |
|---|---|
| `handoff` | `Handoff log` |
| `analysis` | `Orchestration analysis` |
| `question` / `options` / `recommendation` / `answer` | `Question` / `Options` / `Recommendation` / `Answer` (also the `Answer:` line in the INBOX) |
| `bugSections` | `Summary`, `Environment`, `Steps to reproduce`, `Expected`, `Actual`, `Evidence`, `Suspected code`, `Repro test` |
| `criticalPath` | `critical path` (phrase marking the critical-path line in `tasks/INDEX.md`) |
| `doneWhen` / `legacyDeps` / `legacyManual` | `Done when` / `Depends on:` / `[manual]` (legacy prose format read once by `migrate`) |

If your backlog is already written with other headings (for example in another language), declare
them here and change `tasks/_templates/` to match; otherwise leave the defaults.

## Roles

A role is an entry in `roles` plus a prompt file `.claude/agents/<role>.md` with the same name.
Your entries are merged with the four built-in roles (redeclare one to change it).

```jsonc
"<role>": {
  "kind": "developer | evaluator | reviewer | fixer | planner",
  "when": { ... },              // when the role joins a task's chain - see below
  "skills": ["api-conventions"],// skills the role must load (.claude/skills/<skill>/SKILL.md)
  "writes": ["src/**"],         // globs the role may write; reviewers: []
  "model": "sonnet",            // opus | sonnet | haiku (any --model value)
  "bash": ["Bash(npx vitest:*)"],          // optional: narrow Bash patterns for headless runs
  "modelByRound": [{"from": 2, "model": "opus"}], // optional: switch model from attempt N (useful for fixer)
  "maxBudgetUsd": 2             // optional: cost cap for one session
}
```

Chain order: developer → evaluator → reviewers (alphabetical) → fixer. Developer roles whose `when`
matches all join; if none matches, the role with `when.always` runs. `qa` and `security` follow the
pattern's risk overlay (their `when.riskAtLeast` sets the threshold); other evaluators and reviewers
follow their own `when`; fixers run only when the task has open bugs.

### Reviewer roles

Reviewers are read-only (`"writes": []`, no Write/Edit tools). They print one JSON block that goes to
`reports/<id>.<role>.json` and the INBOX; they **never block the merge**. Start the prompt from
[`templates/agent-reviewer.md`](templates/agent-reviewer.md): copy it to `.claude/agents/<role>.md`,
set `name:`, write the checklist.

The keys of `when` are **ORed** - any one of them puts the role in the chain:

| Key | Matches when |
|---|---|
| `domains: ["web"]` | the task has one of these domains |
| `riskAtLeast: "medium"` | the task's risk is at least this |
| `touches: ["src/api/**/*.routes.ts"]` | the task's `touches` overlap these globs |
| `locks: ["db-schema"]` | the task holds one of these locks |
| `openBugs: true` | the task has open bugs (fixers) |
| `always: true` | fallback developer |

`diff` is different: it is an **extra** condition for reviewers only, checked right before the
session opens, on the task's real diff - saving a session when there is nothing to review:

| Key | Meaning |
|---|---|
| `diff.paths` | globs; at least one changed file must match, otherwise the reviewer is skipped |
| `diff.added` | optional regexes (JavaScript syntax, no inline flags); at least one ADDED line of those files must match one |

Optional examples (declare only what fits your project; a full set is in
[`templates/examples/node-typescript-monorepo.json`](templates/examples/node-typescript-monorepo.json)):

```json
"roles": {
  "rbac-reviewer": {
    "kind": "reviewer", "writes": [], "model": "sonnet", "maxBudgetUsd": 2,
    "when": { "touches": ["src/**/*.routes.ts", "src/**/*permission*", "src/middleware/**", "ui/src/**/nav*.ts"] }
  },
  "i18n-reviewer": {
    "kind": "reviewer", "writes": [], "model": "haiku", "maxBudgetUsd": 2,
    "when": {
      "domains": ["i18n"], "touches": ["ui/src/**/*.tsx"],
      "diff": { "paths": ["ui/src/**/*.tsx", "ui/src/locales/**"], "added": ["\\bt\\(\\s*['\"`]", "useTranslation\\("] }
    }
  },
  "migration-reviewer": {
    "kind": "reviewer", "writes": [], "model": "sonnet", "maxBudgetUsd": 2,
    "when": { "locks": ["db-schema"] }
  }
}
```

- **rbac-reviewer** - permissions are enforced on the server for every role, navigation does not
  offer pages a role cannot open.
- **i18n-reviewer** - no hard-coded user-visible strings; every new translation key exists in every
  language. The `diff` condition skips tasks that only change styling.
- **migration-reviewer** - no unintended `DROP`, no edits to existing migrations, no `NOT NULL`
  column without a default or backfill. Migrations are gated anyway, so the human reads the findings
  before `approve`.

Close a handled finding in `reports/resolutions.json` (see `docs/orchestration.md`, "Closing reviewer findings").

## Environment variables

They override the config file.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_QUEUE_DISABLE` | unset | `1` = turn off the Stop hook and skill reminders. Set it in your shell only - never in `env` of `.claude/settings.json`, which would override the `AGENT_QUEUE_DISABLE=1` the conductor gives its child sessions |
| `AGENT_QUEUE_MAX_CHAIN` | `5` | max tasks chained per session by the Stop hook |
| `AGENT_QUEUE_MAX_RETRIES` | `2` | consecutive failures before a task becomes `failed` |
| `AGENT_QUEUE_COMMIT` | `1` | `0` = do not commit finished tasks |
| `AGENT_QUEUE_PUSH` | Stop hook/CLI: off · conductor: on | `1` = push after commit in the Stop hook; `0` = the conductor does not push. Push needs an upstream |
| `AGENT_QUEUE_PROTECTED_BRANCHES` | empty | branches never committed to automatically, e.g. `main,production` |
| `AGENT_QUEUE_GATES` | `on` | `off` = skip money/migration gates (not the visual-check gate) |
| `AGENT_QUEUE_WORKERS` | config `workers` | parallel workers |
| `AGENT_QUEUE_WORKER_TIMEOUT_MIN` | `90` | kill and release a worker after this many minutes |
| `AGENT_QUEUE_CMD_TIMEOUT_MS` / `AGENT_QUEUE_VERIFY_TIMEOUT_MS` | 10 min / 20 min | timeout per check command / per verify run |
| `AGENT_QUEUE_DIFF_<S\|M\|L>_<LINES\|FILES>` | 150/3 · 600/12 · 2000/40 | diff-size thresholds for escalation |
| `AGENT_QUEUE_DISABLE_RESOURCES` | empty | comma-separated resource names whose verify commands are marked `skipped` |
| `AGENT_QUEUE_SKIP_PERMISSIONS` | unset | `1` = headless sessions use `--dangerously-skip-permissions` |
| `AGENT_QUEUE_CHILD_FULL` | unset | `1` = child sessions load all MCP servers, skills and tools (cost caps stay) |
| `AGENT_QUEUE_PARALLEL_REVIEWERS` | on | `0` = run reviewers one after another |
| `AGENT_QUEUE_CI_STATUS` / `AGENT_QUEUE_CI_GATE` | on / config | `0` = never call `gh` · `warn`/`block` override `ci.gate` for one run |
| `AGENT_QUEUE_EVENTS` / `AGENT_QUEUE_EVENTS_FILE` | on / `logs/agent-queue/events.jsonl` | `0` = no event log (independent of `AGENT_QUEUE_DISABLE`) · another file |
| `AGENT_QUEUE_CLAUDE_BIN` | `claude` | command the background scripts run (for a fake in tests) |

## Dashboard (read-only)

See which agents run, for which task, in which role, and how many tokens they used:

```
node <plugin dir>/scripts/dashboard-server.mjs [--port 4400]
```

then open `http://127.0.0.1:4400`. It listens on loopback only and has no buttons that change
anything - control stays in the CLI. It reads the event log `logs/agent-queue/events.jsonl`, written
by the background scripts, the conductor, and the `SubagentStart`/`SubagentStop` hook (prompts and
answers are not stored). Tokens on the command line: `/agent-orchestration:task usage [--since 7d]`.

## Hooks installed

| Hook | Does |
|---|---|
| `Stop` | verifies the session's `doing` task, settles it, commits, claims the next one |
| `PreToolUse` (Write\|Edit) | injects the reminder of the matching `skills` entry; never blocks |
| `SubagentStart` / `SubagentStop` | records subagents in the event log |
| `PostCompact` | saves the compact summary to `logs/agent-queue/<task>/compact-<n>.md` |

Every hook exits 0 on its own errors (logged to `.claude/agent-queue.log`); none can break a session.

## Validate the plugin

```
claude plugin validate --strict <plugin dir>
claude plugin validate --strict <dir containing .claude-plugin/marketplace.json>
```

## Turn it off

- Temporarily: `AGENT_QUEUE_DISABLE=1` in your shell.
- Permanently: `/plugin uninstall agent-orchestration`.

## Do not install it into its own source repository

The repository that hosts this marketplace registers the same hooks directly in its
`.claude/settings.json`. Installing the plugin there as well means **two Stop hooks on the same
backlog** - two verifications, possibly two commits. The plugin is meant for OTHER projects.

## Code in `scripts/` and `hooks/*.mjs`

These are generated copies of the source repository's code - do not edit them here; they are
overwritten on the next sync. The hand-written parts are this README, `docs/`, `commands/`, `skills/`
and `templates/`.
