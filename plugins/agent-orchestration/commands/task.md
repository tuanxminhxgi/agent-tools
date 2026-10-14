---
description: Agent task queue - status · next · prompt <id> · start <id> · verify <id> · done <id> · inbox · pattern · planner sync|next · usage · quality · doctor …
argument-hint: <command> [id] [--json]
allowed-tools: Bash(node:*)
---

Run the task-queue CLI from the project root with exactly the arguments the user gave:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" $ARGUMENTS
```

With no arguments, run `help`.

Then summarise the result briefly for the user: which tasks changed state, which check commands failed
(quote the failing lines VERBATIM), and what is waiting for a human.

Rules:
- NEVER edit the `status` field of a task file by hand - every state change goes through the CLI.
- NEVER run `done <id> --manual-ok` on your own: that flag is a HUMAN's statement that they checked the
  result with their own eyes. Run it only when the user typed that exact flag.
- If the command exits with a non-zero code, report exactly that; do not describe it as "almost done".
