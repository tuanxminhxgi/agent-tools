---
name: orchestration
description: Dynamic orchestration rules - before starting ANY task, answer seven analysis questions and pick the SIMPLEST orchestration pattern that is reliable enough (single agent -> pipeline -> router -> parallel -> evaluator/optimizer -> planner/executor -> hierarchical). Use when picking up a new task, when asked whether to use multiple agents, or when writing a task into tasks/*.md.
---

# Dynamic orchestration

Every task runs with **the simplest pattern that still completes it reliably**. There is no fixed
workflow for all tasks. Each extra agent costs another context start-up, more tokens, more latency,
and one more hand-off where information can get lost.

## Before you start - seven questions, written out

1. What is the **end goal** of the task?
2. Which **subtasks** does it need?
3. Which subtasks **depend** on which?
4. Which subtasks can run **independently / in parallel**?
5. What **expertise / tools** are needed?
6. What **validation / evaluation** proves the result is right?
7. What is the **done condition**? (It must be checkable by a command - the same as the task's `verify:`.)

A task written into `tasks/*.md` records these seven answers in its `## Orchestration analysis`
section, one numbered line each (`1. End goal: ...`). `doctor` fails a `todo`/`doing` task whose
analysis is missing or has an empty answer.

## Choosing the pattern - the first matching rule wins

| Condition | Pattern |
|---|---|
| A fixed sequence of steps whose inputs and outputs are predictable (`steps:` declared) | **Workflow / pipeline** |
| Very large (XL) or >= 3 domains | **Hierarchical multi-agent** - ONLY here |
| Large (L), several dependent subtasks | **Planner -> Executor** (independent children run **in parallel**, always followed by an integration step) |
| Exactly 2 domains | **Router** - each part goes to a specialist agent |
| Anything else | **Single agent + tools** |

Overlays, added independently of the core pattern:
- Medium risk (e.g. server-side code matched by `risk.mediumPatterns`) -> **Evaluator -> Optimizer** with QA.
- High risk (auth, routes, uploads, permissions, money, migrations) -> QA **and** security.

The thresholds come from the `riskAtLeast` of the `qa` and `security` roles in
`.claude/agent-queue.config.json`. The harness computes the pattern for you:
`/agent-orchestration:task pattern <id>` prints the pattern and the reason.

## While you work

- Keep **task state** in the front-matter; never edit `status` yourself - the CLI and the verifier do that.
- Hand off between agents through **the task file + the diff + the `## Handoff log` section**
  (3-5 lines: what was done, what was decided, what is left). Never pass a transcript.
- Validate important output. Retry at most twice, each time with the VERBATIM error; then escalate.
- **Escalate** when the task turns out more complex than planned (edits outside `touches`, diff above
  the size threshold, the same failure twice). **Simplify** when the remaining work gets simpler.
- No unnecessary agents, no repeated context.

## Say so when you deviate

If you choose a different pattern than `pattern` suggests (e.g. it says Router but the specialist
agent does not exist yet), write the reason in the handoff log. Overriding with a reason is fine;
overriding silently is not.
