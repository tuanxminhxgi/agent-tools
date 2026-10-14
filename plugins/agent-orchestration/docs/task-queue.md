# The agent task queue - three separate layers

> How a task must be structured so a machine can read it, and what mechanism lets agents work
> through the whole backlog on their own.

## Why three layers

| Layer | Answers the question | Changes how often |
|---|---|---|
| **1 · State** | Which tasks exist, where they are, what blocks what | Daily |
| **2 · Done** | Is this task really finished? | Every few weeks |
| **3 · Loop** | Who moves the agent on to the next task? | Almost never - but when it does, completely |

The contracts between the layers are deliberately narrow:

```
Layer 1 ──── read ────► Layer 2      the verifier reads `verify:` and NOTHING else
Layer 2 ──── write ───► Layer 1      the verifier is the ONLY place allowed to write `status: done`
Layer 3 ──── call ────► Layer 2      the loop only receives an exit code; it never defines "done" itself
Layer 3 ──── read ────► Layer 1      the loop asks "what is the next task", it does not guess
```

Because of these contracts you can swap the loop (Stop hook, headless `claude -p` script, the
conductor, CI) without touching layers 1 and 2: every loop calls the same `next` / `prompt` /
`start` / `done` commands.

# Layer 1 · State - files on disk

One task = one file `tasks/<ID>-<slug>.md`, where the ID is one capital letter and three digits
(`T-012`, `A-003`). The YAML front-matter is for the machine, the markdown body for humans.

```markdown
---
id: T-012
title: Export the monthly report as CSV
status: todo              # draft | needs-decision | todo | doing | done | failed | needs-human | waiting-bugs
deps: [T-010, T-011]
gate: none                # none | money | migration | manual
verify:
  - npm test -- report-export
  - npm run build
manual: []                # checks only a human can do, e.g. "Open the file in a spreadsheet: amounts are numbers"
owner: null
updated: null
---
```

There are also orchestration fields (see [`orchestration.md`](orchestration.md)): `complexity`,
`domains`, `risk`, `touches`, `locks`, `blocked-on`, `revise-for`, `pattern`, `steps`, `context`.
All have defaults when omitted.

| Field | Written by a human | Written by the machine |
|---|---|---|
| `id`, `title`, `deps`, `gate`, `verify`, `manual` | yes, when writing the task | no |
| `status` | only to reset it | yes, through the state machine |
| `owner`, `updated` | no | yes |

`blocked` is **derived** from `deps`, never stored. `done` has no way out: if something needs fixing,
open a new task that depends on it.

The body's `- [ ]` checkboxes are notes for humans; the machine never reads them as state.

**Next task, deterministically:** on the critical path (a line in `tasks/INDEX.md` containing the
phrase `critical path`, configurable via `headings.criticalPath`) → blocks more other tasks → smaller id.

# Layer 2 · Done - checked by commands

> A task is `done` when **every command in `verify:` exits 0**, and `manual:` is empty or a human has confirmed it.

- No `verify:` means the task can never become `done` on its own.
- `manual:` items left → when the automated part passes the task moves to `needs-human`; a human
  confirms with `done <id> --manual-ok`. That flag is not part of any automated flow.
- A command that needs `TEST_DATABASE_URL` when it is not set is `skipped`, NOT `failed`: "could not run
  yet" is different from "ran and failed". A task with a skipped command goes to `needs-human`, never `done`.
- A failing command keeps its output VERBATIM. A summary loses exactly the information the agent needs to fix it.

## Gates - stop BEFORE starting

| Rule | Source |
|---|---|
| Touches a migration file | `risk.migrationPaths` in the config, or `gate: migration` |
| Touches money | `risk.moneyKeywords` in the config, or `gate: money` |

A task that only has `manual:` items (or `gate: manual`) is **not** stopped up front: the automated
part still runs, and a human checks afterwards. `AGENT_QUEUE_GATES=off` disables the money/migration
gates, never the visual-check gate.

# Layer 3 · Loop

| Mechanism | Use it when |
|---|---|
| **Stop hook** (installed by the plugin) | A few tasks in a row, inside one interactive session |
| **`run-backlog.sh`** - one `claude -p` per task | A long backlog where each task needs a clean context |
| **Conductor** - `scripts/conductor.mjs` | The whole system: planner, parallel workers, roles, bug loop (see `orchestration.md`) |

Never run the conductor and a Stop-hook chain on the same backlog at the same time.

## Stop hook flow

```
Stop hook runs
  ├─ AGENT_QUEUE_DISABLE=1?            → exit immediately
  ├─ no `doing` task owned by THIS session? → exit (ordinary session)
  └─ a `doing` task of this session → run the check commands (even if manual: items remain)
       ├─ FAILED, attempt <= MAX_RETRIES  → block the stop, hand the VERBATIM error back to the agent
       ├─ FAILED, over the limit          → failed, stop
       └─ PASSED → manual left ? needs-human : done — commit — then:
             ├─ no tasks left                       → stop + report
             ├─ next task has a money/migration gate → stop, wait for approval
             ├─ chain limit reached                 → stop
             └─ otherwise                           → claim the next task, block the stop with its prompt
```

"Block" means printing `{"decision":"block","reason":"..."}`: Claude Code treats `reason` as a new
request, so the agent keeps going without anyone typing.

**Whose task?** The hook only settles a task whose `owner` is this session's id (`start` run from
Claude Code records it), or a task nobody owns. Tasks owned by the conductor, a worker or another
session are skipped. A task held by a session that has ended is settled by nobody - `release <id>`,
then `start` it again in a new session.

## Every finished task is one commit

The "task done" boundary is the most natural commit boundary: it was just confirmed by the check
commands, so **every commit in history is a working state**. The commit happens after `status: done`
is written, so the status flip is part of it. The message names the task and lists the commands that
passed. Commits are skipped (never an error) when: not a git repo · protected branch
(`AGENT_QUEUE_PROTECTED_BRANCHES`) · detached HEAD · merge/rebase in progress · nothing changed.
Push only happens with `AGENT_QUEUE_PUSH=1` and only when the branch has an upstream.

## Safety rails

1. **Two counters with limits** - claiming a new task increments `chained` (`AGENT_QUEUE_MAX_CHAIN`,
   default 5); being sent back to fix a failure increments the consecutive-failure count
   (`AGENT_QUEUE_MAX_RETRIES`, default 2). Every block increments one of them, so the loop is always
   bounded. The hook does NOT rely on `stop_hook_active`: that flag is set on every stop right after a
   block, and relying on it would mean a just-finished task never gets settled.
2. **One task at a time** per worktree.
3. **The hook never breaks a session** - unexpected errors are written to `.claude/agent-queue.log` and the hook exits 0.

## Rules

- No layer except the verifier writes `done`.
- Checkboxes are never state.
- No new "block" branch without incrementing a bounded counter.
- No external libraries - everything runs with plain Node >= 20.
