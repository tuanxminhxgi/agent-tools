---
id: B-T012-1              # B-<parent id without the dash>-<sequence number>
parent: T-012
title: <one sentence describing the bug>
severity: high            # critical | high | medium | low
status: open              # open | fixing | fixed | needs-human
found_by: qa              # qa | security | integrator
verify:
  - <command that runs the repro test - it FAILS when the bug is filed>
touches: []               # suspected code area (globs)
rounds: 0                 # fixer rounds so far - incremented by the harness; > 2 means needs-human
owner: null
updated: null
---

# B-T012-1 · <title>

<!-- All eight sections below are required. If one is missing or empty, `doctor` fails and the
     conductor will not hand the bug to a fixer. QA/security do NOT fix product code - they only file this. -->

## Summary
<one sentence>

## Environment
- Commit:
- Worktree / branch:
- Commands run:
- Relevant environment variables:

## Steps to reproduce
1.
2.
3.

## Expected

## Actual

## Evidence
<!-- The failing test output VERBATIM, not summarised. Traces, screenshots, logs. -->
```
```

## Suspected code
<!-- file:line if known -->

## Repro test
<!-- Path of the failing test. The fixer must NOT edit this test to make it pass. -->

## Handoff log
