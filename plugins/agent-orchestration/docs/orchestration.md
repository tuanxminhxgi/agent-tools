# Multi-agent orchestration - a pattern per task

> Extends the task queue ([`task-queue.md`](task-queue.md)) from one stream of work into a system
> with a planner running alongside the workers, a serial lane and a parallel lane, role agents
> (QA, security, custom reviewers, fixer), a bug loop, and a conductor that runs all of it.
>
> The three layers keep their contracts: the verifier is still the only place that writes `done`,
> and every loop still only consumes exit codes.

## Principle

> **Every task uses the simplest pattern that completes it reliably.** There is no fixed workflow.

**The LLM analyses, the machine decides.** The planner (an LLM) writes its analysis into the task's
front-matter; the conductor (plain Node code, not an LLM) reads the front-matter and decides the
pattern, the lane and which roles run. Decisions live in pure functions, so they are tested with
case tables and give the same answer twice.

```
  requirements/*.md
        │
        ▼
  ┌──────────────┐  questions  ┌────────────────┐
  │   PLANNER    │────────────►│ tasks/INBOX.md │◄── a human answers in place
  │ (own claude  │◄────────────│  (generated)   │
  │  session)    │   answers   └────────────────┘
  └──────┬───────┘
         │ draft → todo (once the task has enough context)
         ▼
  ┌──────────────────────────────────────────────────────┐
  │ CONDUCTOR - Node script, NOT an LLM                  │
  │  choosePattern(task) · schedule(backlog, workers)    │
  └────┬──────────────────────────────┬──────────────────┘
       │ serial lane                  │ parallel lane (≤ workers)
       ▼                              ▼
   main worktree                .claude/worktrees/<id> (branch agent/<id>)
       │                              │
       └────────► role chain of the task ◄┘
                  (developer → QA → verify → reviewers)
                              │
                              ▼
               VERIFIER ──► INTEGRATOR (rebase · verify again · fast-forward merge)
```

# 1 · Task analysis - seven questions

Every task, whether the planner or a human wrote it, has this section in its body
(template: `tasks/_templates/task.md`; heading configurable via `headings.analysis`):

```markdown
## Orchestration analysis
1. End goal: ...
2. Subtasks: ...
3. Dependencies between subtasks: ...
4. What can run independently or in parallel: ...
5. Expertise and tools: ...
6. Validation: ...
7. Done condition (same as the verify commands): ...
```

The label before the colon is free text; what matters is a non-empty answer after it. `doctor`
fails a `todo`/`doing` task whose analysis is missing or has an empty answer.

The analysis is compressed into front-matter for the machine:

```yaml
complexity: M            # S ≤ 3 files · M one module · L several modules · XL several areas/domains
domains: [backend]       # omitted → inferred from `skills`/`domains` in the config
risk: low                # inferred; a hand-written value can only RAISE it
touches: [src/report/**] # omitted → taken from the body's `File:` line
locks: []
blocked-on: []           # [Q-003] - unanswered questions
pattern: auto            # write a pattern to override it, with the reason in the body
steps: []                # Workflow pipeline only
context: null            # context group → the developer receives tasks/_context/<group>.md
```

**Risk is inferred** from facts: `gate: money|migration` → high; `touches` matching
`risk.migrationPaths`, `risk.moneyKeywords` (also matched in the title) or `risk.highPatterns` →
high; `risk.mediumPatterns` → medium; otherwise low. `gate: manual` only means "a human must look"
and does not raise risk.

# 2 · Choosing the pattern - `choosePattern(task)`

The first matching rule wins; the table runs from simple to complex:

| # | Condition | Core pattern |
|---|---|---|
| 1 | `steps` not empty | **Workflow pipeline** |
| 2 | XL, or ≥ 3 domains | **Hierarchical** - only here; a hand override to hierarchical is refused when the data does not call for it |
| 3 | L | **Planner → Executor** (+ parallel children) |
| 4 | exactly 2 domains | **Router** |
| 5 | otherwise | **Single agent + tools** |

Overlay: risk ≥ `roles.qa.when.riskAtLeast` (default `medium`) adds QA; risk ≥
`roles.security.when.riskAtLeast` (default `high`) adds security. A hand override cannot remove the overlay.

`pattern [id]` prints the pattern and the reason. For a task in `doing` it also measures the
working diff and reports:
- **escalate** - edits outside `touches` · diff larger than the size threshold · the same failure
  twice · edits to a file covered by a lock the task does not hold;
- **simplify** - the running pattern is heavier than needed;
- **skip-security** - the real diff touches nothing sensitive.

Size thresholds: S 150 lines / 3 files · M 600 / 12 · L 2000 / 40, overridable with
`AGENT_QUEUE_DIFF_<S|M|L>_<LINES|FILES>`. Files matching `diffIgnore` (tests, docs, generated
files) do not count toward them.

## Context without repeating context

The next agent does **not** read the previous agent's transcript. It reads exactly:

1. the task file (goal, contract, orchestration analysis);
2. the diff of the branch against its fork point;
3. the `## Handoff log` section at the end of the task file - 3-5 lines per agent.

Evaluators and reviewers do not even get the handoff log: the person checking the work should not
be persuaded in advance by the person who did it.

**Context packs.** Tasks declaring `context: <group>` give their developer a fourth input,
`tasks/_context/<group>.md`, written once by the planner (files to read, signatures, decisions,
"already known"; ≤ 20,000 characters). The handoff log and the diff win when they disagree with the
pack. `doctor` fails an unfinished task whose pack is missing or too long.

**Retries** after a failed verify resume the developer session that just ran and send only the
verbatim error (and the tail of the last failing verifier log). Chaining one developer session across
different tasks (`sessionChain`) exists but is **off** by default: measured, it cost about four times
as much without saving turns.

# 3 · Serial lane and parallel lane

Nobody labels tasks "parallel-safe" by hand; that label would be wrong. It is **derived**:

> Two tasks may run in parallel if and only if: their deps are `done` · their `touches` globs do not
> overlap · they hold no common lock.

Glob overlap is **conservative**: when unsure, it counts as overlapping. A task holding an exclusive
lock (from `locks` in the config, the built-in `lockfile`, or `money` from the gate) runs in the
**serial lane** on the main worktree, one at a time. Everything else runs in the **parallel lane**, each
task in its own worktree `.claude/worktrees/<id>` on branch `agent/<id>`, up to `workers`
(`AGENT_QUEUE_WORKERS`, default 3). A lock glob starting with `!` excludes paths (e.g. data-only
migrations that do not need the schema lock).

**Countable resources** (`resources`) limit how many tasks hold a shared thing at once - e.g. one
browser e2e stack - without forcing the serial lane, unless the resource says `serial: true`. A task
holds a resource when one of its verify commands matches the resource's regex.

Every worker needs its own resources, or tests become flaky:
- its own `TEST_DATABASE_URL` with a dedicated schema `agent_w<n>`;
- its own e2e ports (through the test runner's environment variables);
- its own dependency directories - `worker.linkDirs` are symlinked, `worker.cloneDirs` copied
  (copy-on-write when the filesystem supports it).

Commands: `start <id> --worker n` · `worker add <id> n` (prints the env with passwords masked; the
full version is in `.claude/worktrees/<id>.env`) · `integrate <id> --slot n` · `worker rm <id>`.

**The integrator** merges one branch at a time: rebase onto the main branch → run `verify:` again
**in the worktree** (green on a branch does not mean green after rebasing) → fast-forward merge.
A rebase conflict aborts the rebase and reports the files - it is **never resolved automatically**,
except when every conflict lies inside the `## Handoff log` section of task files, which is merged
by appending both sides.

# 4 · Planner - ask without stopping

Input: `requirements/*.md`. States: `draft` (the planner is writing) → `needs-decision` (open
question) → `todo` (enough context - decided by the **machine**, not the planner).

1. Take the next requirement without `planned: true` and split it into `draft` tasks.
2. Something only a human can decide → create `tasks/questions/Q-xxx-*.md`, list it in the blocked
   task's `blocked-on`, and **carry on** with everything that does not depend on it.
3. `planner sync` copies the answers a human typed into `tasks/INBOX.md` back into the question
   files, unblocks tasks, and moves sufficiently specified drafts to `todo`. A `todo` task is picked
   up by the workers - there is no separate "auto" switch.
4. A task unblocked by an answer carries a `revise-for` marker: it was written BEFORE the answer, so
   it only becomes `todo` after the planner rewrites it for the chosen option and clears the marker.
   `planner next` prioritises it and includes the answer verbatim. The machine never clears the marker.

**Enough context** (checked by the machine): `verify:` not empty · `touches:` not empty (or a
`File:` line) · `blocked-on:` and `revise-for:` empty · every dep exists · all seven analysis answers present.

The planner may only write tasks in `draft`/`needs-decision`; it never touches a task from `todo`
onwards, so it can run alongside the workers. Background runner: `run-planner.sh`; it needs
`.claude/agents/planner.md` (created by `init`).

## `tasks/INBOX.md` - one place for the human

Regenerated by `inbox` (and by the conductor every round). Sections: CI status (when red) ·
**Questions** (answer on the `Answer:` line under each question) · **Awaiting approval** (tasks/bugs
in `needs-human`: gates, `manual:`, too many review rounds or fixer rounds) · merge conflicts ·
reviewer findings · orphaned worktrees.

INBOX is a **view**, not the source of truth: questions live in `tasks/questions/`, approval states
in front-matter. An answer you typed that the planner has not harvested yet survives regeneration.

**Closing reviewer findings.** Reviewer reports are append-only, so a finding that has been dealt
with is closed in a separate ledger, `reports/resolutions.json`
(`{"schemaVersion": 1, "resolutions": [...]}`). An entry matches a finding only when `task`, `role`,
`file`, `line` and `rule` are all equal. Status is one of `fixed` (requires `by` = an existing task id) ·
`accepted` · `wontfix` · `false-positive`; every entry needs a `note` and at least one `evidence` path
that exists on disk. INBOX lists only open findings; `doctor` fails on a malformed ledger and warns on
orphaned entries.

# 5 · Role agents

Each role is a prompt file `.claude/agents/<role>.md` plus an entry in the `roles` table of the
config. A role **only runs when the pattern calls for it** - there is no fixed dev → QA → security chain.

| Kind | Writes | Runs when | Output |
|---|---|---|---|
| `developer` | code within `touches` | every pattern with an implementation step; a role whose `when` matches, otherwise the one with `when.always` | changes + handoff log |
| `evaluator` (e.g. `qa`) | tests, `reports/**`, bug files | the Evaluator overlay, or its `when` | `reports/<id>.<role>.json` + bug files |
| `reviewer` (e.g. `security`) | nothing | the overlay (`security`) or its `when` | a JSON findings block → `reports/` → INBOX; never blocks the merge |
| `fixer` | code | the task has open bugs | fixes on the parent task's branch |
| `planner` | `tasks/**`, `requirements/**` | always (own lane) | tasks, questions |

Built-in roles: `developer`, `qa`, `security`, `planner`; `init` also creates a `fixer` prompt (the
fixer runs with `sonnet` unless you declare a `fixer` role). Custom roles and the `when` conditions
are documented in the plugin README, "Reviewer roles".

`reports/<id>.qa.json` holds `{ok, checked: [...], bugs: [...]}`. To make the verifier the only judge,
add `node <plugin dir>/scripts/report-ok.mjs <id> qa` to the task's `verify:` - it exits 0 only for a
well-formed report with `ok: true` and no bugs.

**Reviewer output.** A reviewer's last message must contain one ```json block:
`{"role", "task", "ok", "checked", "findings": [{"severity", "rule", "file", "line", "detail"}]}`. If a
reviewer exits 0 without a valid block, the conductor calls it once more in a fresh session with the
parse error appended; a second failure is recorded as a failed report in the INBOX.

**`when.diff` (reviewers only)** is evaluated right before the reviewer session would open, on the
task's real diff: at least one changed file must match `paths`, and, if `added` is given, at least one
added line in those files must match one of the regexes. Otherwise the reviewer is skipped (event
`role.skipped`, no report). If the diff cannot be read, the reviewer runs.

**Re-running a reviewer** on a finished task: `review <id> --role <role> [--dry-run]` - for replacing
a broken report; changes no status and commits nothing.

**Permissions of headless sessions.** `--allowedTools` = the `tools:` of `.claude/agents/<role>.md`
(plain `Bash` replaced by narrow patterns) + the role's `bash` patterns + read-only git; always
disallowed: `git push`, `git commit`, `rm -rf`, `<cli> done`, `<cli> approve`. Reviewers get no
write tools whatever their file says. `AGENT_QUEUE_SKIP_PERMISSIONS=1` uses
`--dangerously-skip-permissions` instead (the disallow list stays). This is a guard against
mistakes, not a sandbox: `Bash(node:*)` can run arbitrary code.

**Lean child sessions.** By default each `claude -p` started by the harness loads no MCP servers, no
skills, no Chrome integration and only its role's tools - this saves roughly 40% of the context on
every turn. `childSession` in the config switches these off individually; `AGENT_QUEUE_CHILD_FULL=1`
loads everything for one run. `roles.<role>.maxBudgetUsd` caps the cost of one session; hitting the cap
counts as a failed attempt.

# 6 · Bug loop - QA reports, the conductor assigns, the fixer fixes

QA **files a bug** instead of fixing product code: whoever writes the test and also fixes the code
until it passes is grading their own work.

Each bug is `tasks/B-<parent without dash>-<n>-<slug>.md` (template `tasks/_templates/bug.md`) with
eight required sections (configurable via `headings.bugSections`): Summary · Environment · Steps to
reproduce · Expected · Actual · Evidence · Suspected code · Repro test. A missing or empty section
makes `doctor` fail and the conductor will not assign the bug.

```
parent task:  doing ──bug-found──► waiting-bugs ──retest (all bugs fixed)──► doing
bug:          open ──assign──► fixing ──pass──► fixed
                                  └──fail (round ≤ 2)──► open
                                  └──more than 2 rounds──► needs-human
```

- A bug blocks its parent: no merge while bugs are open.
- The fixer is a **fresh session** on the **parent's worktree and branch**. Several bugs of one
  parent are handled one at a time, `critical` first.
- A bug is `fixed` only when the verifier sees the repro test pass **and** the parent's `verify:` pass.
- No bugs left → the parent is retested by QA (which may find new ones).
- Limits: ≤ 2 fixer rounds per bug (`modelByRound` can switch to a stronger model from round 2) ·
  ≤ 5 open bugs per parent. Beyond that → `needs-human`: the task is probably wrong at its root.

Security findings follow the same path with `found_by: security`; the integrator files
`found_by: integrator` for tests that fail after a rebase.

# 7 · The conductor

```
node <plugin dir>/scripts/conductor.mjs --dry-run      # read-only: print the plan for the first round
node <plugin dir>/scripts/conductor.mjs [--max-rounds N]
```

Each round: `recover` (dead / timed-out workers) → `tick` (a pure function returning actions) →
start background jobs → wait for ONE job to finish, then loop - so a new task starts as soon as a
slot frees up. It runs the planner lane, the fixer lane, ≤ `workers` parallel tasks and ≤ 1
serial-lane task. It skips tasks with a money/migration gate and stops when nothing runnable is left
or everything remaining waits for a human.

Pipeline of one parallel task:

```
start <id> --worker n → worker add (dependencies, env)
  → claude -p developer (and evaluator) in the worktree        ← one role at a time
  → the conductor commits the work in the worktree (agents never commit)
  → verify BEFORE reviewers: red → back to the developer; green → remember the commit
  → claude -p reviewers (concurrently; never block the merge)
  → empty-work guard: nothing changed outside tasks/ and requirements/ → needs-human
  → integrate: rebase → verify again (skipped if the commit is unchanged) → ff-merge
  → verifier writes done (or needs-human) → commit + push → worker rm
```

- Every child `claude -p` runs with `AGENT_QUEUE_DISABLE=1`, so its Stop hook stays out of the way;
  tasks it runs are owned by `conductor`/`worker:*`, which every Stop hook ignores.
- The conductor pushes after each merge (only if the branch has an upstream); `AGENT_QUEUE_PUSH=0` turns that off.
- **Recovery:** a worker that exits non-zero, disappears or exceeds `AGENT_QUEUE_WORKER_TIMEOUT_MIN`
  (default 90) is killed and its task released to `todo` with the worktree kept for the next round.
  Released more than `AGENT_QUEUE_MAX_RETRIES` times → `failed`. After a restart, `doing` tasks with a
  live worktree are adopted. Hitting the Claude usage limit is not a failure: the task goes back to
  `todo`, and the conductor stops with the reset time.
- **Uncommitted work on the main tree** blocks the serial lane unless it belongs to a known
  interrupted serial task; the harness never stashes, resets or deletes your changes.
- **CI watch** (`ci` in the config, needs the `gh` CLI): a red workflow on the watched branch is shown
  at the top of the INBOX and in the conductor output. With `gate: "block"` the harness also stops
  pushing and stops starting new work until CI is green; `unknown` never blocks.
  `AGENT_QUEUE_CI_GATE=warn` bypasses the gate for one run; `AGENT_QUEUE_CI_STATUS=0` disables the check.
- **Logs:** `logs/agent-queue/conductor/<time>.log` for the run; `logs/agent-queue/<id>/<role>.log`
  per role (why it ran, model, command line, output, exit code); `logs/agent-queue/<id>/verifier.log`;
  `logs/agent-queue/planner/`. Passwords are masked everywhere and never appear on a command line.

# Observation - event log and dashboard

This layer only observes: it never changes task state, starts or stops workers, or approves anything.

- **Event log** `logs/agent-queue/events.jsonl`: append-only, one JSON object per line with
  `schemaVersion`; rotated above 50 MB (rotated, never deleted). Event types: `run.start|run.end` ·
  `agent.start|agent.end` (`agent.end` carries `exitCode`, `durationMs`,
  `usage{input,output,cacheRead,cacheWrite}`, `costUsd`, `numTurns`) · `agent.compact` ·
  `task.transition` · `pattern.chosen` · `verify.result` · `finding` · `role.skipped` · `inbox.changed`.
  Common fields: `ts, runId, agentId, parentId, kind (conductor|worker|role|planner|subagent), role,
  model, taskId, slot, worktree, pid`. Prompts are stored only as the first 200 characters (secrets
  masked) plus a hash.
- **Sources:** every `claude -p` started by the conductor, `run-backlog.sh` or `run-planner.sh` (via
  `stream-json`; `agent.start` is written as soon as the process starts), and the
  `SubagentStart`/`SubagentStop` hooks for subagents inside a session (tokens summed from the
  subagent transcript; `null` when unreadable, never zeros). Write errors are ignored with one warning.
- **"Lost signal":** `agent.start` without `agent.end` and a dead `pid` → shown as `lost`. A live
  `pid`, or `null` (subagent) → `running`. Display only; nothing is written back.
- **Dashboard:** `node <plugin dir>/scripts/dashboard-server.mjs [--port 4400]` →
  `http://127.0.0.1:4400`. Loopback only, GET only (`/api/state`, `/api/stream` SSE,
  `/api/log/:agentId`); other methods → 405; unknown `Host` → 403.
- **CLI:** `usage [--since 7d] [--json]` - tokens by role and model (`costUsd` is an estimate, not an
  invoice). `quality [--since 14d] [--json]` - first-pass verify rate, verify runs per task, failure
  rate, findings and bugs per task, by model / developer role / pattern; use it to compare before and
  after changing a prompt, a model or a pattern.
- **Off:** `AGENT_QUEUE_EVENTS=0` (independent of `AGENT_QUEUE_DISABLE`). Other file: `AGENT_QUEUE_EVENTS_FILE`.

# Rules

- The conductor and the scheduler are not LLMs.
- No multi-agent setup unless `choosePattern` calls for it; no fixed role chain.
- No role except the verifier writes `done` or `fixed`.
- QA does not fix product code. The fixer does not edit the repro test.
- No merge of a parent with open bugs.
- Never two agents on one worktree; never two workers sharing a test database or e2e ports.
- The planner never touches a task from `todo` onwards.
- No third attempt in the same way - after two, escalate.
