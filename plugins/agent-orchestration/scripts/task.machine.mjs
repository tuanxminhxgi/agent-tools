// @ts-check
/**
 * LAYER 1 — a task's state machine. Data table, PURE functions: no file reads,
 * no commands, no `Date.now()`.
 *
 * `blocked` is NOT in the table because it is derived from `deps` (see `isBlocked`);
 * storing it in the file would only add something to keep in sync.
 *
 * `done` is terminal, with no way out: a finished task that needs changes gets a
 * new task — the same principle as an append-only ledger.
 */

/** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */
export const TRANSITIONS = Object.freeze({
  // Planner (docs/agent-orchestration.md §4) — only the planner emits ready/ask/answered.
  draft: { ready: "todo", ask: "needs-decision" },
  "needs-decision": { answered: "draft" },
  todo: { claim: "doing" },
  doing: {
    pass: "done",           // every verify command green — ONLY Layer 2 emits this
    fail: "failed",         // a command failed
    gate: "needs-human",    // money / migration / needs a visual check
    release: "todo",        // session ended, abandoned
    "bug-found": "waiting-bugs", // an evaluator filed a bug — parent task waits, no merge
    escalate: "draft",      // reality bigger than the analysis — back to the planner
  },
  // all bugs `fixed` → QA re-runs; open-bug cap exceeded (A-013) → wait for a human.
  "waiting-bugs": { retest: "doing", gate: "needs-human" },
  failed: { retry: "doing", release: "todo" },
  "needs-human": { approve: "doing", release: "todo" },
  done: {},
});

/**
 * A BUG's state machine — a separate table because bugs never pass through `todo`/`done`
 * and never mix into the task queue. Design §6.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const BUG_TRANSITIONS = Object.freeze({
  open: { assign: "fixing" },       // conductor assigns a fixer
  fixing: {
    pass: "fixed",                  // repro test green + parent verify green — ONLY the verifier
    fail: "open",                   // attempts remain
    exhaust: "needs-human",         // out of attempts
  },
  "needs-human": { reopen: "open" },
  fixed: {},
});

export class InvalidTransitionError extends Error {
  /** @param {string} from @param {string} event */
  constructor(from, event) {
    super(`Cannot transition task from \`${from}\` with event \`${event}\``);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.event = event;
  }
}

/** @typedef {Readonly<Record<string, Readonly<Record<string, string>>>>} Table */

/**
 * Every function below takes an optional table — the TASK table by default, pass
 * `BUG_TRANSITIONS` for bugs. One set of functions, two tables, no duplicated logic.
 * @param {string} from @param {string} event @param {Table} [table]
 * @returns {string|undefined}
 */
export function nextState(from, event, table = TRANSITIONS) {
  return table[from]?.[event];
}

/** @param {string} from @param {string} event @param {Table} [table] @returns {boolean} */
export function can(from, event, table = TRANSITIONS) {
  return nextState(from, event, table) !== undefined;
}

/** @param {string} from @param {string} event @param {Table} [table] @returns {string} */
export function assertNext(from, event, table = TRANSITIONS) {
  const to = nextState(from, event, table);
  if (to === undefined) throw new InvalidTransitionError(from, event);
  return to;
}

/** @param {string} state @param {Table} [table] @returns {boolean} */
export function isTerminal(state, table = TRANSITIONS) {
  return Object.keys(table[state] ?? {}).length === 0;
}

/** @param {string} from @param {Table} [table] @returns {string[]} */
export function eventsFrom(from, table = TRANSITIONS) {
  return Object.keys(table[from] ?? {});
}
