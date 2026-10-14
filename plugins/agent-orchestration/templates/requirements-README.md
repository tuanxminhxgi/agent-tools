# requirements/ - input for the planner

Each requirement is one file, `requirements/<slug>.md`. The planner agent reads them one at a time
(highest `priority` first, then by file name), splits each into tasks `tasks/T-xxx-*.md` following
`tasks/_templates/task.md`, and then marks the requirement `planned: true`. Questions that need a
human decision go to `tasks/INBOX.md`, not here.

## Template

```markdown
---
title: <requirement name>
priority: normal          # high | normal | low - the order the planner reads requirements in
planned: false            # the planner sets this to true once the tasks are written
tasks: []                 # the planner lists the T-xxx it created
---

# <requirement name>

## Goal
Who benefits, and how. One paragraph.

## Scope
- In:
- Out:

## Constraints
Business rules, legal, performance, who may do what, things that must not change.

## Acceptance criteria
Each line must be convertible into a check command or a `manual:` item.

## Open questions
Things the author already knows are unclear. The planner turns them into Q-xxx in the INBOX.
```

## Rules

- Humans write requirements; **the planner never edits the body** - it only sets `planned` and `tasks`.
- If a requirement changes after `planned: true`, edit the file and set `planned: false` again; the
  planner compares it with the tasks it already created and opens new tasks for the difference.
  Tasks that are already `done` are never reopened.
