# agent-tools

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Claude Code plugin marketplace. It currently ships one plugin:

| Plugin | Version | What it does |
|---|---|---|
| [`agent-orchestration`](plugins/agent-orchestration/README.md) | 0.2.0 | Task queue for AI agents: tasks are markdown files with front-matter, only the verifier marks a task done after its check commands pass, a Stop hook chains the next task, a planner splits requirements and asks without stopping, and a conductor runs parallel workers, QA/reviewers and a bug-fix loop. |

## Install

You need Node ≥ 20 and a git repository to install into. Nothing else to install: the plugin has no
dependencies.

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
folder) is offered the marketplace and the plugin. Install it at **project** (or local) scope rather than
user scope if some of your repositories already run their own task-chaining Stop hook:

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

## Feedback and contributions

- Questions, ideas, "here is how we use it": [Discussions](https://github.com/tuanxminhxgi/agent-tools/discussions)
- Bugs and feature requests: [Issues](https://github.com/tuanxminhxgi/agent-tools/issues/new/choose)
- Pull requests are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first: the plugin's code and its
  test suite live in the maintainer's own repository and are copied here on each release, so code PRs are
  reviewed here and shipped through that repository (docs, templates and example configs merge directly).

## License

[MIT](LICENSE)
