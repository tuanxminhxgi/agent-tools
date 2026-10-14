# Contributing

Thanks for trying agent-orchestration! Feedback from other stacks and teams is exactly what this
project needs.

## Ways to help

- **Use it and tell us** — what worked, what was confusing, what your config looks like:
  [Discussions](https://github.com/tuanxminhxgi/agent-tools/discussions).
- **Report a bug** — open an [issue](https://github.com/tuanxminhxgi/agent-tools/issues/new/choose) with the
  bug template. Paste logs verbatim (`.claude/agent-queue.log`, `logs/agent-queue/<task>/…`) but remove
  secrets first.
- **Suggest a feature** — use the feature-request template; describe the problem before the solution.
- **Share an example config** for your stack — a PR adding a file to
  `plugins/agent-orchestration/templates/examples/` is very welcome.

## Pull requests

The code under `plugins/agent-orchestration/scripts/` and `hooks/*.mjs` is developed, with its test suite
(about 1,500 tests), in the maintainer's own repository and **copied here on each release**. So:

1. Open an issue (or comment on one) first for anything beyond a small fix, so we agree on the approach.
2. Send the PR against this repository as usual — docs, templates and examples can be merged directly.
3. For code changes, the maintainer reviews the PR, ports it to the source repository with tests,
   and the change ships in the next release; the PR is then closed with a link to that release.
   Your authorship is kept with a `Co-authored-by:` trailer.

Code style: plain Node ≥ 20 ES modules, no dependencies, `// @ts-check` with JSDoc types, pure functions
for decisions (no clock, no I/O) so they can be tested with tables of cases. Behaviour that depends on a
project's stack belongs in `.claude/agent-queue.config.json`, never hard-coded.

## Releases

Each release bumps `version` in `plugins/agent-orchestration/.claude-plugin/plugin.json` and adds an entry
to `plugins/agent-orchestration/CHANGELOG.md`. Users update with `/plugin marketplace update agent-tools`.
