// @ts-check
/**
 * LAYER 3 (decisions) — every task runs with the SIMPLEST pattern that is reliable enough.
 * Design: docs/agent-orchestration.md §2.
 *
 * The LLM analyses (the planner writes `complexity`, `domains`, `steps`… into the front-matter),
 * the MACHINE decides here. Pure functions: no file reads, no commands, no LLM calls —
 * so they are table-testable and give the same result twice.
 */
import { config } from "./config.mjs";
import { inferRisk, rank } from "./backlog.mjs";
import { fileInLock, matchAny } from "./glob.mjs";
import { inferLocks } from "./schedule.mjs";

/** @typedef {"single"|"pipeline"|"router"|"planner-executor"|"hierarchical"} Core */
/**
 * @typedef {Object} PatternChoice
 * @property {Core} core
 * @property {("qa"|"security")[]} evaluate   Evaluator → Optimizer overlay
 * @property {boolean} parallel               the core pattern spawns subtasks that can run in parallel
 * @property {string} reason                  one sentence: which rule matched
 */

/** Increasing complexity order — used to tell "running heavier than needed". */
export const CORE_RANK = /** @type {const} */ ([
  "single", "pipeline", "router", "planner-executor", "hierarchical",
]);

/** Evaluator-overlay roles and their default risk thresholds, in the order they appear in `evaluate`. */
const EVALUATOR_DEFAULTS = /** @type {const} */ ([["qa", "medium"], ["security", "high"]]);

/** @param {string} core */
const coreRank = (core) => CORE_RANK.indexOf(/** @type {Core} */ (core));

/**
 * The risk threshold enabling each Evaluator-overlay role comes from the `roles` table (`roles.qa.when.riskAtLeast`,
 * `roles.security.when.riskAtLeast`) — changing a threshold is a config edit, not a code edit. A role absent from the
 * table is never added; a role present without a threshold uses the old default (qa: medium, security: high).
 * @param {import("./backlog.mjs").Task} task
 * @param {Record<string, import("./project-config.mjs").RoleRule>} [roles]
 * @returns {PatternChoice}
 */
export function choosePattern(task, roles = config.roles) {
  const { core, why } = chooseCore(task);
  /** @type {("qa"|"security")[]} */
  const evaluate = [];
  for (const [role, fallback] of EVALUATOR_DEFAULTS) {
    const rule = roles[role];
    if (rule && rank(task.risk) >= rank(rule.when.riskAtLeast ?? fallback)) evaluate.push(role);
  }

  const overlay = evaluate.length === 0 ? "" : ` · risk ${task.risk} → +${evaluate.join(" +")}`;
  return {
    core,
    evaluate,
    // Only these two patterns spawn subtasks; which ones actually run in parallel is
    // the lane scheduler's job (A-010), based on `touches`/`locks`.
    parallel: core === "planner-executor" || core === "hierarchical",
    reason: `${why}${overlay}`,
  };
}

/**
 * First matching rule wins. The table is ordered by SIGNAL specificity, and the result
 * falls back to `single` when no rule demands something heavier — so the chosen pattern
 * is always the simplest the data allows.
 * @param {import("./backlog.mjs").Task} task @returns {{core: Core, why: string}}
 */
function chooseCore(task) {
  const n = task.domains.length;
  const hierarchicalAllowed = task.complexity === "XL" || n >= 3;

  if (task.pattern !== "auto") {
    // A manual override is honoured, EXCEPT Hierarchical: it is only valid when the data
    // demands it — otherwise one hand-written line would be enough to burn several times the tokens.
    if (task.pattern !== "hierarchical" || hierarchicalAllowed) {
      return { core: /** @type {Core} */ (task.pattern), why: `manual override: ${task.pattern}` };
    }
  }
  const refused = task.pattern === "hierarchical" && !hierarchicalAllowed
    ? "refused hierarchical override (not XL, < 3 domains); " : "";

  if (task.steps.length > 0) {
    return { core: "pipeline", why: `${refused}${task.steps.length} fixed steps → pipeline` };
  }
  if (hierarchicalAllowed) {
    const sig = task.complexity === "XL" ? "XL" : `${n} domains`;
    return { core: "hierarchical", why: `${refused}${sig} → hierarchical` };
  }
  if (task.complexity === "L") {
    return { core: "planner-executor", why: `${refused}L → planner → executor` };
  }
  if (n === 2) {
    return { core: "router", why: `${refused}2 domains (${task.domains.join(", ")}) → router` };
  }
  const where = n === 1 ? `1 domain (${task.domains[0]})` : "no domain inferred, generic agent";
  return { core: "single", why: `${refused}${task.complexity}, ${where} → single` };
}

/**
 * @typedef {Object} DiffStat  measurements from `git diff --numstat` against the merge base
 * @property {{path: string, added: number, deleted: number}[]} files
 */
/**
 * @typedef {Object} History
 * @property {Core} [running]      core pattern currently running
 * @property {string[]} [failures] verify failure signatures, oldest → newest
 */

/**
 * The pattern chosen at the start is a HYPOTHESIS. This compares reality with it and returns
 * ONE event for the state machine — the agent never changes the pattern itself. PURE FUNCTION.
 *
 * Order: escalate first (wrong direction → stop now), then simplify, then skip security.
 *
 * @param {import("./backlog.mjs").Task} task
 * @param {DiffStat} diff
 * @param {History} [history]
 * @returns {null | {event: "escalate"|"simplify"|"skip-security", reason: string}}
 */
export function reassess(task, diff, history = {}) {
  // The task's own file is always edited (checkboxes, handoff log) — not counted.
  const files = diff.files.filter((f) => f.path !== task.file);

  const outside = files.filter((f) => !matchAny(task.touches, f.path)).map((f) => f.path);
  if (outside.length > 0) {
    const shown = outside.slice(0, 3).join(", ") + (outside.length > 3 ? ", …" : "");
    return { event: "escalate", reason: `edited ${outside.length} file(s) outside touches: ${shown}` };
  }

  // A-080: `inferLocks` only attaches an "anywhere" lock when touches names that kind of file explicitly. A task
  // declaring `packages/ui/**` that quietly changes a lockfile would run in the parallel lane without the lock — caught here.
  const held = new Set(inferLocks(task));
  for (const [lock, globs] of Object.entries(config.lockRules)) {
    if (held.has(lock)) continue;
    const unheld = files.filter((f) => fileInLock(globs, f.path)).map((f) => f.path);
    if (unheld.length === 0) continue;
    const shown = unheld.slice(0, 3).join(", ") + (unheld.length > 3 ? ", …" : "");
    return {
      event: "escalate",
      reason: `edited ${shown} under lock ${lock}, which the task does not hold — declare that file in touches`,
    };
  }

  const limit = /** @type {Record<string, {lines: number, files: number}>} */ (config.diffLimits)[task.complexity];
  if (limit) {
    // HAND-WRITTEN CODE only (A-016): tests, docs and generated files tripped the threshold falsely four
    // times in a row — a signal that cries wolf stops being read. The "outside touches" check above
    // still counts every file.
    const code = files.filter((f) => !matchAny(config.diffIgnore, f.path));
    const lines = code.reduce((sum, f) => sum + f.added + f.deleted, 0);
    if (lines > limit.lines || code.length > limit.files) {
      return {
        event: "escalate",
        reason: `hand-written code ${lines} lines / ${code.length} file(s) exceeds the ${task.complexity} limit (${limit.lines}/${limit.files})`,
      };
    }
  }

  const failures = history.failures ?? [];
  const [prev, last] = failures.slice(-2);
  if (failures.length >= 2 && last !== "" && prev === last) {
    return { event: "escalate", reason: "verify failed twice in a row with the same error — change approach, no third try" };
  }

  if (history.running && coreRank(history.running) > coreRank(choosePattern(task).core)) {
    const now = choosePattern(task).core;
    return { event: "simplify", reason: `running ${history.running}, task now only needs ${now}` };
  }

  // Predicted high risk but the actual diff touches no sensitive area → skip security.
  // A human declaring `risk: high` is explicitly asking for scrutiny — never skip.
  if (task.risk === "high" && task.riskDeclared !== "high" && files.length > 0) {
    const actual = inferRisk({ gate: task.gate, title: task.title, touches: files.map((f) => f.path) });
    if (actual !== "high") {
      return { event: "skip-security", reason: `actual diff is only ${actual}, touches no auth/route/upload/money/migration` };
    }
  }

  return null;
}

/**
 * Parse `git diff --numstat`. Binary files report `-` → counted as 0 lines.
 * @param {string} text @returns {DiffStat}
 */
export function parseNumstat(text) {
  const files = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [added, deleted, ...rest] = l.split("\t");
      return { path: rest.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
  return { files };
}
