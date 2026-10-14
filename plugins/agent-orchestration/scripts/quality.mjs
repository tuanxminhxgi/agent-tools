// @ts-check
/**
 * AGENT QUALITY — `usage` answers "how much did it cost", this file answers "was the work GOOD": change a prompt in
 * `.claude/agents/*.md`, a model in the `roles` table or a pattern, and compare before/after with numbers, not gut feeling.
 *
 * The unit is the TASK (not the agent): a task with at least one `verify.result` in the read window. Each task carries
 *   - `verifyRuns`  number of verify runs; `firstPass` the FIRST run was green — the developer got it right, no fix round;
 *   - `outcome`     final status per `task.transition` (done · needs-human · failed · todo …);
 *   - `findings`    total `count` of `finding` events (raised by reviewers/QA);
 *   - `bugs`        number of `B-*` bugs whose parent is the task (bug files on disk + `B-*` ids seen in the ledger);
 *   - `model`/`role` of the FIRST developer on the task — the one responsible for the first verify run;
 *   - `pattern`     the task's last `pattern.chosen`;
 *   - `costUsd`     total "equivalent" cost of every agent attached to the task.
 * Then grouped by model, developer role and pattern.
 *
 * PURE FUNCTIONS: no fs, no `Date.now()`. The CLI (`task quality`) reads the ledger + bugs, calls, prints.
 * `verify.result` is emitted only by the conductor (A-041) — Stop-hook chains in interactive sessions are not measured.
 */

/** @typedef {import("./events.mjs").AgentEvent} AgentEvent */
/** @typedef {import("./dashboard.mjs").AgentRow} AgentRow */

/** Groups with fewer tasks than this are flagged "few samples" by the CLI — a rate over 2–3 tasks says nothing. */
export const MIN_SAMPLES = 5;
const UNKNOWN = "(unknown)";
/** `B-T046-1` → parent `T-046` (same bug file name pattern as backlog.mjs). */
const BUG_ID = /^B-([A-Z])(\d{3})-\d+$/;

/**
 * @typedef {object} TaskQuality
 * @property {string} taskId
 * @property {string|null} model    model of the first developer on the task
 * @property {string|null} role     that developer's role
 * @property {string|null} pattern  last `pattern.chosen`
 * @property {number} verifyRuns
 * @property {boolean} firstPass    first verify run green
 * @property {boolean} passed       at least one green verify run
 * @property {string|null} outcome  `to` of the last `task.transition`; null when the ledger has none
 * @property {number} findings
 * @property {number} bugs
 * @property {number|null} costUsd  null when no agent of the task has a cost
 * @property {"fresh"|"chained"} session  the task's FIRST developer session: fresh, or chained from the previous task (resumeKind "chain")
 * @property {"none"|"resumed"|"fresh"} retry  none: verify green on the first run · resumed: some rerun resumed the session
 *   (resumeKind "retry") · fresh: verify went red but every rerun opened a new session
 */

/**
 * @typedef {object} QualityBucket
 * @property {number} tasks
 * @property {number} firstPass      tasks green on the first verify run
 * @property {number} firstPassRate  0..1
 * @property {number} verifyRuns     total verify runs
 * @property {number} avgVerifyRuns  average verify runs per task (1 = no fix rounds)
 * @property {number} failed         tasks ending in `failed`
 * @property {number} failedRate     0..1
 * @property {number} findings
 * @property {number} bugs
 * @property {number|null} medianCostUsd  median cost per task (only tasks with a cost)
 */

/** @param {number[]} xs @returns {number|null} */
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** @param {AgentEvent} a @param {AgentEvent} b */
const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

/** @param {string} id @returns {string|null} parent task id of a bug, null if not a bug id */
export function bugParent(id) {
  const m = BUG_ID.exec(id);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * One quality row per task with a `verify.result`. Bugs (`B-*`) are not a unit — they are counted into the parent.
 * Ledger line order is not trusted: every "first/last" sorts by `ts`.
 * @param {AgentEvent[]} events
 * @param {AgentRow[]} agents  `foldAgents(events, …)`
 * @param {{isDeveloper: (role: string) => boolean, bugs?: {id: string, parent: string}[]}} opts
 * @returns {TaskQuality[]} sorted by taskId
 */
export function taskQuality(events, agents, { isDeveloper, bugs = [] }) {
  const sorted = [...events].sort(byTs);

  /** @type {Map<string, boolean[]>} */
  const verifies = new Map();
  /** @type {Map<string, string>} */
  const outcome = new Map();
  /** @type {Map<string, string>} */
  const pattern = new Map();
  /** @type {Map<string, number>} */
  const findings = new Map();
  /** @type {Map<string, Set<string>>} */
  const bugIds = new Map();
  /** @param {string} id @param {string} parent */
  const addBug = (id, parent) => bugIds.set(parent, (bugIds.get(parent) ?? new Set()).add(id));
  for (const b of bugs) addBug(b.id, b.parent);

  for (const e of sorted) {
    const id = e.taskId;
    if (typeof id !== "string" || id === "") continue;
    const parent = bugParent(id);
    if (parent !== null) {
      addBug(id, parent);
      continue;
    }
    if (e.type === "verify.result" && typeof e.ok === "boolean") verifies.set(id, [...(verifies.get(id) ?? []), e.ok]);
    else if (e.type === "task.transition" && typeof e.to === "string") outcome.set(id, e.to);
    else if (e.type === "pattern.chosen" && typeof e.pattern === "string") pattern.set(id, e.pattern);
    else if (e.type === "finding") findings.set(id, (findings.get(id) ?? 0) + (typeof e.count === "number" && e.count > 0 ? e.count : 0));
  }

  /** @type {Map<string, AgentRow>} first developer of each task */
  const firstDev = new Map();
  /** @type {Map<string, number>} */
  const cost = new Map();
  /** @type {Set<string>} tasks with a developer rerun that RESUMED the session (A-053) */
  const retryResumed = new Set();
  for (const a of [...agents].sort((x, y) => (x.startedAt ?? "").localeCompare(y.startedAt ?? ""))) {
    if (a.taskId === null) continue;
    if (a.costUsd !== null) cost.set(a.taskId, (cost.get(a.taskId) ?? 0) + a.costUsd);
    if (a.role === null || !isDeveloper(a.role)) continue;
    if (!firstDev.has(a.taskId)) firstDev.set(a.taskId, a);
    if (a.resumeKind === "retry") retryResumed.add(a.taskId);
  }

  return [...verifies.keys()].sort().map((taskId) => {
    const runs = /** @type {boolean[]} */ (verifies.get(taskId));
    const dev = firstDev.get(taskId);
    const c = cost.get(taskId);
    return {
      taskId,
      model: dev?.model ?? null,
      role: dev?.role ?? null,
      pattern: pattern.get(taskId) ?? null,
      verifyRuns: runs.length,
      firstPass: runs[0] === true,
      passed: runs.includes(true),
      outcome: outcome.get(taskId) ?? null,
      findings: findings.get(taskId) ?? 0,
      bugs: bugIds.get(taskId)?.size ?? 0,
      costUsd: c === undefined ? null : Math.round(c * 1e6) / 1e6,
      session: dev?.resumeKind === "chain" ? "chained" : "fresh",
      retry: runs[0] === true ? "none" : retryResumed.has(taskId) ? "resumed" : "fresh",
    };
  });
}

/** @param {TaskQuality[]} rows @returns {QualityBucket} */
export function bucket(rows) {
  const tasks = rows.length;
  const firstPass = rows.filter((r) => r.firstPass).length;
  const verifyRuns = rows.reduce((s, r) => s + r.verifyRuns, 0);
  const failed = rows.filter((r) => r.outcome === "failed").length;
  const ratio = (/** @type {number} */ n) => (tasks === 0 ? 0 : Math.round((n / tasks) * 1000) / 1000);
  return {
    tasks,
    firstPass,
    firstPassRate: ratio(firstPass),
    verifyRuns,
    avgVerifyRuns: tasks === 0 ? 0 : Math.round((verifyRuns / tasks) * 100) / 100,
    failed,
    failedRate: ratio(failed),
    findings: rows.reduce((s, r) => s + r.findings, 0),
    bugs: rows.reduce((s, r) => s + r.bugs, 0),
    medianCostUsd: median(rows.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))),
  };
}

/**
 * @param {TaskQuality[]} rows @param {(r: TaskQuality) => string|null} key
 * @returns {Record<string, QualityBucket>}
 */
function groupBy(rows, key) {
  /** @type {Map<string, TaskQuality[]>} */
  const m = new Map();
  for (const r of rows) {
    const k = key(r) ?? UNKNOWN;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k, xs]) => [k, bucket(xs)]));
}

/**
 * Total + grouped by model, developer role, pattern, developer session mode (A-083) and rerun mode after a red verify.
 * Events before A-083 have no `resumeKind`: a run with `resumedFrom` reads as `chain`; A-053 resumed reruns
 * left no trace → counted as `fresh`. `worst`: up to 5 tasks with the most verify runs (> 1)
 * or ending in `failed` — where to read logs first.
 * @param {TaskQuality[]} rows
 */
export function qualityBy(rows) {
  const worst = rows
    .filter((r) => r.verifyRuns > 1 || r.outcome === "failed")
    .sort((a, b) => Number(b.outcome === "failed") - Number(a.outcome === "failed") || b.verifyRuns - a.verifyRuns || a.taskId.localeCompare(b.taskId))
    .slice(0, 5);
  return {
    total: bucket(rows),
    byModel: groupBy(rows, (r) => r.model),
    byRole: groupBy(rows, (r) => r.role),
    byPattern: groupBy(rows, (r) => r.pattern),
    bySession: groupBy(rows, (r) => r.session),
    byRetry: groupBy(rows, (r) => r.retry),
    worst,
  };
}
