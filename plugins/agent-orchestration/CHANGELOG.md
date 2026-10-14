# Changelog

## 0.2.0

### Generic and English

- English user interface, CLI output, hook messages, agent prompts, templates and documentation.
- Configurable `headings` in `.claude/agent-queue.config.json`: the markdown headings the harness
  parses and writes (handoff log, orchestration analysis, question/options/recommendation/answer,
  the eight bug sections, the critical-path phrase, the legacy "done when" section). English by
  default; a backlog written with other headings keeps working by declaring them.
- New `templates/agent-reviewer.md`: a generic read-only reviewer prompt that ends with the JSON
  findings block the conductor expects. The README documents declaring reviewer roles with `when`
  (`touches`, `locks`, `domains`, `riskAtLeast`, `diff.paths` / `diff.added`), with optional
  rbac / i18n / migration reviewer examples.
- New `templates/examples/`: ready-to-adapt configs for a Node/TypeScript monorepo with Prisma
  migrations, a Python/Django project and a Go service.
- Templates and docs no longer contain anything specific to the project the plugin was extracted from.
- Stack-specific behaviour moved into config: `testDb.envVar` (name of the test-DB URL variable),
  `testDb.schemaParam` (add Prisma-style `schema=` to worker URLs; now off by default), `commit.typeKeywords`
  and `commit.trailers` (commit message rules; English keywords and a generic Claude trailer by default),
  `ci.localHint` (the "rerun locally" line in the INBOX; no line by default).
- The planner gets a runnable `node …/cli.mjs` command when `cliHint` is a slash command (slash commands
  are disabled in `claude -p`), and the built-in `planner` role may run `node`.

### Notable features since 0.1.0

- **Conductor** (`scripts/conductor.mjs`): one command runs the planner lane, the fixer lane, up to
  `workers` parallel tasks in their own worktrees and one serial-lane task; `--dry-run` prints the
  plan; recovery of dead or timed-out workers; stops cleanly at the Claude usage limit.
- **Role agents from config**: the `roles` table (kind, `when`, skills, writes, model, `bash`
  allow-list patterns, `modelByRound`, `maxBudgetUsd`); Evaluator → Optimizer with QA; reviewers
  report findings to the INBOX without blocking the merge.
- **Bug loop**: QA files structured bugs (eight required sections, failing repro test), the conductor
  assigns a fixer on the parent's worktree; ≤ 2 fixer rounds, fixer can switch model from round 2.
- **Reviewer reliability**: one automatic retry when a reviewer returns no valid JSON block;
  `review <id> --role <role>` re-runs a reviewer on a finished task; findings can be closed in
  `reports/resolutions.json`; `when.diff` skips reviewers when the diff has nothing for them.
- **Verify before reviewers**, a second verify skipped when the merged commit is unchanged, and
  reviewers running concurrently.
- **Scheduling**: countable `resources` (e.g. one e2e stack at a time), exclusion globs (`!…`) in
  `locks`, fewer false lock matches, `worker.cloneDirs` (copy-on-write dependency copies for tools
  that reject symlinks), protection of uncommitted work on the main tree.
- **Context**: per-group context packs (`tasks/_context/<group>.md`); retries after a failed verify
  resume the developer session with the verbatim error; cross-task session chaining measured and
  turned off by default; separate `compactWindow`.
- **Lean headless sessions** (`childSession`): no MCP servers, skills or Chrome by default, tools
  limited to the role; per-role cost caps.
- **Observability**: append-only event log, read-only dashboard (`dashboard-server.mjs`),
  `usage` (tokens by role/model) and `quality` (first-pass rate, verify runs, findings, bugs) commands,
  `SubagentStart`/`SubagentStop` and `PostCompact` hooks.
- **CI watch** (`ci`): reports a red workflow via `gh` in the INBOX and conductor output; with
  `gate: "block"` stops pushing and starting new work until CI is green.

## 0.1.0

Initial release: task files with front-matter as the source of truth, verifier-only `done`, Stop hook
that verifies, commits and chains tasks, money/migration gates, `pattern` (choose the simplest
orchestration pattern per task), planner that asks questions without stopping, serial/parallel lanes
with worktrees and an integrator, `run-backlog.sh` / `run-planner.sh`, and `/agent-orchestration:init`.
