---
id: T-xxx
title: <one line, same as the heading below>
status: draft             # the planner writes drafts; the harness moves a task to todo once it has enough context
deps: []
gate: none                # none | money | migration | manual
verify:
  - <command that exits 0 when done>
manual: []                # checks only a human can do, e.g. "Open the exported file in a spreadsheet: amounts are numbers"
owner: null
updated: null
complexity: M             # S <= 3 files · M one module · L several modules · XL several areas/domains
domains: []               # domain names from `skills`/`domains` in .claude/agent-queue.config.json; empty = inferred
risk: low                 # inferred from gate/touches; a hand-written value can only RAISE it
touches: []               # globs of the files you will change - the scheduler uses them to decide what can run in parallel
locks: []                 # lock names from `locks` in the config, or lockfile | money
blocked-on: []            # [Q-xxx] questions still waiting for a human
revise-for: []            # set by the harness when a question was just answered; the planner rewrites the task, then clears it
pattern: auto             # auto = the conductor chooses; if you override it, explain why in the analysis
steps: []                 # Workflow pipeline only
context: null             # context group (kebab-case): the developer receives tasks/_context/<group>.md; null = no group
---

# T-xxx · <title>

Area: <area or milestone>
Depends on: -
File: `<path>`
Requirement: `requirements/<file>.md`

## Goal
<why this is needed and who benefits>

## Orchestration analysis
1. End goal:
2. Subtasks:
3. Dependencies between subtasks:
4. What can run independently or in parallel:
5. Expertise and tools:
6. Validation:
7. Done condition (same as the verify commands):

## Contract
<function signatures, endpoints, schemas - whatever other code will rely on>

## Work
- [ ]

## Done when (each item checkable by a command)
- [ ]

## Do not
-

## Handoff log
<!-- Every agent appends 3-5 lines: what it did · what it decided and why · what is left.
     The next agent reads only this section, the task file and the diff - never a transcript. -->
