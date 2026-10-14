// @ts-check
/**
 * LAYER 3 (decisions) — the lane scheduler. Design: docs/agent-orchestration.md §3.
 *
 * Nobody labels tasks "parallelisable": the machine INFERS it from `touches` and `locks`.
 *   - A task holding an exclusive lock → SERIAL lane, one task at a time, in the main worktree.
 *   - Other tasks → PARALLEL lane, up to `workers` tasks, one worktree each (A-011).
 *   - Two tasks running at the same time (whatever the lane) never have overlapping `touches`.
 *
 * Pure function: takes the backlog + the running list, returns a decision. Creates no
 * worktree, changes no status — that is A-011's and the conductor's (A-014) job.
 */
import { readyQueue, rank } from "./backlog.mjs";
import { anyOverlap, touchHoldsLock } from "./glob.mjs";
import { config } from "./config.mjs";

/** A-052's pseudo-lock: task risk ≥ `sessionChain.minRiskForSerial` → serial lane. */
export const SESSION_CHAIN_LOCK = "session-chain";

/**
 * A task's locks: declared + inferred from `touches` via `config.lockRules` + `money`
 * from the gate. Deduplicated, deterministic order.
 * @param {import("./backlog.mjs").Task} task
 * @param {Record<string, string[]>} [rules]
 * @returns {string[]}
 */
export function inferLocks(task, rules = config.lockRules, resources = config.resources) {
  const locks = new Set(task.locks);
  for (const [lock, globs] of Object.entries(rules)) {
    // A-080: asks "does the task DECLARE it edits this kind of file", not "could they share a file".
    // A-082: a glob starting with `!` excludes — e.g. a data-only migration doesn't change the schema, so it doesn't hold the schema lock.
    if (task.touches.some((t) => touchHoldsLock(t, globs))) locks.add(lock);
  }
  // A `serial: true` resource cannot run in a worker's worktree (e.g. an e2e stack whose bundler rejects a
  // node_modules symlink pointing outside the worktree, T-235 2026-09-27) → treated as a lock, task goes serial.
  for (const name of inferResources(task, resources)) if (resources[name]?.serial === true) locks.add(name);
  if (task.gate === "money") locks.add("money");
  // A-052: a task with risk ≥ threshold runs only in the serial lane — only there (main worktree, one directory) can
  // the developer session be resumed from this task into the next. Treated as a lock so every existing lane rule applies as is.
  const chain = config.sessionChain;
  if (chain.enabled && rank(task.risk) >= rank(chain.minRiskForSerial)) locks.add(SESSION_CHAIN_LOCK);
  return [...locks].sort();
}

/**
 * COUNTABLE resources a task holds, inferred from its `verify:` commands (A-019). Unlike locks they
 * don't change the lane, they only cap how many tasks hold them at once. PURE FUNCTION, deterministic order.
 * @param {import("./backlog.mjs").Task} task
 * @param {Record<string, {verify: string[], limit: number, serial?: boolean}>} [resources]
 * @returns {string[]}
 */
export function inferResources(task, resources = config.resources) {
  return Object.entries(resources)
    .filter(([, r]) => task.verify.some((cmd) => r.verify.some((re) => new RegExp(re, "i").test(cmd))))
    .map(([name]) => name)
    .sort();
}

/**
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @param {import("./backlog.mjs").Task[]} running  tasks running in either lane
 * @param {{workers?: number, critical?: string[], rules?: Record<string, string[]>,
 *          resources?: Record<string, {verify: string[], limit: number, serial?: boolean}>}} [options]
 * @returns {{serial: import("./backlog.mjs").Task|null, parallel: import("./backlog.mjs").Task[]}}
 */
export function schedule(backlog, running, options = {}) {
  const workers = options.workers ?? config.workers;
  const rules = options.rules ?? config.lockRules;
  const runningIds = new Set(running.map((t) => t.id));
  const ready = readyQueue(backlog, options.critical ?? []).filter((t) => !runningIds.has(t.id));

  const resources = options.resources ?? config.resources;

  /** @type {import("./backlog.mjs").Task[]} */
  const taken = [];
  /** Number of tasks holding each resource — both lanes, including running tasks. */
  /** @type {Map<string, number>} */
  const held = new Map();
  const take = (/** @type {import("./backlog.mjs").Task} */ t) => {
    taken.push(t);
    for (const r of inferResources(t, resources)) held.set(r, (held.get(r) ?? 0) + 1);
  };
  for (const t of running) take(t);
  const clashes = (/** @type {import("./backlog.mjs").Task} */ t) =>
    taken.some((o) => anyOverlap(t.touches, o.touches)) ||
    inferResources(t, resources).some((r) => (held.get(r) ?? 0) >= resources[r].limit);

  const serialBusy = running.some((t) => inferLocks(t, rules, resources).length > 0);
  let serial = null;
  if (!serialBusy) {
    serial = ready.find((t) => inferLocks(t, rules, resources).length > 0 && !clashes(t)) ?? null;
    if (serial) take(serial);
  }

  const busyWorkers = running.filter((t) => inferLocks(t, rules, resources).length === 0).length;
  /** @type {import("./backlog.mjs").Task[]} */
  const parallel = [];
  for (const t of ready) {
    if (busyWorkers + parallel.length >= workers) break;
    if (t === serial || inferLocks(t, rules, resources).length > 0 || clashes(t)) continue;
    parallel.push(t);
    take(t);
  }
  return { serial, parallel };
}
