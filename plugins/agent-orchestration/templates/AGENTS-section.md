<!-- agent-orchestration:start - added by /agent-orchestration:init; edit freely, init never overwrites it -->
## Agent task queue

- The backlog lives in `tasks/<ID>-<slug>.md`. The front-matter is the **source of truth** (`status`, `deps`, `gate`, `verify`, `manual`); `- [ ]` checkboxes in the body are notes for humans only. Templates: `tasks/_templates/`.
- Commands: `/agent-orchestration:task status | next | prompt <id> | start <id> | verify <id> | done <id> | inbox | pattern`.
- **Agents never edit `status` and never mark a task complete themselves.** Only the verifier does that, and only when every command in `verify:` exits 0.
- Tasks that touch **money or migrations** (rules in `.claude/agent-queue.config.json`) stop BEFORE they start and wait for a human. Tasks that only need a **visual check** (`manual:`) still run: when the automated checks pass they move to `needs-human` and the chain continues; a human confirms with `done <id> --manual-ok`.
- Everything that needs a human is collected in `tasks/INBOX.md` - answer questions on the `Answer:` line.
- Turn the automation off: `AGENT_QUEUE_DISABLE=1` (in your shell, not in `.claude/settings.json`).

## Dynamic orchestration - before starting any task

- Answer and **show** the seven questions: end goal · subtasks · dependencies · what can run in parallel · expertise/tools · validation · done condition. New tasks record them in the `## Orchestration analysis` section.
- Pick the **simplest pattern that is reliable enough** (skill `orchestration`), and say why a more complex one is not needed.
- Hand off through the task file + diff + the `## Handoff log` section, never a transcript. Retry at most twice with the verbatim error; after that, escalate.
<!-- agent-orchestration:end -->
