// @ts-check
/**
 * TIER 1 — state store of the SESSION, not of tasks.
 *
 * A task's `status` lives in the task file itself (see `writeStatus`). This store only
 * keeps three things that can't be derived from repo content: which session is running,
 * how many tasks it has auto-chained, the most recent error. Lose the store and the backlog
 * is still correct — that is the test showing the boundary sits in the right place.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.mjs";
import { assertNext } from "./task.machine.mjs";
import { emitEvent } from "./events.mjs";
import { patchFrontMatter } from "./yaml.mjs";

/**
 * Unfinished work of an interrupted SERIAL-LANE task (A-086): that lane runs directly on the main tree, so the "kept
 * worktree" is the half-edited files on the main tree. `files` = uncommitted paths (`git status --porcelain`) at release time.
 * @typedef {{taskId: string, files: string[], at: string}} SerialLeftover
 */

/**
 * @typedef {Object} Store
 * @property {string|null} sessionId
 * @property {number} chained        number of tasks auto-chained in this session
 * @property {string|null} lastErrorTask
 * @property {string|null} lastError
 * @property {string|null} startedAt
 * @property {string[]} completed   tasks finished IN this session, in order
 * @property {string|null} failTask  task currently red in a row
 * @property {number} failCount      consecutive red count of `failTask` — loop guard
 * @property {SerialLeftover|null} serialLeftover  unfinished work of an interrupted serial-lane task (A-086) — survives sessions
 */

/** @returns {Store} */
function emptyStore() {
  return {
    sessionId: null, chained: 0, lastErrorTask: null, lastError: null,
    startedAt: null, completed: [], failTask: null, failCount: 0, serialLeftover: null,
  };
}

/** @param {string} [file] @returns {Store} */
export function readStore(file = config.storeFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyStore(), ...parsed };
  } catch {
    // No store yet, or a broken one: return defaults. Don't throw — losing the store must not
    // break the session, the store is only auxiliary.
    return emptyStore();
  }
}

/** @param {Store} store @param {string} [file] */
export function writeStore(store, file = config.storeFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write a temp file then rename: a hook killed midway leaves no broken JSON.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Start a session. A new session resets the chaining quota.
 * @param {string} sessionId
 */
export function startSession(sessionId, file = config.storeFile) {
  const store = readStore(file);
  if (store.sessionId === sessionId) return store;
  // `serialLeftover` is unfinished work on the main tree — it survives sessions (A-086); a new session must not drop it.
  const fresh = { ...emptyStore(), sessionId, startedAt: new Date().toISOString(), serialLeftover: store.serialLeftover };
  writeStore(fresh, file);
  return fresh;
}

/** @param {string} [file] @returns {number} number of chained tasks after incrementing */
export function bumpChain(file = config.storeFile) {
  const store = readStore(file);
  const next = { ...store, chained: store.chained + 1 };
  writeStore(next, file);
  return next.chained;
}

/**
 * Record a task just finished in this session.
 *
 * An explicit list, not derived from the `updated` timestamp: the session store may be stale
 * (the previous session never closed), and then a time-based guess wrongly sweeps in another
 * session's work — exactly the bug hit the first time `report` ran on a real repo.
 *
 * @param {string} taskId @param {string} [file]
 */
export function recordCompleted(taskId, file = config.storeFile) {
  const store = readStore(file);
  if (store.completed.includes(taskId)) return;
  writeStore({ ...store, completed: [...store.completed, taskId] }, file);
}

/**
 * Count CONSECUTIVE red verifies on the same task. A different task restarts at 1.
 * This is one of the Stop hook's two loop guards (with `chained`): each time the hook
 * blocks so the agent can fix an error this counter goes up, so the "fix → red → fix" loop is bounded.
 * @param {string} taskId @param {string} [file] @returns {number} count after incrementing
 */
export function recordFailure(taskId, file = config.storeFile) {
  const store = readStore(file);
  const failCount = store.failTask === taskId ? store.failCount + 1 : 1;
  writeStore({ ...store, failTask: taskId, failCount }, file);
  return failCount;
}

/** Task green / dropped → clear the red streak. @param {string} [file] */
export function resetFailures(file = config.storeFile) {
  const store = readStore(file);
  if (store.failTask === null && store.failCount === 0) return;
  writeStore({ ...store, failTask: null, failCount: 0 }, file);
}

/** @param {string} taskId @param {string} detail @param {string} [file] */
export function recordError(taskId, detail, file = config.storeFile) {
  const store = readStore(file);
  writeStore({ ...store, lastErrorTask: taskId, lastError: detail }, file);
}

// ─── Serial-lane unfinished work (A-086) ─────────────────────────────────────

/** Bookkeeping directories the harness itself creates/edits every round — nobody's "unfinished work". */
const BOOKKEEPING_PREFIXES = ["tasks/", "requirements/", "reports/"];

/**
 * PURE FUNCTION. `git status --porcelain -z` → changed paths (the destination path for renames), original order.
 * @param {string} text @returns {string[]}
 */
export function parsePorcelain(text) {
  const parts = text.split("\0");
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i += 1; // the source path follows immediately
  }
  return out;
}

/**
 * PURE FUNCTION. Is the path queue bookkeeping (`tasks/` incl. INBOX/INDEX/task/bug files, `requirements/`,
 * `reports/`). Release/claim/planner write here every round, so it doesn't count as a "dirty" main tree.
 * @param {string} file @returns {boolean}
 */
export function isBookkeepingPath(file) {
  return BOOKKEEPING_PREFIXES.some((p) => file.startsWith(p));
}

/**
 * Uncommitted paths on the main tree `root` (including new untracked files), minus queue bookkeeping, sorted.
 * Not a git repo / git error → [] (the guard is skipped rather than blocking by mistake).
 * @param {string} root @returns {string[]}
 */
export function readDirtyTree(root) {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(parsePorcelain(out).filter((f) => !isBookkeepingPath(f)))].sort();
  } catch {
    return [];
  }
}

/** @param {string} [file] @returns {SerialLeftover|null} */
export function readSerialLeftover(file = config.storeFile) {
  const v = readStore(file).serialLeftover;
  return v && typeof v.taskId === "string" && Array.isArray(v.files) ? v : null;
}

/**
 * Record the unfinished work of a serial-lane task just released. Empty `files` → nothing to keep, clear any old record.
 * @param {string} taskId @param {string[]} files @param {string} [file] @param {Date} [now]
 */
export function recordSerialLeftover(taskId, files, file = config.storeFile, now = new Date()) {
  const store = readStore(file);
  writeStore({ ...store, serialLeftover: files.length === 0 ? null : { taskId, files, at: now.toISOString() } }, file);
}

/**
 * Clear the unfinished-work record. With `taskId`, only clear it if the record belongs to that task (another task's commit must not clear someone else's work).
 * @param {string} [file] @param {string} [taskId]
 */
export function clearSerialLeftover(file = config.storeFile, taskId) {
  const store = readStore(file);
  if (store.serialLeftover === null || (taskId !== undefined && store.serialLeftover.taskId !== taskId)) return;
  writeStore({ ...store, serialLeftover: null }, file);
}

/**
 * PURE FUNCTION. Does the unfinished work on the main tree still have an owner: the record points at a task still
 * `todo`/`doing`, and the main tree still has uncommitted changes. Clean tree (a human dealt with it) or task changed
 * state/deleted → no owner.
 * @param {SerialLeftover|null} leftover @param {string[]} dirty @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @returns {import("./backlog.mjs").Task|null}
 */
export function leftoverOwner(leftover, dirty, backlog) {
  if (leftover === null || dirty.length === 0) return null;
  const task = backlog.get(leftover.taskId);
  return task && (task.status === "todo" || task.status === "doing") ? task : null;
}

/**
 * PURE FUNCTION. Uncommitted changes on the main tree that belong to NO task: dirty tree, no owner per the record, and
 * no task currently holding the main tree (`held`). Empty = the serial lane opens normally.
 * @param {{dirty: string[], leftover: SerialLeftover|null, backlog: Map<string, import("./backlog.mjs").Task>, held: boolean}} input
 * @returns {string[]}
 */
export function unownedChanges({ dirty, leftover, backlog, held }) {
  if (dirty.length === 0 || held) return [];
  return leftoverOwner(leftover, dirty, backlog) === null ? dirty : [];
}

/** At most this many paths in a stop reason / INBOX. */
export const MAX_SHOWN_PATHS = 5;

/**
 * Write the new status into THE TASK FILE ITSELF — it is the source of truth.
 * Goes through the state machine, so nothing can write arbitrary values.
 *
 * @param {import("./backlog.mjs").Task} task
 * @param {string} event
 * @param {{owner?: string|null}} [patch]
 * @returns {string} the new status
 */
export function applyEvent(task, event, patch = {}) {
  const to = assertNext(task.status, event);
  const content = fs.readFileSync(task.file, "utf8");
  const updated = patchFrontMatter(
    content,
    {
      status: to,
      updated: new Date().toISOString(),
      ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
    },
    task.file
  );
  fs.writeFileSync(task.file, updated);
  // ONE emit point for every status-change path: Stop hook, CLI, conductor, planner. The repo root is derived from the
  // task file (`<root>/tasks/<id>.md`), not cwd — a worktree or unusual cwd still writes to the ledger of the task's repo.
  emitEvent(path.dirname(path.dirname(path.resolve(task.file))), "task.transition", {
    taskId: task.id, from: task.status, to, event,
  });
  return to;
}
