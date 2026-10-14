# agent-tools

A private Claude Code plugin marketplace. It currently ships one plugin:

| Plugin | Version | What it does |
|---|---|---|
| [`agent-orchestration`](plugins/agent-orchestration/README.md) | 0.2.0 | Task queue for AI agents: tasks are markdown files with front-matter, only the verifier marks a task done after its check commands pass, a Stop hook chains the next task, a planner splits requirements and asks without stopping, and a conductor runs parallel workers, QA/reviewers and a bug-fix loop. |

## Install

You need read access to this repository (it is private) and Git credentials for GitHub on your machine,
plus Node ≥ 20 and a git repository to install into.

In Claude Code:

```
/plugin marketplace add tuanxminhxgi/agent-tools
/plugin install agent-orchestration@agent-tools
```

Then, inside your project:

```
/agent-orchestration:init
```

`init` creates `tasks/`, the templates, `tasks/INDEX.md`, `requirements/`, `.claude/agent-queue.config.json`
and a rules section in `AGENTS.md`. Running it again overwrites nothing. Adapt the config to your stack —
`plugins/agent-orchestration/templates/examples/` has starting points for a Node/TypeScript monorepo,
a Python/Django project and a Go service. Full guide: [plugin README](plugins/agent-orchestration/README.md).

## Enable it for a whole team

Commit this to the project's `.claude/settings.json`; everyone who opens the project (and trusts the
folder) is offered the marketplace and the plugin:

```json
{
  "extraKnownMarketplaces": {
    "agent-tools": { "source": { "source": "github", "repo": "tuanxminhxgi/agent-tools" } }
  },
  "enabledPlugins": { "agent-orchestration@agent-tools": true }
}
```

## Updates

```
/plugin marketplace update agent-tools
```

Every release bumps `version` in `plugins/agent-orchestration/.claude-plugin/plugin.json` and adds an
entry to [`CHANGELOG.md`](plugins/agent-orchestration/CHANGELOG.md).

## Where the code lives

This repository is a **published copy**. The source of `plugins/agent-orchestration/scripts/` and
`hooks/*.mjs` is maintained (with its test suite) in another repository and copied here on release —
do not edit those files here; open an issue or contact the maintainer instead.
