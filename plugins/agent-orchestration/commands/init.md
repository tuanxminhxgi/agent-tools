---
description: Set up the agent task queue in this project - tasks/, templates, INDEX, requirements/, config, role prompts and the rules section in AGENTS.md. Never overwrites existing files.
argument-hint: [project name]
allowed-tools: Bash(node:*), Read
---

Set up the task-queue scaffolding in the open project.

1. Project name: use `$ARGUMENTS` if given; otherwise the name of the project's root directory.
2. From the project root, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" init --name "<project name>"
   ```

3. Report back exactly the list the command printed: which files were **created** (`+`), which were
   **appended to** (`~`), and which were **kept unchanged** (`=`). Never claim to have created a file
   the command reported as kept.
4. Suggest the next steps, briefly:
   - open `.claude/agent-queue.config.json` and fill in `skills` (which skill applies to which
     directory), money keywords and migration paths - every key has a `//...` comment next to it.
     Ready-made examples for other stacks are in `${CLAUDE_PLUGIN_ROOT}/templates/examples/`;
   - write a requirement in `requirements/` (template in `requirements/README.md`) or write a task
     directly in `tasks/` from `tasks/_templates/task.md`;
   - `/agent-orchestration:task start <id>` to start the self-running chain.

Do NOT edit or delete any file that `init` did not create. Do NOT create sample tasks.
