# INDEX - project tasks

> One task = one file `tasks/<ID>-<slug>.md` (ID = one capital letter + three digits, e.g. `T-001`),
> reviewable on its own. The front-matter is the **source of truth** (`status`, `deps`, `gate`,
> `verify`, `manual`, ...); `- [ ]` checkboxes in the body are notes for humans only.
> Templates: `tasks/_templates/`. Things that need a human: `tasks/INBOX.md`.
>
> Task numbers follow dependency order.

| ID | Title | Area | Depends on | Estimate |
|---|---|---|---|---|

<!--
Any line containing the words "critical path" (case-insensitive; configurable as
`headings.criticalPath`) marks every task ID on that line as being on the CRITICAL PATH.
Those tasks are picked first when choosing the next task. Example (write real IDs instead of
the placeholders - and keep real IDs out of this comment, because comment lines are read too):

**Critical path**: <first ID> -> <second ID> -> <third ID>
-->
