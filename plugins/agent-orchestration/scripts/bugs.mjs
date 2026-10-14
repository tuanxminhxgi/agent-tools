// @ts-check
/**
 * BUG LOOP (A-013) — QA/security/integrator file structured bugs, the conductor assigns a FIXER.
 * Design: docs/agent-orchestration.md §6.
 *
 *   evaluator files tasks/B-<parent>-<n>-*.md (8 sections, reproduction test RED)
 *     → parent task `doing → waiting-bugs` (no merge while bugs are open)
 *     → nextBug picks a bug (critical first; bugs of one parent run serially on the parent's worktree)
 *     → fixer fixes → verifier: reproduction test green + parent verify green + reproduction test NOT edited
 *     → bug `fixed` · no open bugs left → parent `retest` → QA reruns
 *   Guards: ≤ 2 rounds per bug (over → bug needs-human) · ≤ 5 open bugs per parent (over → parent needs-human).
 *
 * Pure functions: no file reads, no commands. The conductor (A-014/A-025) executes.
 */
import { bugGaps } from "./doctor.mjs";
import { sectionOrNull } from "./backlog.mjs";
import { config } from "./config.mjs";

export const MAX_ROUNDS = 2;
export const MAX_OPEN_PER_PARENT = 5;
const SEVERITY = ["critical", "high", "medium", "low"];

/** @typedef {import("./backlog.mjs").Bug} Bug */
/** @typedef {import("./backlog.mjs").Task} Task */

/**
 * Is the bug ready for a fixer: all 8 body sections filled + a command that runs the reproduction test.
 * @param {Bug} bug @returns {{ok: boolean, missing: string[]}}
 */
export function validateBug(bug) {
  const missing = bugGaps(bug.body);
  if (bug.verify.length === 0) missing.push("verify (command running the reproduction test)");
  return { ok: missing.length === 0, missing };
}

/**
 * File paths in the reproduction-test section (last of `config.headings.bugSections`) — the fixer must NOT edit them.
 * @param {Bug} bug @returns {string[]}
 */
export function reproFiles(bug) {
  const text = sectionOrNull(bug.body, config.headings.bugSections.at(-1) ?? "") ?? "";
  const found = [...text.matchAll(/`([^`\s]+\.[A-Za-z]+)`|(^|\s)([\w./-]+\.(?:test|spec)\.[A-Za-z]+)/gm)]
    .map((m) => m[1] ?? m[3])
    .filter((x) => typeof x === "string");
  return [...new Set(found)];
}

/**
 * Next bug to assign to a fixer. DETERMINISTIC: severity, then id. Skips invalid bugs, bugs out of rounds,
 * and every bug whose parent already has a fixer running (bugs of one parent are fixed SERIALLY on one worktree).
 * @param {Map<string, Bug>} bugs
 * @param {Bug[]} running  bugs currently being fixed
 * @returns {Bug|null}
 */
export function nextBug(bugs, running) {
  const busyParents = new Set([
    ...running.map((b) => b.parent),
    ...[...bugs.values()].filter((b) => b.status === "fixing").map((b) => b.parent),
  ]);
  const candidates = [...bugs.values()]
    .filter((b) => b.status === "open" && !busyParents.has(b.parent) && b.rounds < MAX_ROUNDS)
    .filter((b) => validateBug(b).ok)
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/**
 * Fixer prompt: the bug file VERBATIM (evidence not summarised) + parent task + handoff log + the parent's
 * diff. No transcript parameter.
 * @param {Bug} bug @param {Task} parent @param {string} diff
 * @returns {string}
 */
export function fixerPrompt(bug, parent, diff) {
  const handoff = sectionOrNull(parent.body, config.headings.handoff) ?? "";
  const protectedFiles = reproFiles(bug);
  return [
    `You are the **fixer** for bug ${bug.id} (${bug.severity}) of task ${parent.id}: ${parent.title}.`,
    "Read .claude/agents/fixer.md and follow its rules exactly. Repo conventions: AGENTS.md.",
    `You are in the parent task's worktree (${parent.id}); fix on its branch.`,
    "",
    `## Bug (${bug.file}) — verbatim`,
    bug.body.trim(),
    "",
    `## Parent task (${parent.file})`,
    parent.body.trim(),
    ...(handoff.trim() ? ["", `## ${config.headings.handoff} of the parent task`, handoff.trim()] : []),
    "",
    "## Current diff of the parent task",
    diff.trim() === "" ? "(no changes yet)" : "```diff\n" + diff.trim() + "\n```",
    "",
    "Done when: the reproduction test turns GREEN and every `verify:` command of the parent task stays green.",
    ...bug.verify.map((c) => `  - ${c}`),
    ...parent.verify.map((c) => `  - ${c}`),
    protectedFiles.length > 0
      ? `Do NOT edit the reproduction test (${protectedFiles.join(", ")}) — editing it to go green is rejected and the bug goes back to open.`
      : "Do NOT edit the reproduction test — fix the code so the test goes green.",
    `Write 3–5 lines under \`## ${config.headings.handoff}\` in the BUG file. Do NOT edit the \`status\` field, do not commit/push.`,
  ].join("\n");
}

/**
 * @typedef {Object} FixResults
 * @property {boolean} repro         the bug's `verify:` command (reproduction test) is green
 * @property {boolean} parentVerify  the parent task's `verify:` commands are green
 * @property {string[]} changed      files the fixer changed
 */

/** Can the bug be closed — ONLY when both sides are green and the reproduction test is untouched. PURE FUNCTION.
 * @param {Bug} bug @param {FixResults} results @returns {boolean} */
export function canCloseBug(bug, results) {
  return fixVerdict(bug, results).event === "pass";
}

/**
 * Event for the bug state machine after one fixer round (`BUG_TRANSITIONS`: pass · fail · exhaust).
 * @param {Bug} bug @param {FixResults} results
 * @returns {{event: "pass"|"fail"|"exhaust", reason: string}}
 */
export function fixVerdict(bug, results) {
  const touched = reproFiles(bug).filter((f) => results.changed.some((c) => c === f || c.endsWith(`/${f}`)));
  /** @type {string|null} */
  let problem = null;
  if (touched.length > 0) problem = `fixer edited the reproduction test (${touched.join(", ")}) — rejected`;
  else if (!results.repro) problem = "reproduction test still red";
  else if (!results.parentVerify) problem = "parent task verify red after the fix";
  if (problem === null) return { event: "pass", reason: "reproduction test green + parent verify green" };
  // `rounds` is the number of rounds ALREADY used before this one.
  return bug.rounds + 1 >= MAX_ROUNDS
    ? { event: "exhaust", reason: `${problem}; ${bug.rounds + 1} round(s) used — needs a human` }
    : { event: "fail", reason: problem };
}

/**
 * Event for the PARENT task given its bugs' states (`TRANSITIONS`). PURE FUNCTION, deterministic.
 *   doing + some bug not fixed          → bug-found (no merge while bugs remain)
 *   waiting-bugs + > 5 bugs not fixed   → gate (needs-human)
 *   waiting-bugs + all bugs fixed       → retest
 * @param {Map<string, Task>} backlog @param {Map<string, Bug>} bugs
 * @returns {{id: string, event: "bug-found"|"retest"|"gate", reason: string}[]}
 */
export function parentEvents(backlog, bugs) {
  /** @type {{id: string, event: "bug-found"|"retest"|"gate", reason: string}[]} */
  const out = [];
  for (const task of [...backlog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const mine = [...bugs.values()].filter((b) => b.parent === task.id);
    if (mine.length === 0) continue;
    const open = mine.filter((b) => b.status !== "fixed");
    if (task.status === "doing" && open.length > 0) {
      out.push({ id: task.id, event: "bug-found", reason: `${open.length} unfixed bug(s)` });
    } else if (task.status === "waiting-bugs" && open.length > MAX_OPEN_PER_PARENT) {
      out.push({ id: task.id, event: "gate", reason: `${open.length} open bugs > ${MAX_OPEN_PER_PARENT} — the task is wrong at the root, needs a human` });
    } else if (task.status === "waiting-bugs" && open.length === 0) {
      out.push({ id: task.id, event: "retest", reason: "all bugs fixed — QA reruns" });
    }
  }
  return out;
}
