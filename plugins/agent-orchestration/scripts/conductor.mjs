// @ts-check
/**
 * CONDUCTOR (A-014, A-023) — one command runs the whole system: `npm run conductor`.
 * Design: docs/agent-orchestration.md. The conductor is CODE, not an LLM.
 *
 * Each round: `tick(state)` (PURE FUNCTION) returns a list of actions; `execute` carries them out via `io`
 * (injectable — tests use a fake, no real Claude session). Loops until `tick` returns `stop`.
 *
 * Parallelism is DECIDED in `tick` (A-023): ≤ 1 serial-lane task + ≤ `workers` parallel-lane tasks
 * (slots 1..N), role chain per `roleChain` one role at a time, one `integrate` at a time per `mergeOrder`.
 * EXECUTION (A-025, `conductor-exec.mjs`): `io.parallel` (the async executor) runs each parallel task
 * on its own worktree — `claude -p` per role, serial merges, push after each merge. The loop interleaves
 * `recover` (A-024) + `tick` whenever a process finishes. Without `io.parallel` (fake io in tests) it
 * runs the A-014 serial version: one `spawn-worker` per round on the main worktree.
 *
 * `claude -p` sessions opened by the conductor ALWAYS run with `AGENT_QUEUE_DISABLE=1`: otherwise the
 * project's Stop hook in the child session would verify and chain tasks itself — fighting the conductor for control.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readyQueue, missingDeps, sectionOrNull, loadBacklog, loadBugs, loadQuestions, criticalPath, rank } from "./backlog.mjs";
import { gateBeforeStart } from "./gates.mjs";
import { choosePattern } from "./pattern.mjs";
import { contextPackFile, roleChain, rolePrompt, modelFor, reviewerGate } from "./roles.mjs";
import { nextWork, loadRequirements, syncPlanner } from "./planner.mjs";
import { nextBug, parentEvents, fixerPrompt, fixVerdict } from "./bugs.mjs";
import { schedule, inferLocks } from "./schedule.mjs";
import { freeSlots, slotOfOwner, listWorktrees, orphanWorktrees, runGit } from "./worker.mjs";
import { mergeOrder, integrateAsync, cliPathFor } from "./integrator.mjs";
import {
  CONDUCTOR_OWNER, claudeArgs, createExecutor, realSpawn, readAgentTools, readWorkerEnv, moveNewBugs, siblingPath,
  agentKind, patternFields, redact, failureFingerprint, readGateFiles,
} from "./conductor-exec.mjs";
import { runClaude } from "./claude-run.mjs";
import { writeCompactFile } from "./compact.mjs";
import { foldAgents } from "./dashboard.mjs";
import { appendEvent, emitEvent, ledgerFile, makeEvent, newId, readEvents, MAX_CHECK_CMD_CHARS, MAX_FAIL_TAIL_LINES } from "./events.mjs";
import { config } from "./config.mjs";
import { verifyTask } from "./verify.mjs";
import {
  applyEvent, readDirtyTree, readSerialLeftover, recordSerialLeftover, clearSerialLeftover, leftoverOwner, unownedChanges, MAX_SHOWN_PATHS,
} from "./store.mjs";
import { patchFrontMatter } from "./yaml.mjs";
import { commitTask } from "./commit.mjs";
import { inboxCounts, writeInbox } from "./inbox.mjs";
import { ciClosedStopReason, ciGateNow, ciWarning, readCiStatus } from "./ci-status.mjs";
import { recordFindings, parseFindings, shouldRetryReviewer, reviewerRetryTail, MAX_REVIEWER_CALLS } from "./findings.mjs";

export { CONDUCTOR_OWNER };

/**
 * Work paths the task changed in `cwd`: tracked files differing from the base + new untracked files.
 * Base: main worktree → `HEAD` (the serial lane has committed nothing yet); worker worktree → fork point from the
 * main worktree's branch (including `wip` commits). Stages nothing. Git error → null (gate skipped, no false block).
 * The serial lane sees every change on the main tree; `tick` does not open it while the tree is dirty with no known owner (A-086), so all of it belongs to the task.
 * @param {string} root @param {string} cwd @returns {string[]|null}
 */
export function changedPaths(root, cwd) {
  let base = "HEAD";
  if (path.resolve(cwd) !== path.resolve(root)) {
    const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const mb = branch.ok ? runGit(cwd, ["merge-base", branch.out, "HEAD"]) : branch;
    if (!mb.ok) return null;
    base = mb.out;
  }
  const tracked = runGit(cwd, ["diff", "--name-only", base]);
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!tracked.ok || !untracked.ok) return null;
  return [...tracked.out.split("\n"), ...untracked.out.split("\n")].filter((f) => f !== "");
}

/**
 * @typedef {import("./backlog.mjs").Task} Task
 * @typedef {import("./backlog.mjs").Bug} Bug
 * @typedef {import("./roles.mjs").ChainStep} ChainStep
 * @typedef {"serial"|"parallel"} Lane
 * @typedef {{id: string, lane: Lane, slot: number|null,
 *            phase: "developing"|"reviewing"|"verifying"|"ready-to-merge"|"integrating",
 *            rolesDone: string[], activeRole?: string|null, verifiedHead?: string|null}} Running
 *   A task the conductor holds. `developing`: first role running · `reviewing`: first role done, later roles
 *   of `roleChain` are being called one at a time — except post-verify reviewers, which run together in one turn
 *   (`parallelWith`) (`rolesDone` = finished roles, `activeRole` = running role, a reviewer group is written `a + b`,
 *   null = between two roles) · `verifying` (A-089): the before-stage is done, the `verify:` commands are running BEFORE
 *   reviewers open · `ready-to-merge`: all roles done · `integrating`: merging.
 *   `verifiedHead`: SHA of branch `agent/<id>` when the pre-review verify went green (serial lane: the `SERIAL_VERIFIED` marker of conductor-exec.mjs);
 *   null/missing = not verified. Lives only in the memory of this conductor run — a restart verifies again.
 *   `slot` is null on the serial lane (main worktree).
 * @typedef {{type: "task-event", id: string, event: "bug-found"|"retest"|"gate", reason: string}
 *   | {type: "spawn-fixer", bugId: string, parentId: string, reason: string}
 *   | {type: "spawn-planner", work: string, model: string, reason: string}
 *   | {type: "spawn-worker", id: string, lane: Lane, slot: number|null, role: string, model: string,
 *      chain: ChainStep[], retry: boolean, reuseWorktree: boolean, reason: string, resume?: Resume|null,
 *      compactSummary?: CompactFrom|null}
 *   | {type: "spawn-role", id: string, role: string, model: string, reason: string, resume?: Resume|null,
 *      parallelWith?: {role: string, reason: string}[]}
 *   | {type: "verify-task", id: string, slot: number|null, reason: string}
 *   | {type: "integrate", id: string, slot: number|null, reason: string}
 *   | {type: "adopt", id: string, slot: number, reason: string}
 *   | {type: "release", id: string, reason: string}
 *   | {type: "kill", id: string, reason: string}
 *   | {type: "report-orphan", id: string, reason: string}
 *   | {type: "wait", id: string|null, reason: string}
 *   | {type: "write-inbox", reason: string}
 *   | {type: "stop", reason: string}} Action  every action carries a `reason`
 * @typedef {Object} State
 * @property {Map<string, Task>} backlog
 * @property {Running[]} running
 * @property {Bug[]} bugs
 * @property {boolean} plannerRunning
 * @property {string|null} plannerWork  what the planner is working on (if any) — for explanations only
 * @property {number} workers           number of parallel-lane slots
 * @property {string[]} worktrees       ids of worker worktrees on disk — so a rescheduled task reuses its old worktree
 * @property {import("./planner.mjs").Requirement[]} requirements
 * @property {Map<string, import("./backlog.mjs").Question>} questions
 * @property {string[]} critical
 * @property {ChainLink|null} [sessionChain]  last developer session of the serial lane (A-052), built from the event ledger
 * @property {number} [now]  timestamp (ms) for `chainDecision` — `tick` is pure so it never reads the clock; missing →
 *   the idle-gap rule is skipped
 * @property {import("./store.mjs").SerialLeftover|null} [serialLeftover]  unfinished work of an interrupted serial-lane task (A-086);
 *   the outer layer has already dropped the record if the main tree is clean
 * @property {string[]} [dirtyTree]  uncommitted paths on the main tree, queue bookkeeping excluded (A-086); missing = clean
 * @property {{reason: string}|null} [ciClosed]  CI gate closed (A-084), filled by the outer layer each round: `tick` emits no
 *   `spawn-planner` and no `spawn-worker` for a NEW task; running work (next role, merge, retry, fixer) runs to the end. `reason`
 *   is the verbatim `stopReason` once nothing is running. Missing/null = open
 */

/**
 * Last link of the session chain (A-052): the most recent developer session on the serial lane (main worktree).
 * `verified`: that task's verify.result AFTER the session — true green · false red · null not verified.
 * @typedef {{taskId: string, agentId: string, sessionId: string, role: string, peakContext: number|null,
 *            endedAtMs: number, exitOk: boolean, verified: boolean|null}} ChainLink
 * @typedef {{sessionId: string, fromAgentId: string, fromTaskId: string}} Resume  session to `--resume`
 * @typedef {{sessionId: string, fromAgentId: string, fromTaskId: string, role: string, before: number}} CompactFrom
 *   a session too large: needs one summarise-to-file turn BEFORE the next task opens a fresh session (A-055)
 */

/**
 * PURE FUNCTION (A-052). Last link of the session chain from the event ledger: the last `agent.end` of a developer role
 * on the serial lane (`slot` null) with a `sessionId`, plus that task's latest `verify.result` written AFTER it. Built from
 * the ledger (not held in memory) so the chain survives a conductor restart, and `--dry-run` sees it too.
 * @param {import("./events.mjs").AgentEvent[]} events
 * @param {(role: string) => boolean} isDeveloper
 * @returns {ChainLink|null}
 */
export function chainLinkFromEvents(events, isDeveloper) {
  /** @type {ChainLink|null} */
  let link = null;
  let linkTs = "";
  for (const e of events) {
    if (e.type !== "agent.end" || e.slot != null || typeof e.sessionId !== "string" || e.sessionId === "") continue;
    if (typeof e.role !== "string" || !isDeveloper(e.role) || typeof e.taskId !== "string" || typeof e.agentId !== "string") continue;
    if (e.ts < linkTs) continue;
    linkTs = e.ts;
    link = {
      taskId: e.taskId, agentId: e.agentId, sessionId: e.sessionId, role: e.role,
      peakContext: typeof e.peakContext === "number" ? e.peakContext : null,
      endedAtMs: Date.parse(e.ts), exitOk: e.exitCode === 0, verified: null,
    };
  }
  if (link === null) return null;
  let verifyTs = "";
  for (const e of events) {
    if (e.type !== "verify.result" || e.taskId !== link.taskId || e.ts < linkTs || e.ts < verifyTs) continue;
    verifyTs = e.ts;
    link.verified = e.ok === true;
  }
  return link;
}

/**
 * PURE FUNCTION (A-052). Whether the developer of `task` (step `role`, on `lane`) resumes session `prev` or opens a fresh one — with the reason.
 * Fresh when: chaining disabled · parallel lane (one worktree per task, sessions are stored per directory) · no previous session ·
 * previous session exited with an error (worker died/timed out) · previous task not verified green · low-risk task in a different
 * `context:` group · previous session larger than `maxContext` · idle longer than `maxGapMs` (cache gone cold). Same task (second
 * developer role of the chain) → no verify required — the task is still in progress.
 * @param {{prev: ChainLink|null, task: Task, lane: Lane, now: number|null, prevContext?: string|null,
 *          cfg?: import("./project-config.mjs").SessionChain}} input
 * A-055: previous task green, cache still warm but the session is over `maxContext` → do not resume verbatim; return
 * `compact` (one summarise-to-file turn on that same session, then the next task opens a fresh session with the summary).
 * Cache already cold → open fresh directly — summarising then would re-write the whole large context, expensive.
 * @returns {{resume: Resume, reason: string, compact?: undefined} | {resume: null, reason: string, compact?: CompactFrom}}
 */
export function chainDecision({ prev, task, lane, now, prevContext = null, cfg = config.sessionChain }) {
  const fresh = (/** @type {string} */ reason) => ({ resume: null, reason: `fresh session: ${reason}` });
  if (!cfg.enabled) return fresh("session chaining disabled");
  if (lane !== "serial") return fresh("parallel lane — one worktree per task, sessions do not carry across directories");
  if (prev === null) return fresh("no previous developer session on the serial lane");
  if (!prev.exitOk) return fresh(`previous session (${prev.taskId}) exited with an error`);
  const sameTask = prev.taskId === task.id;
  if (!sameTask && prev.verified !== true) {
    return fresh(`${prev.taskId} ${prev.verified === false ? "verify red" : "not verified"}`);
  }
  if (!sameTask && rank(task.risk) < rank(cfg.minRiskForSerial) && (task.context === null || task.context !== prevContext)) {
    return fresh(`${task.risk} task in a different context group from ${prev.taskId}`);
  }
  const gap = now === null ? 0 : now - prev.endedAtMs;
  if (gap > cfg.maxGapMs) return fresh(`idle ${Math.round(gap / 60_000)} min > ${Math.round(cfg.maxGapMs / 60_000)} min — cache gone cold`);
  if (prev.peakContext !== null && prev.peakContext > cfg.maxContext) {
    if (sameTask) return fresh(`previous session context ${prev.peakContext} > ${cfg.maxContext}`);
    return {
      resume: null,
      compact: { sessionId: prev.sessionId, fromAgentId: prev.agentId, fromTaskId: prev.taskId, role: prev.role, before: prev.peakContext },
      reason: `compact session ${prev.sessionId} of ${prev.taskId} (context ${prev.peakContext} > ${cfg.maxContext}) → fresh session + summary`,
    };
  }
  return {
    resume: { sessionId: prev.sessionId, fromAgentId: prev.agentId, fromTaskId: prev.taskId },
    reason: `resume session ${prev.sessionId} of ${prev.taskId}${prev.peakContext === null ? "" : ` (context ${prev.peakContext})`}`,
  };
}

/**
 * Role chain of a task, without `fixer` (fixers run on their own per-bug lane). No role outside `roleChain`.
 * @param {Task} task @param {Bug[]} bugs
 * @returns {{choice: import("./pattern.mjs").PatternChoice, chain: ChainStep[]}}
 */
function chainFor(task, bugs) {
  const choice = choosePattern(task);
  const openBugs = bugs.some((b) => b.parent === task.id && b.status !== "fixed");
  return { choice, chain: roleChain(choice, task, undefined, { openBugs }).filter((s) => s.kind !== "fixer") };
}

/**
 * PURE FUNCTION (A-089). Split the role chain around the verify turn: BEFORE stage = every developer and evaluator `kind`
 * step (in `roleChain` order — QA's tests must be inside the verify turn); AFTER stage = every reviewer `kind` step (read-only,
 * never blocks merging). Fixer belongs to neither — the bug path is separate.
 * @param {ChainStep[]} chain @returns {{before: ChainStep[], after: ChainStep[]}}
 */
export function splitChain(chain) {
  return {
    before: chain.filter((s) => s.kind === "developer" || s.kind === "evaluator"),
    after: chain.filter((s) => s.kind === "reviewer"),
  };
}

/** @param {string|null} id @param {string} reason @returns {Action} */
const wait =(id, reason) => ({ type: "wait", id, reason });

/**
 * ONE decision round. PURE FUNCTION, deterministic — no LLM, no file reads, no state changes.
 *   1. parent tasks change status from their bugs (bug-found / retest / gate) — done first, the next round recomputes;
 *   2. fixer lane: the next bug of a parent task in `waiting-bugs`;
 *   3. planner lane: ≤ 1 planner, an unsplit requirement / a draft task needing a rewrite;
 *   4. running tasks: the next role per `roleChain` (one role at a time) → once all roles are done, ONE `integrate`
 *      at a time per `mergeOrder`, never integrating a task with open bugs;
 *   5. new tasks: `schedule()` picks ≤ 1 serial lane + ≤ `workers` parallel lanes, lowest slot first
 *      via `freeSlots`. Tasks behind a before-start gate are skipped (never chained through a gate), other tasks still run.
 * Nothing left and nothing running → `stop`; work still running → only `wait`.
 * @param {State} state @returns {Action[]}
 */
export function tick(state) {
  const { backlog } = state;
  const bugs = new Map(state.bugs.map((b) => [b.id, b]));
  /** @type {Action[]} */
  const events = parentEvents(backlog, bugs).map((e) => ({ type: "task-event", ...e }));
  if (events.length > 0) return [...events, refreshInbox()];

  /** Real actions. @type {Action[]} */
  const acts = [];
  /** Explains why NOTHING is done with running work. @type {Action[]} */
  const waits = [];

  // Only bugs of a parent task CURRENTLY in `waiting-bugs` deserve a fixer. Picking over ALL bugs and filtering by parent
  // afterwards lets an `open` bug of a `done` task (high severity, low id) always win `nextBug` and starve every fixable bug — a silent stall.
  const fixable = new Map([...bugs].filter(([, b]) => backlog.get(b.parent)?.status === "waiting-bugs"));
  const bug = nextBug(fixable, []);
  if (bug && backlog.get(bug.parent)?.status === "waiting-bugs") {
    acts.push({ type: "spawn-fixer", bugId: bug.id, parentId: bug.parent, reason: `${bug.severity} bug of ${bug.parent}` });
  }

  const work = nextWork(state.requirements, backlog, state.questions);
  if (work && !state.plannerRunning && !state.ciClosed) {
    const label = work.kind === "requirement" ? `requirement ${work.file}` : `revise ${work.id}`;
    acts.push({
      type: "spawn-planner", work: label, model: config.roles.planner?.model ?? "sonnet",
      reason: work.kind === "requirement" ? "requirement not split yet" : work.missing.join(" · "),
    });
  }

  /** @type {Running[]} */
  const ready = [];
  for (const r of [...state.running].sort((a, b) => a.id.localeCompare(b.id))) {
    const task = backlog.get(r.id);
    const where = r.lane === "parallel" ? `slot ${r.slot}` : "serial lane";
    if (!task) waits.push(wait(r.id, `${where}: no longer in the backlog — awaiting recovery`));
    else if (r.phase === "developing") waits.push(wait(r.id, `${where}: first role running`));
    else if (r.phase === "integrating") waits.push(wait(r.id, `${where}: merging`));
    else if (r.phase === "verifying") waits.push(wait(r.id, `${where}: verifying before reviewers`));
    else if (r.activeRole) waits.push(wait(r.id, `${where}: role ${r.activeRole} running`));
    else if (r.phase === "ready-to-merge") ready.push(r);
    else {
      const { choice, chain } = chainFor(task, state.bugs);
      const { before, after } = splitChain(chain);
      const pending = (/** @type {ChainStep} */ s) => !r.rolesDone.includes(s.role);
      const next = before.find(pending) ?? (after.some(pending) && !r.verifiedHead ? null : after.find(pending));
      if (next === null) {
        // A-089: before-stage done, reviewers still pending and the diff has no green verify → verify FIRST; red goes back to
        // the developer, no reviewer session is opened for a diff about to change.
        acts.push({
          type: "verify-task", id: r.id, slot: r.slot,
          reason: `pattern ${choice.core}: before-stage done — verify before ${after.filter(pending).map((s) => s.role).join(", ")}`,
        });
      } else if (next) {
        const reason = `pattern ${choice.core}: call ${next.role} — ${next.reason}`;
        if (next.kind === "developer") {
          const d = chainDecision({ prev: state.sessionChain ?? null, task, lane: r.lane, now: state.now ?? null });
          acts.push({ type: "spawn-role", id: r.id, role: next.role, model: next.model, reason: `${reason} · ${d.reason}`, resume: d.resume });
        } else {
          // Reviewers are read-only and independent → all remaining reviewers go in one turn (`parallelWith`), not one after another.
          const others = next.kind === "reviewer" && config.parallelReviewers
            ? after.filter((s) => pending(s) && s.role !== next.role).map((s) => ({ role: s.role, reason: `pattern ${choice.core}: call ${s.role} — ${s.reason}` }))
            : [];
          acts.push({ type: "spawn-role", id: r.id, role: next.role, model: next.model, reason, ...(others.length > 0 ? { parallelWith: others } : {}) });
        }
      } else ready.push(r);
    }
  }
  integrateNext(state, ready, acts, waits);

  const runningIds = new Set(state.running.map((r) => r.id));
  // Tasks the conductor owns but not in `running`: last round's verify was red (retry) or an old session
  // was cut off. Re-run on the serial lane in the main worktree — as in A-014; re-adoption by slot is A-024.
  const mine = [...backlog.values()]
    .filter((t) => t.status === "doing" && t.owner === CONDUCTOR_OWNER && !runningIds.has(t.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const runningTasks = [...state.running.flatMap((r) => backlog.get(r.id) ?? []), ...mine];
  // Before-start gate: hidden from `schedule`. Tasks depending on it still cannot be picked
  // because the dependency is not `done`.
  const pickable = new Map([...backlog].filter(([, t]) => !(t.status === "todo" && gateBeforeStart(t).gated)));

  // A-086 — unfinished work on the main tree. The serial lane runs directly on the main tree, so:
  //  · an interrupted serial-lane task still owns its unfinished files → next round it goes on the serial lane REGARDLESS of
  //    lock rules, and it is the only serial task opened until it commits;
  //  · main tree dirty with no owner → no serial task is opened (its `git add -A` commit would sweep up that work); the parallel
  //    lane still runs because worker branches merge by `paths`.
  const dirty = state.dirtyTree ?? [];
  const serialHeld = state.running.some((r) => r.lane === "serial") || mine.length > 0;
  const owner = leftoverOwner(state.serialLeftover ?? null, dirty, backlog);
  const pinned = owner !== null && owner.status === "todo" && pickable.has(owner.id) && !serialHeld ? owner : null;
  const unowned = unownedChanges({ dirty, leftover: state.serialLeftover ?? null, backlog, held: serialHeld });
  /** Ready serial tasks held back by unfinished work — to say clearly why the serial lane is stalled. */
  const heldBack = (pinned !== null || owner !== null || unowned.length > 0)
    ? readyQueue(pickable, state.critical).filter((t) => t.id !== owner?.id && inferLocks(t).length > 0)
    : [];
  /** @type {Map<string, Task>} */
  let schedulable = pickable;
  if (pinned !== null || owner !== null || unowned.length > 0) {
    schedulable = new Map();
    for (const [id, t] of pickable) {
      if (t.status === "todo" && inferLocks(t).length > 0) continue; // every other serial task waits
      schedulable.set(id, t);
    }
    // The pinned task goes on the serial lane even if today's lock rules no longer require it.
    if (pinned !== null) schedulable.set(pinned.id, inferLocks(pinned).length > 0 ? pinned : { ...pinned, locks: [...pinned.locks, SERIAL_LEFTOVER_LOCK] });
  }
  const scheduled = schedule(schedulable, runningTasks, { workers: state.workers, critical: state.critical });
  const serial = scheduled.serial === null ? null : backlog.get(scheduled.serial.id) ?? scheduled.serial;
  const parallel = scheduled.parallel;

  /** @param {Task} task @param {Lane} lane @param {number|null} slot @param {boolean} retry */
  const spawn = (task, lane, slot, retry) => {
    const { choice, chain } = chainFor(task, state.bugs);
    const first = chain[0];
    if (!first) {
      waits.push(wait(task.id, "empty roleChain — no developer role in the `roles` table matches"));
      return;
    }
    const locks = inferLocks(task);
    const laneText = lane !== "serial" ? `parallel lane, slot ${slot}`
      : task.id === pinned?.id ? "serial lane (unfinished work on the main tree from a previous run)"
        : `serial lane${locks.length > 0 ? ` (locks ${locks.join(", ")})` : ""}`;
    // A task just `release`d (worker died/timed out) still has its worktree: reuse it, do NOT create a second one.
    const reuseWorktree = lane === "parallel" && state.worktrees.includes(task.id);
    const prev = state.sessionChain ?? null;
    // Re-runs after a red verify have their own resume path (A-053, with the error) — the A-052 chain only handles NEW tasks.
    const d = first.kind === "developer" && !retry
      ? chainDecision({ prev, task, lane, now: state.now ?? null, prevContext: prev ? backlog.get(prev.taskId)?.context ?? null : null })
      : null;
    acts.push({
      type: "spawn-worker", id: task.id, lane, slot, role: first.role, model: first.model, chain, retry, reuseWorktree,
      reason: `${retry ? "retry · " : ""}${choice.reason} · ${laneText}${reuseWorktree ? " · reusing old worktree (no worker add)" : ""} · call ${first.role}: ${first.reason}${d ? ` · ${d.reason}` : ""}`,
      resume: d?.resume ?? null,
      compactSummary: d?.compact ?? null,
    });
  };
  // `mine` are already-open tasks retrying after a red verify — they run to the end; only NEW tasks are blocked by the CI gate (A-084).
  for (const t of mine) spawn(t, "serial", null, true);
  if (!state.ciClosed) {
    if (serial) spawn(serial, "serial", null, false);
    const free = freeSlots(state.running.flatMap((r) => r.slot ?? []), state.workers);
    for (const t of parallel) {
      const slot = free.shift();
      if (slot === undefined) waits.push(wait(t.id, "no free worker slot"));
      else spawn(t, "parallel", slot, false);
    }
  }

  if (acts.length > 0) return [...acts, ...waits, refreshInbox()];
  if (waits.length > 0) return waits;
  if (state.plannerRunning) return [wait(null, `planner running${state.plannerWork ? `: ${state.plannerWork}` : ""}`)];
  if (state.ciClosed) return [{ type: "stop", reason: state.ciClosed.reason }];
  return [{ type: "stop", reason: stopReason(backlog, state.critical, treeNotes({ owner, unowned, heldBack })) }];
}

/** Pseudo-lock (A-086): pushes a task with unfinished work on the main tree onto the serial lane even if today's lock rules no longer require it. */
const SERIAL_LEFTOVER_LOCK = "serial-leftover";

/**
 * Says clearly why the serial lane is stalled when unfinished work on the main tree holds it (A-086). Only when a serial task is actually waiting.
 * @param {{owner: Task|null, unowned: string[], heldBack: Task[]}} input @returns {string[]}
 */
function treeNotes({ owner, unowned, heldBack }) {
  if (unowned.length > 0 && heldBack.length > 0) {
    return [`main tree has uncommitted changes owned by no task (${unowned.slice(0, MAX_SHOWN_PATHS).join(", ")}…) — commit or stash them (git stash), then run again`];
  }
  if (owner !== null && owner.status === "todo") {
    return [`unfinished work of ${owner.id} is on the main tree — the serial lane only reopens ${owner.id}${heldBack.length > 0 ? `, ${heldBack.map((t) => t.id).join(", ")} waiting` : ""}`];
  }
  return [];
}

/** @returns {Action} */
const refreshInbox = () => ({ type: "write-inbox", reason: "refresh INBOX after this round's actions" });

/**
 * Pick ONE task to merge. Merges are serial because each one rebases onto the previous result; two merges
 * at once are two rebases aiming at `main`. A task with open bugs (any of its bugs not `fixed`, including
 * `qa` bugs) is not merged — the fixer fixes, QA re-runs, then its turn comes.
 * @param {State} state @param {Running[]} ready @param {Action[]} acts @param {Action[]} waits
 */
function integrateNext(state, ready, acts, waits) {
  if (ready.length === 0) return;
  const holder = state.running.find((r) => r.phase === "integrating");
  const clean = ready.filter((r) => {
    const open = state.bugs.filter((b) => b.parent === r.id && b.status !== "fixed");
    if (open.length > 0) waits.push(wait(r.id, `not integrating: ${open.length} open bug(s) (${open.map((b) => b.id).join(", ")})`));
    return open.length === 0;
  });
  if (holder) {
    for (const r of clean) waits.push(wait(r.id, `all roles done, waiting for ${holder.id} to finish merging — one integrate at a time`));
    return;
  }
  const order = mergeOrder(clean.map((r) => r.id));
  const first = clean.find((r) => r.id === order[0]);
  if (!first) return;
  acts.push({
    type: "integrate", id: first.id, slot: first.slot,
    reason: `${first.lane === "serial" ? "serial lane: verify + commit in the main worktree" : `slot ${first.slot} branch: rebase → verify → ff-merge`} · first by mergeOrder in [${order.join(", ")}]`,
  });
  for (const id of order.slice(1)) waits.push(wait(id, `all roles done, waiting for its merge turn (mergeOrder after ${first.id})`));
}

// ─── Recovery (A-024) ───────────────────────────────────────────────────────

/**
 * @typedef {Object} Observed  what the conductor OBSERVES, separate from the state in task files
 * @property {{id: string, startedAt: number}[]} alive  live worker processes (epoch milliseconds)
 * @property {{id: string, code: number}[]} [exited]    processes that just exited, with their code
 * @property {string[]} worktrees                       ids of worktrees under `.claude/worktrees/`
 * @property {number} now                               current time (epoch milliseconds)
 */

/**
 * Compare file/memory state with observed reality. PURE FUNCTION, deterministic. NEVER deletes a
 * worktree and never marks `failed` — a dead worker only sends the task back to `todo` so a human can inspect
 * the worktree and the next round reschedules it (reusing the old worktree); `failed` is the verifier's job.
 *   - a running task needs a process (first role/active role) but the process is gone, or
 *     exited with code ≠ 0                                          → `release`;
 *   - process alive but past `timeoutMin` minutes                   → `kill` then `release`;
 *   - task `doing` + `owner: worker:w<n>` unknown to the conductor (restart):
 *       has a worktree → `adopt` slot n (no `worker add`); no worktree, duplicate slot or slot beyond
 *       `workers` → `release`;
 *   - worktree owned by no task (or the task is `done`) → `report-orphan`, never deleted.
 * @param {State} state @param {Observed} observed @param {{timeoutMin?: number}} [options]
 * @returns {Action[]}
 */
export function recover(state, observed, options = {}) {
  const timeoutMin = options.timeoutMin ?? config.workerTimeoutMin;
  const timeoutMs = timeoutMin * 60_000;
  const alive = new Map(observed.alive.map((a) => [a.id, a]));
  const exited = new Map((observed.exited ?? []).map((e) => [e.id, e.code]));
  const worktrees = new Set(observed.worktrees);
  const { backlog } = state;
  /** @type {Action[]} */
  const out = [];

  /** @param {string} id @param {string} where @returns {boolean} true if killed+released for running over time */
  const overtime = (id, where) => {
    const live = alive.get(id);
    if (!live || observed.now - live.startedAt <= timeoutMs) return false;
    const mins = Math.floor((observed.now - live.startedAt) / 60_000);
    out.push({ type: "kill", id, reason: `${where}: worker ran ${mins} min > ${timeoutMin} min (AGENT_QUEUE_WORKER_TIMEOUT_MIN)` });
    out.push({ type: "release", id, reason: `${where}: timed out — back to todo, worktree kept` });
    return true;
  };

  for (const r of [...state.running].sort((a, b) => a.id.localeCompare(b.id))) {
    if (backlog.get(r.id)?.status !== "doing") continue;
    const needsProcess = r.phase === "developing" || r.phase === "verifying" || Boolean(r.activeRole);
    if (!needsProcess) continue;
    const where = r.lane === "parallel" ? `slot ${r.slot}` : "serial lane";
    if (overtime(r.id, where)) continue;
    if (alive.has(r.id)) continue;
    const code = exited.get(r.id);
    if (code === 0) continue; // clean exit: the execution layer advances the phase itself
    out.push({
      type: "release", id: r.id,
      reason: `${where}: ${code === undefined ? "process gone" : `worker exited with code ${code}`} during phase ${r.phase} — back to todo, worktree kept`,
    });
  }

  const known = new Set(state.running.map((r) => r.id));
  const usedSlots = new Set(state.running.flatMap((r) => r.slot ?? []));
  for (const t of [...backlog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const slot = t.status === "doing" ? slotOfOwner(t.owner) : null;
    if (slot === null || known.has(t.id)) continue;
    if (!worktrees.has(t.id)) {
      out.push({ type: "release", id: t.id, reason: `owner ${t.owner} but no worktree — back to todo` });
    } else if (slot > state.workers) {
      out.push({ type: "release", id: t.id, reason: `slot ${slot} exceeds ${state.workers} worker(s) (AGENT_QUEUE_WORKERS) — back to todo, worktree kept` });
    } else if (usedSlots.has(slot)) {
      out.push({ type: "release", id: t.id, reason: `slot ${slot} already held by another task — back to todo, worktree kept` });
    } else if (!overtime(t.id, `slot ${slot}`)) {
      usedSlots.add(slot);
      out.push({ type: "adopt", id: t.id, slot, reason: `doing + ${t.owner} + existing worktree — re-adopting slot ${slot}, NO worker add` });
    }
  }

  const busy = new Set(state.running.map((r) => r.id));
  for (const id of orphanWorktrees(backlog, observed.worktrees).filter((w) => !busy.has(w))) {
    out.push({ type: "report-orphan", id, reason: `.claude/worktrees/${id} belongs to no task in progress — NOT deleted, a human reviews and cleans up` });
  }
  return out;
}

/**
 * Stop reason — says what is waiting for a human, not just "no work": ready tasks behind a before-start
 * gate, and `todo` tasks stuck behind a dependency the machine cannot clear on its own (needs-human, failed…).
 * Dependencies still `todo`/`doing` are not listed — they are just middle links; the root blocker has its own line.
 * @param {Map<string, Task>} backlog @param {string[]} critical @param {string[]} [notes]  extra reasons (A-086: unfinished work on the main tree)
 * @returns {string}
 */
function stopReason(backlog, critical, notes = []) {
  const parts = [...notes];
  const gated = readyQueue(backlog, critical).filter((t) => gateBeforeStart(t).gated).map((t) => t.id);
  if (gated.length > 0) parts.push(`awaiting human approval first: ${gated.join(", ")}`);
  const stuck = [...backlog.values()]
    .filter((t) => t.status === "todo")
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((t) => {
      const roots = missingDeps(t, backlog).filter((id) => !["todo", "doing"].includes(backlog.get(id)?.status ?? ""));
      const why = roots.map((id) => `${id} (${backlog.get(id)?.status ?? "not in backlog"})`);
      return why.length > 0 ? [`${t.id} waits for ${why.join(", ")}`] : [];
    });
  if (stuck.length > 0) parts.push(`stuck behind dependencies: ${stuck.join("; ")}`);
  return parts.length > 0 ? `no runnable work left; ${parts.join(" · ")}` : "no work left";
}

// ─── Execution ───────────────────────────────────────────────────────────────

/** @typedef {{code: number, output: string, usage?: import("./events.mjs").Usage, agentId?: string}} SpawnOutcome */

/**
 * @typedef {Object} Io  every side effect — replaceable in tests
 * @property {() => State} load
 * @property {(job: {role: string, model: string, prompt: string, taskId?: string, reason?: string}) => SpawnOutcome | Promise<SpawnOutcome>} spawn
 *           serial path (A-014): one role per process, wait for it. The real one goes through `runClaude` (A-037) so it is
 *           async; EVERY call site `await`s (the tests' synchronous fake io still works). `output` = final text of the session.
 * @property {(type: string, fields: Record<string, unknown>) => void} [emit]  emit an event into the ledger; never throws
 * @property {(taskId: string, role: string, output: string) => void} recordFindings  reviewer → reports/ (A-021)
 * @property {(task: Task, opts?: {phase?: "pre-review"|"integrate"}) => Promise<{ok: boolean, reason: string|null, results: {command: string, outcome: string, output: string}[]}>} verify
 *           `opts.phase` (A-089): pre-review verify or merge-step verify — only tagged onto `verify.result`
 * @property {(task: Task, event: string, patch?: {owner?: string|null}) => void} apply
 * @property {(file: string, patch: Record<string, string|number|null>) => void} patchFile
 * @property {(taskId: string) => void} [holdSerialLeftover]  A-086: a serial-lane task was just released to `todo` — record its
 *           unfinished work on the main tree (if any) so the next round pins it to the serial lane; absent → skipped
 * @property {(task: Task, needsHuman: string[]) => void} commit
 * @property {() => string} diff
 * @property {() => import("./roles.mjs").DiffFile[]|null} [gateFiles]  A-090: the task's `-U0` diff as `DiffFile[]` for the reviewer
 *           `when.diff` gate; null = git read failed (reviewer still runs). Absent (old fake io) → no gating
 * @property {(taskId: string, role: string, text: string) => void} [roleLog]  A-090: append text to `logs/agent-queue/<id>/<role>.log`
 * @property {(task: Task) => string|null} [contextPack]  contents of the group's context pack (A-051); absent → null
 * @property {() => string[]} changedFiles
 * @property {() => void} syncPlanner
 * @property {() => void} writeInbox
 * @property {(state: State) => Observed} observe  existing worktrees + live worker processes + time (A-024)
 * @property {(id: string) => void} kill           stop the worker process of task `id` (worktree untouched)
 * @property {(id: string, line: string) => void} workerLog  one line into the task's worker log
 * @property {(line: string) => void} log
 * @property {import("./conductor-exec.mjs").Executor} [parallel]  async executor (A-025) — when present, every
 *           `spawn-worker`/`spawn-role`/`integrate`/`spawn-fixer`/`spawn-planner` goes through it, in the background
 */

/** Consecutive red runs of a task + fingerprint of the latest failure (A-053). @typedef {{count: number, print: string|null}} Fails */

/**
 * @typedef {Object} RunReport
 * @property {string[]} done
 * @property {string[]} gated
 * @property {string[]} failed
 * @property {string[]} released  tasks back to `todo` because the worker died/timed out (A-024)
 * @property {string[]} adopted   tasks re-adopted from a previous run via `owner: worker:w<n>`
 * @property {{id: string, reason: string}[]} patterns
 * @property {{closed: string[], reopened: string[], exhausted: string[]}} bugs
 * @property {string} stopReason
 * @property {number} rounds
 */

/**
 * Runs until `tick` returns `stop` or the round cap is hit. An action's error is logged and does not
 * crash the loop.
 *
 * With `io.parallel`: each round `load` → `recover` → `tick` → start background jobs → wait for ONE job to finish,
 * then loop. Does not wait for all jobs: a third task starts as soon as a slot frees up. Stops only when `tick`
 * returns `stop` (no work, no process left) or nothing can run any more.
 * @param {Io} io @param {{maxRounds?: number, maxRetries?: number}} [options]
 * @returns {Promise<RunReport>}
 */
export async function runConductor(io, options = {}) {
  const par = io.parallel;
  // Each finished background job is a round: the serial version's cap of 50 would cut off a run of a few tasks.
  const maxRounds = options.maxRounds ?? (par ? 500 : 50);
  const maxRetries = options.maxRetries ?? config.maxRetries;
  /** @type {RunReport} */
  const run = { done: [], gated: [], failed: [], released: [], adopted: [], patterns: [], bugs: { closed: [], reopened: [], exhausted: [] }, stopReason: "", rounds: 0 };
  /** @type {Map<string, number>} */
  /** @type {Map<string, Fails>} */
  const fails = new Map();
  /** Recovery actions already reported — `adopt`/`report-orphan` repeat every round until someone cleans up. @type {Set<string>} */
  const reported = new Set();
  /** Times a task was `release`d (worker died/timed out) — beyond `maxRetries` it is `failed`, no endless loop. @type {Map<string, number>} */
  const releases = new Map();
  par?.attach(run);

  for (; run.rounds < maxRounds; run.rounds += 1) {
    const loaded = io.load();
    const state = par ? { ...loaded, running: par.running(), plannerRunning: par.plannerWork() !== null, plannerWork: par.plannerWork() } : loaded;
    if (await recoverRound(state, io, run, reported, releases, maxRetries)) continue;
    // Claude usage limit hit: hand out no new work, wait for running jobs to exit (recover returns tasks to todo), then stop.
    const limit = par?.limitHit() ?? null;
    if (limit) {
      if (par?.busy()) { await par.idle(); continue; }
      run.stopReason = `Claude usage limit reached (${limit.ids.join(", ")})${limit.resetsAt ? ` — resets ${limit.resetsAt}` : ""}; `
        + "tasks back to todo, NOT counted as failures — run the conductor again after that time";
      io.log(`stop: ${run.stopReason}`);
      io.writeInbox();
      return run;
    }
    const actions = tick(state);
    const stop = actions.find((a) => a.type === "stop");
    if (stop && stop.type === "stop") {
      if (par?.busy()) { await par.idle(); continue; }
      run.stopReason = stop.reason;
      io.log(`stop: ${stop.reason}`);
      // The report reads pending counts from INBOX — stopping in the first round means no action has rewritten it yet,
      // and a gate emitted by the Stop hook does not regenerate INBOX: regenerate here so the numbers are not stale.
      io.writeInbox();
      return run;
    }
    if (par) {
      if (!(await dispatchParallel(actions, state, io, par, run, fails, maxRetries))) {
        const why = actions.flatMap((a) => (a.type === "wait" ? [`${a.id ?? "—"}: ${a.reason}`] : [])).join(" · ");
        run.stopReason = `nothing can run any more${why ? ` — ${why}` : ""}`;
        io.log(`stop: ${run.stopReason}`);
        io.writeInbox();
        return run;
      }
      await par.idle();
      continue;
    }
    let workerStarted = false;
    for (const action of actions) {
      if (action.type === "spawn-worker") {
        if (workerStarted) {
          io.log(`${action.id}: deferred to next round — the serial executor runs one worker per round (slot ${action.slot ?? "—"})`);
          continue;
        }
        workerStarted = true;
      }
      try {
        await execute(action, state, io, run, fails, maxRetries);
      } catch (err) {
        io.log(`error in ${action.type}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }
  run.stopReason = `hit the cap of ${maxRounds} rounds`;
  io.log(`stop: ${run.stopReason}`);
  return run;
}

/**
 * One execution round with the parallel executor: "paperwork" (bug-driven status changes, INBOX) is done right away;
 * heavy work goes to `par` in the background. A fixer for a parent task the executor does not hold (e.g. the conductor
 * restarted midway) takes the serial path on the main tree.
 * @param {Action[]} actions @param {State} state @param {Io} io @param {import("./conductor-exec.mjs").Executor} par
 * @param {RunReport} run @param {Map<string, Fails>} fails @param {number} maxRetries
 * @returns {Promise<boolean>} false if this round did nothing and nothing is running — stop, no infinite spin
 */
async function dispatchParallel(actions, state, io, par, run, fails, maxRetries) {
  /** @type {Action[]} */
  const background = [];
  let acted = false;
  for (const action of actions) {
    try {
      if (action.type === "write-inbox" || action.type === "task-event" || (action.type === "spawn-fixer" && !par.has(action.parentId))) {
        if (action.type !== "write-inbox") acted = true;
        await execute(action, state, io, run, fails, maxRetries);
        if (action.type === "task-event") par.taskEvent(action.id, action.event);
      } else if (["spawn-worker", "spawn-role", "verify-task", "integrate", "spawn-fixer", "spawn-planner"].includes(action.type)) {
        background.push(action);
      }
    } catch (err) {
      io.log(`error in ${action.type}: ${/** @type {Error} */ (err).message}`);
    }
  }
  par.start(background);
  return acted || par.busy();
}

/**
 * At the start of EVERY round (including the first = startup): `recover`, then execute. `release` changes the task's
 * status through the state machine (`doing → todo`, owner cleared) and does NOT touch the worktree; each action writes
 * one line to the conductor log + the task's worker log, with the reason. A task `release`d more than `maxRetries` times
 * in one run is `failed` — a worker that keeps dying is not fixed by trying again.
 *
 * `adopt` with the parallel executor: put the task into `running` and re-run the first role in the existing worktree.
 * Without an executor (serial version) it is only recorded.
 * @param {State} state @param {Io} io @param {RunReport} run @param {Set<string>} reported
 * @param {Map<string, number>} releases @param {number} maxRetries
 * @returns {Promise<boolean>} true if a task changed status — state is stale, must reload
 */
async function recoverRound(state, io, run, reported, releases, maxRetries) {
  let changed = false;
  for (const a of recover(state, io.observe(state))) {
    if (a.type === "adopt" || a.type === "report-orphan") {
      const key = `${a.type}:${a.id}`;
      if (reported.has(key)) continue;
      reported.add(key);
    }
    if (a.type !== "release" && a.type !== "kill" && a.type !== "adopt" && a.type !== "report-orphan") continue;
    const line = `${a.type} ${a.id}: ${a.reason}`;
    io.log(line);
    if (a.type !== "report-orphan") io.workerLog(a.id, line);
    try {
      if (a.type === "kill") io.kill(a.id);
      else if (a.type === "adopt") {
        run.adopted.push(a.id);
        const task = state.backlog.get(a.id);
        if (io.parallel && task) {
          io.parallel.adopt(task, a.slot, chainFor(task, state.bugs).chain);
          changed = true; // task just entered `running` — `tick` must see the slot is taken
        }
      } else if (a.type === "release") {
        const task = /** @type {Task} */ (state.backlog.get(a.id));
        // A Claude usage limit is not a dead worker — not counted towards the `maxRetries` guard.
        const limited = io.parallel?.wasLimited(a.id) ?? false;
        const n = limited ? 0 : (releases.get(a.id) ?? 0) + 1;
        if (!limited) releases.set(a.id, n);
        const serialLane = state.running.some((r) => r.id === a.id && r.lane === "serial");
        io.parallel?.forget(a.id);
        if (limited) {
          io.apply(task, "release", { owner: null });
          run.released.push(a.id);
          io.log(`${a.id} → todo: Claude usage limit reached — not counted as a death, worktree kept`);
          if (serialLane) io.holdSerialLeftover?.(a.id);
        } else if (n > maxRetries) {
          io.apply(task, "fail", { owner: null });
          run.failed.push(a.id);
          io.log(`${a.id} → failed (worker died/timed out ${n} times in a row) — worktree kept for a human to inspect`);
        } else {
          io.apply(task, "release", { owner: null });
          run.released.push(a.id);
          if (serialLane) io.holdSerialLeftover?.(a.id);
        }
        changed = true;
      } else io.writeInbox(); // orphan worktrees show up in INBOX (generated from `git worktree list`)
    } catch (err) {
      io.log(`error in ${a.type} ${a.id}: ${/** @type {Error} */ (err).message}`);
    }
  }
  return changed;
}

/**
 * @param {Action} action @param {State} state @param {Io} io @param {RunReport} run
 * @param {Map<string, Fails>} fails @param {number} maxRetries
 */
async function execute(action, state, io, run, fails, maxRetries) {
  if (action.type === "write-inbox") return io.writeInbox();
  if (action.type === "task-event") {
    const task = /** @type {Task} */ (state.backlog.get(action.id));
    io.log(`${action.id} ${action.event}: ${action.reason}`);
    io.apply(task, action.event);
    if (action.event === "gate") run.gated.push(action.id);
    return;
  }
  if (action.type === "spawn-planner") {
    io.log(`planner: ${action.work} (${action.reason})`);
    await io.spawn({
      role: "planner", model: action.model,
      prompt: `You are the planner. Read .claude/agents/planner.md and do EXACTLY ONE thing: ${action.work}\nCLI command: ${plannerCli()}`,
    });
    io.syncPlanner();
    return;
  }
  if (action.type === "spawn-fixer") return runFixer(action, state, io, run);
  if (action.type === "spawn-worker") return runWorker(action, state, io, run, fails, maxRetries);
  // `spawn-role` · `integrate` · `wait` only appear when `state.running` is non-empty — the serial version
  // runs the whole role chain inside `runWorker` so it never has them; the parallel version is handled by `io.parallel`.
}

/**
 * @param {Extract<Action, {type: "spawn-worker"}>} action @param {State} state @param {Io} io
 * @param {RunReport} run @param {Map<string, Fails>} fails @param {number} maxRetries
 */
async function runWorker(action, state, io, run, fails, maxRetries) {
  let task = /** @type {Task} */ (state.backlog.get(action.id));
  io.log(`${task.id}: ${action.chain.map((s) => `${s.role}(${s.model})`).join(" → ")} — ${action.reason}`);
  run.patterns.push({ id: task.id, reason: action.reason });
  try {
    io.emit?.("pattern.chosen", patternFields(task, action.reason, { slot: action.slot, role: action.role, model: action.model }));
  } catch {
    // The event ledger must never break task dispatch.
  }
  if (task.status === "todo") {
    io.apply(task, "claim", { owner: CONDUCTOR_OWNER });
    task = { ...task, status: "doing", owner: CONDUCTOR_OWNER };
  }
  const handoff = sectionOrNull(task.body, config.headings.handoff) ?? "";
  const { before, after } = splitChain(action.chain);
  /** @param {ChainStep} step */
  const runStep = async (step) => {
    // A-090: reviewer with `when.diff` and the diff has nothing it reviews → no session (the serial chain runs once, no marker needed).
    if (step.kind === "reviewer" && config.roles[step.role]?.when.diff && io.gateFiles) {
      const files = io.gateFiles();
      const gate = files === null ? { run: true, reason: "" } : reviewerGate(config.roles[step.role], files);
      if (!gate.run) {
        io.roleLog?.(task.id, step.role, `\n===== ${new Date().toISOString()} · ${step.role} · ${task.id}\nskipped: ${gate.reason}\n`);
        io.log(`${task.id}: skipping ${step.role} — ${gate.reason}`);
        try {
          io.emit?.("role.skipped", { taskId: task.id, role: step.role, reason: gate.reason });
        } catch {
          // The event ledger must never break the role chain.
        }
        return;
      }
    }
    const prompt = rolePrompt(step.role, task, io.diff(), handoff, io.contextPack?.(task) ?? null);
    let r = await io.spawn({ role: step.role, model: step.model, prompt, taskId: task.id });
    if (r.code !== 0) io.log(`${task.id}: ${step.role} exited with code ${r.code}`);
    if (step.kind === "reviewer") {
      // A-073: exit 0 without a valid JSON block → call again EXACTLY ONCE (fresh session, same model + prompt + error tail);
      // the first attempt leaves no error report or `error`-level `finding` event. Exit ≠ 0 follows the existing recovery path.
      const parsed = parseFindings(r.output);
      if (r.code === 0 && shouldRetryReviewer(parsed, 1)) {
        const error = parsed.ok ? "" : parsed.error;
        io.log(`${task.id}: ${step.role} did not return a JSON block (${error}) — calling again once`);
        r = await io.spawn({
          role: step.role, model: step.model, prompt: prompt + reviewerRetryTail(error), taskId: task.id,
          reason: `call 2/${MAX_REVIEWER_CALLS}: previous turn had no valid JSON block (${error})`,
        });
        if (r.code !== 0) io.log(`${task.id}: ${step.role} (retry) exited with code ${r.code}`);
      }
      // Reviewers write no files: the last JSON block in the output → reports/ → INBOX; does NOT block merging (A-021).
      io.recordFindings(task.id, step.role, r.output);
    }
  };

  for (const step of before) await runStep(step);
  // A-089: verify RIGHT AFTER the before-stage, BEFORE reviewers. Red → handled like any red, NO reviewer session for a diff
  // about to change; green → reviewers (read-only, write no files) then finalise directly, no second verify.
  const result = await io.verify(task, { phase: after.length > 0 ? "pre-review" : "integrate" });
  if (result.ok) {
    for (const step of after) await runStep(step);
    fails.delete(task.id);
    if (task.manual.length > 0) {
      io.apply(task, "gate", { owner: null });
      io.commit(task, task.manual);
      run.gated.push(task.id);
      io.log(`${task.id} → needs-human (machine part green)`);
    } else {
      io.apply(task, "pass", { owner: null });
      io.commit(task, []);
      run.done.push(task.id);
      io.log(`${task.id} → done`);
    }
    return;
  }
  const prevFail = fails.get(task.id);
  const n = (prevFail?.count ?? 0) + 1;
  // A-053: fingerprint taken directly from the verify result (this path does not read `verifier.log`).
  const print = failureFingerprint(result.results.filter((x) => x.outcome === "failed")
    .map((x) => `✗ ${x.command}\n${x.output}`).join("\n"));
  fails.set(task.id, { count: n, print });
  const sameFailure = print !== null && prevFail?.print === print;
  if (sameFailure) {
    io.apply(task, "fail", { owner: null });
    run.failed.push(task.id);
    io.log(`${task.id} → failed: same verify failure twice: ${redact(print)}`);
  } else if (n > maxRetries) {
    io.apply(task, "fail", { owner: null });
    run.failed.push(task.id);
    io.log(`${task.id} → failed (red ${n} times in a row)`);
  } else {
    io.log(`${task.id} red ${n}/${maxRetries + 1}: ${result.reason ?? ""}`);
  }
}

/**
 * @param {Extract<Action, {type: "spawn-fixer"}>} action @param {State} state @param {Io} io @param {RunReport} run
 */
async function runFixer(action, state, io, run) {
  const bug = /** @type {Bug} */ (state.bugs.find((b) => b.id === action.bugId));
  const parent = /** @type {Task} */ (state.backlog.get(action.parentId));
  io.log(`fixer: ${bug.id} (${action.reason})`);
  io.patchFile(bug.file, { status: "fixing" });
  // Round n of a bug = `rounds + 1` (A-026): from round 2 on, a stronger model per `modelByRound`.
  const model = config.roles.fixer ? modelFor(config.roles.fixer, bug.rounds + 1) : "sonnet";
  await io.spawn({ role: "fixer", model, prompt: fixerPrompt(bug, parent, io.diff()), taskId: parent.id });

  const repro = await io.verify({ ...parent, verify: bug.verify, manual: [] });
  const parentVerify = repro.ok ? await io.verify({ ...parent, manual: [] }) : { ok: false };
  const verdict = fixVerdict(bug, { repro: repro.ok, parentVerify: parentVerify.ok, changed: io.changedFiles() });
  const status = verdict.event === "pass" ? "fixed" : verdict.event === "fail" ? "open" : "needs-human";
  io.patchFile(bug.file, verdict.event === "pass" ? { status } : { status, rounds: bug.rounds + 1 });
  (verdict.event === "pass" ? run.bugs.closed : verdict.event === "fail" ? run.bugs.reopened : run.bugs.exhausted).push(bug.id);
  io.log(`${bug.id} → ${status}: ${verdict.reason}`);
}

// ─── Real io ────────────────────────────────────────────────────────────────

/**
 * Read state from disk — READ-ONLY (also used by `--dry-run`). `running` is empty: the serial executor
 * finishes each task within one round so nothing is "running" between rounds; A-024/A-025
 * build it from observed processes + worktrees.
 * @returns {State}
 */
export function loadState() {
  const now = Date.now();
  return {
    backlog: loadBacklog(), running: [], bugs: [...loadBugs().values()], plannerRunning: false, plannerWork: null,
    workers: config.workers, worktrees: listWorktrees(process.cwd()).map((w) => w.id), requirements: loadRequirements(), questions: loadQuestions(), critical: criticalPath(),
    now, sessionChain: loadSessionChain(process.cwd(), now),
    // A-086: `tick` is pure, so the outer layer reads `git status` and the leftover record. READ-ONLY (also used by `--dry-run`).
    dirtyTree: readDirtyTree(process.cwd()), serialLeftover: readSerialLeftover(),
  };
}

/**
 * Last link of the session chain (A-052) from the event ledger — reads only the part of the ledger within the allowed idle gap
 * (anything older opens a fresh session anyway). Ledger disabled/unreadable → null (fresh session, nothing breaks).
 * @param {string} root @param {number} now @returns {ChainLink|null}
 */
function loadSessionChain(root, now) {
  if (!config.sessionChain.enabled) return null;
  const file = ledgerFile(root);
  if (file === null) return null;
  try {
    const events = readEvents(file, { sinceMs: now - config.sessionChain.maxGapMs - 60 * 60_000 });
    return chainLinkFromEvents(events, (role) => config.roles[role]?.kind === "developer");
  } catch {
    return null;
  }
}

/** @param {number|null} slot */
const slotText = (slot) => (slot === null ? "serial lane" : `slot ${slot}`);

/**
 * Human-readable plan — for `--dry-run` and logs: each action, lane/slot, role + model,
 * and why. `write-inbox` is housekeeping, not printed.
 * @param {Action[]} actions @returns {string}
 */
export function renderPlan(actions) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} head @param {string} reason @param {string[]} [extra] */
  const item = (head, reason, extra = []) => {
    lines.push(`${lines.filter((l) => /^\d+\. /.test(l)).length + 1}. ${head}`);
    for (const e of extra) lines.push(`   ${e}`);
    lines.push(`   why: ${reason}`);
  };
  for (const a of actions) {
    switch (a.type) {
      case "spawn-worker":
        item(`[${a.lane === "serial" ? "serial lane" : `parallel lane · ${slotText(a.slot)}`}] ${a.id} → ${a.role} (${a.model})${a.retry ? " — retry" : ""}`, a.reason,
          [`role chain: ${a.chain.map((s) => `${s.role}(${s.model})`).join(" → ")}`]);
        break;
      case "spawn-role": item(`${a.id} + role ${[a.role, ...(a.parallelWith ?? []).map((s) => s.role)].join(" ∥ ")} (${a.model})`, a.reason); break;
      case "integrate": item(`merge ${a.id} (${slotText(a.slot)})`, a.reason); break;
      case "spawn-planner": item(`[planner lane] planner (${a.model}) — ${a.work}`, a.reason); break;
      case "spawn-fixer": item(`[fixer lane] fixer fixes ${a.bugId} of ${a.parentId}`, a.reason); break;
      case "task-event": item(`${a.id}: ${a.event}`, a.reason); break;
      case "adopt": item(`re-adopt ${a.id} (slot ${a.slot})`, a.reason); break;
      case "release": item(`return ${a.id} to todo`, a.reason); break;
      case "kill": item(`stop the worker of ${a.id}`, a.reason); break;
      case "report-orphan": item(`orphan worktree ${a.id}`, a.reason); break;
      case "wait": item(`wait${a.id ? ` ${a.id}` : ""}`, a.reason); break;
      case "stop": item("stop", a.reason); break;
      case "write-inbox": break;
    }
  }
  return lines.length === 0 ? "(no actions)" : lines.join("\n");
}

/**
 * Paths `commitTask` may stage when merging a worker branch: the task file, INDEX/INBOX, bugs and reports
 * of THAT task only. Never sweeps the whole tree: the serial lane may have unfinished edits in the main worktree.
 * @param {string} root @param {Task} task @returns {string[]}
 */
function taskPaths(root, task) {
  const reports = fs.existsSync(path.join(root, "reports"))
    ? fs.readdirSync(path.join(root, "reports")).filter((n) => n.startsWith(`${task.id}.`)).map((n) => path.join("reports", n))
    : [];
  const bugs = [...loadBugs().values()].filter((b) => b.parent === task.id).map((b) => b.file);
  return [task.file, config.indexFile, path.join(path.dirname(config.indexFile), "INBOX.md"), ...bugs, ...reports]
    .filter((f) => fs.existsSync(path.join(root, f)));
}

/** @typedef {import("./verify.mjs").CheckResult} CheckResult */
/** @typedef {{ok: boolean, results: CheckResult[], reason: string|null}} VerifyReport */

/**
 * PURE FUNCTION. `verifyTask`'s `CheckResult[]` → the two new fields of `verify.result` (A-041).
 * `ok` = command ran and exited 0; a skipped command (e.g. missing test database) has `ok: false, skipped: true`.
 * `failTail` = ≤ 20 last output lines of the first RED command (skipped ones excluded), or null. Both redacted.
 * @param {CheckResult[]} results @param {Record<string, string>} [env] worker env, to redact standalone passwords
 * @returns {{checks: import("./events.mjs").VerifyCheck[], failTail: string|null}}
 */
export function summarizeChecks(results, env = {}) {
  const checks = results.map((r) => {
    /** @type {import("./events.mjs").VerifyCheck} */
    const check = { cmd: redact(r.command, env).slice(0, MAX_CHECK_CMD_CHARS), ok: r.outcome === "passed", durationMs: r.durationMs };
    if (r.outcome === "skipped") check.skipped = true;
    return check;
  });
  const red = results.find((r) => r.outcome === "failed");
  const failTail = red ? redact(red.output, env).trim().split("\n").slice(-MAX_FAIL_TAIL_LINES).join("\n") : null;
  return { checks, failTail };
}

/**
 * PURE FUNCTION. Same text as `cli verify` (without `--json`): one line per command, red commands with indented output,
 * a closing line. This is the text for `verifier.log` and for the integrator's red reason (last 6 lines).
 * @param {VerifyReport} report @returns {string}
 */
export function renderVerifyText(report) {
  const lines = [];
  for (const r of report.results) {
    const mark = r.outcome === "passed" ? "✓" : r.outcome === "skipped" ? "–" : "✗";
    lines.push(`${mark} ${r.command}  (${r.durationMs}ms)`);
    if (r.outcome === "failed") lines.push(...r.output.split("\n").map((l) => `    ${l}`));
  }
  lines.push(report.ok ? "\nPassed." : `\nNot passed: ${report.reason}`);
  return `${lines.join("\n")}\n`;
}

/**
 * PURE FUNCTION. Parse the stdout of `cli verify --json`; malformed / missing `results` → null.
 * @param {string} stdout @returns {VerifyReport|null}
 */
export function parseVerifyJson(stdout) {
  try {
    const v = JSON.parse(stdout);
    if (typeof v !== "object" || v === null || !Array.isArray(v.results)) return null;
    const results = v.results.filter((/** @type {any} */ r) => typeof r === "object" && r !== null && typeof r.command === "string" &&
      typeof r.output === "string" && typeof r.durationMs === "number" &&
      (r.outcome === "passed" || r.outcome === "failed" || r.outcome === "skipped"));
    if (results.length !== v.results.length) return null;
    return { ok: v.ok === true, results, reason: typeof v.reason === "string" ? v.reason : null };
  } catch {
    return null;
  }
}

/**
 * Record ONE verify run: a `verify.result` event (with `checks`/`failTail`) + append to `verifier.log`.
 * `report` null (structured result unreadable) → the event has only `reason`, `checks`/`failTail` = null,
 * the log gets `fallbackText`. All text going into the ledger and log passes through `redact`. Does not change the verify result.
 * @param {{
 *   taskId: string, ok: boolean, report: VerifyReport|null, reason?: string|null, fallbackText: string,
 *   env: Record<string, string>, emit: (type: string, fields: Record<string, unknown>) => void,
 *   writeLog: (id: string, name: string, text: string) => void, now?: () => Date,
 *   phase?: "pre-review"|"integrate",
 * }} args  `phase` (A-089): defaults to `integrate` — the verify at the merge step / end of the serial chain
 */
export function recordVerify({ taskId, ok, report, reason, fallbackText, env, emit, writeLog, now = () => new Date(), phase = "integrate" }) {
  const text = redact(report ? renderVerifyText(report) : fallbackText, env);
  const shortReason = (/** @type {string} */ s) => s.slice(0, 300);
  // No `reason` given (parallel path) → last 3 lines of the redacted text, exactly as before A-041.
  const given = reason === undefined ? text.trim().split("\n").slice(-3).join(" | ") : reason && redact(reason, env);
  const shown = ok || given === null ? null : shortReason(given);
  const detail = report ? summarizeChecks(report.results, env) : { checks: null, failTail: null };
  emit("verify.result", { taskId, ok, reason: shown, phase, ...detail });
  writeLog(taskId, "verifier", `===== verify ${now().toISOString()} · ${ok ? "passed" : "red"} =====\n${text.trimEnd()}\n`);
}

/**
 * Parallel path: run `cli verify <id> --manual-ok --json` in the worktree, record via `recordVerify`.
 * Returns `output` as human-readable text (as before A-041) so the integrator takes the last 6 lines as the red reason.
 * @param {{
 *   cwd: string, cli: string, taskId: string, env: Record<string, string>, timeoutMs: number,
 *   spawn: (cmd: string, args: string[], opts: {cwd: string, env: Record<string, string>, timeoutMs: number}) =>
 *     Promise<{code: number|null, stdout: string, stderr: string}>,
 *   emit: (type: string, fields: Record<string, unknown>) => void,
 *   writeLog: (id: string, name: string, text: string) => void,
 * }} args
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function verifyInWorktreeJson({ cwd, cli, taskId, env, timeoutMs, spawn, emit, writeLog }) {
  // Only the merge step (integrate) calls this → `phase: "integrate"`; the pre-review verify goes through the executor's `recordVerify`.
  const r = await spawn(process.execPath, [cli, "verify", taskId, "--manual-ok", "--json"], {
    cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, timeoutMs,
  });
  const ok = r.code === 0;
  const report = parseVerifyJson(r.stdout);
  const output = report ? renderVerifyText(report) : `${r.stdout}${r.stderr}`;
  recordVerify({ taskId, ok, report, fallbackText: output, env, emit, writeLog });
  return { ok, output };
}

/**
 * The real io running on the repo. `claude -p` one process per role, clean context, Stop hook always disabled,
 * permissions from the role's allow-list (Q-001 = C). `io.parallel` runs parallel tasks on their own worktrees.
 * Every `claude -p` session goes through `runClaude` (A-037): `agent.start/end` + usage into the event ledger, `parentId` = the
 * conductor agent (`ctx.agentId`). A broken/disabled ledger changes nothing in the loop.
 * @param {string} root
 * @param {{runId: string, agentId: string|null}} [ctx]  run and conductor agent; missing → taken from env or generated
 * @returns {Io}
 */
export function realIo(root, ctx = { runId: process.env.AGENT_QUEUE_RUN_ID || newId("run"), agentId: process.env.AGENT_QUEUE_AGENT_ID || null }) {
  const ledger = ledgerFile(root);
  /** @type {(type: string, fields: Record<string, unknown>) => void} */
  const emit = (type, fields) => emitEvent(root, type, { runId: ctx.runId, agentId: ctx.agentId, ...fields });
  const logDir = path.join(root, "logs", "agent-queue", "conductor");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  /** @param {string} cmd @param {string[]} args */
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" }).stdout ?? "";
  /** @param {string} line */
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    fs.appendFileSync(logFile, `${stamped}\n`);
    process.stdout.write(`${line}\n`);
  };
  /** @type {() => import("./conductor-exec.mjs").PermissionMode} */
  const permission = () => (process.env.AGENT_QUEUE_SKIP_PERMISSIONS === "1" ? "skip" : "allowlist");
  /** @param {string} id @param {string} name @param {string} text */
  const writeLog = (id, name, text) => {
    const dir = path.join(root, "logs", "agent-queue", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.log`), text);
  };
  /** @type {Io["verify"]} */
  const verify = async (task, opts) => {
    const result = await verifyTask(task, config, { manualOk: true });
    recordVerify({
      taskId: task.id, ok: result.ok, report: result, reason: result.reason, fallbackText: "",
      env: readWorkerEnv(root, task.id), emit, writeLog, phase: opts?.phase ?? "integrate",
    });
    return result;
  };

  /** @type {import("./conductor-exec.mjs").ExecIo} */
  const execIo = {
    root, cli: siblingPath("cli.mjs"), plannerScript: siblingPath("run-planner.sh"),
    spawn: realSpawn,
    // `claude -p` sessions of worker/role/fixer: text log at `logs/agent-queue/<id>/<role>.log` (same file as `writeLog`).
    claude: (job) => runClaude({
      args: job.args, prompt: job.prompt, stdinPrompt: true, cwd: job.cwd, env: { ...process.env, ...job.env },
      logFile: path.join(root, "logs", "agent-queue", job.taskId, `${job.role}.log`),
      logBase: root, eventsFile: ledger, signal: job.signal, timeoutMs: job.timeoutMs, redact: job.redact,
      meta: {
        kind: agentKind(job.role), role: job.role, model: job.model, taskId: job.taskId, slot: job.slot,
        worktree: job.cwd === root ? null : path.relative(root, job.cwd), runId: ctx.runId, parentId: ctx.agentId,
        resumedFrom: job.resumedFrom ?? null, resumeKind: job.resumeKind ?? null,
      },
    }),
    emit,
    git: runGit,
    now: () => new Date(),
    permission,
    task: (id) => loadBacklog().get(id),
    bugs: () => [...loadBugs().values()],
    readEnv: (id) => readWorkerEnv(root, id),
    readText: (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } },
    writeCompact: (id, text) => writeCompactFile(root, id, text),
    agentTools: (role) => readAgentTools(root, role),
    syncBugs: (cwd) => moveNewBugs(root, cwd),
    writeLog,
    recordFindings: (taskId, role, output) => { recordFindings(root, taskId, role, output); },
    apply: (task, event, patch) => { applyEvent(task, event, patch ?? {}); },
    patchFile: (file, patch) => { fs.writeFileSync(file, patchFrontMatter(fs.readFileSync(file, "utf8"), patch, file)); },
    verify,
    // A-089: the pre-review verify on the parallel lane runs in the executor (`verifyIn`), ledger + log written through here.
    recordVerify: ({ taskId, ok, report, reason, env, phase }) => recordVerify({
      taskId, ok, report, reason, fallbackText: "", env, emit, writeLog, phase,
    }),
    // The integrator's verify runs async + `--manual-ok`: only the MACHINE part of a task with `manual:` (a human confirms later).
    integrate: (id, slot, env, _signal, opts) => integrateAsync(root, id, {
      env,
      verifiedHead: opts?.verifiedHead ?? null,
      // The parallel path (default) only verifies here — without this the ledger would never see `verify.result`.
      verify: (cwd, taskId, workerEnv) => verifyInWorktreeJson({
        cwd, cli: cliPathFor(cwd), taskId, env: workerEnv, timeoutMs: config.verifyTimeoutMs, spawn: realSpawn, emit, writeLog,
      }),
    }),
    // Push AFTER EVERY merge (decided by the repo owner). Only pushes when the branch has an upstream — `commitTask` handles it.
    commit: (task, needsHuman, scope) => {
      const result = commitTask(task, {
        needsHuman, push: process.env.AGENT_QUEUE_PUSH !== "0", paths: scope === "task" ? taskPaths(root, task) : undefined,
      });
      // A-086: a `paths` commit (worker branch merge) sweeps nobody's unfinished work → only clear this task's own record.
      // A `git add -A` commit (serial lane) sweeps the whole main tree, so every record becomes moot.
      clearSerialLeftover(config.storeFile, scope === "task" ? task.id : undefined);
      return result;
    },
    holdSerialLeftover: (id) => { recordSerialLeftover(id, readDirtyTree(root)); },
    syncPlanner: () => { syncPlanner(); },
    log,
    changedPaths: (cwd) => changedPaths(root, cwd),
  };
  const parallel = createExecutor(execIo, { workers: config.workers });

  return {
    load: () => {
      const state = { ...loadState(), ciClosed: ciClosedFor(root) };
      // A-086: main tree is clean (a human dealt with the unfinished work) → the record is moot; clear it so the next round does not hold the lane for it.
      if (state.serialLeftover && (state.dirtyTree ?? []).length === 0) {
        clearSerialLeftover(config.storeFile);
        return { ...state, serialLeftover: null };
      }
      return state;
    },
    holdSerialLeftover: execIo.holdSerialLeftover,
    // Serial path (A-014): same permission flags as the parallel path; prompt via stdin.
    spawn: async ({ role, model, prompt, taskId, reason }) => {
      const rule = { ...config.roles[role], model, modelByRound: undefined, tools: readAgentTools(root, role) };
      const mode = permission();
      const args = claudeArgs(role, { id: role }, rule, mode);
      if (mode === "skip") log(`WARNING: ${role} runs with --dangerously-skip-permissions (AGENT_QUEUE_SKIP_PERMISSIONS=1)`);
      fs.appendFileSync(logFile, `\n===== ${role} (${model})${reason ? ` — ${reason}` : ""} =====\n`);
      const r = await runClaude({
        args, prompt, stdinPrompt: true, cwd: root, env: { ...process.env, AGENT_QUEUE_DISABLE: "1" }, logFile,
        eventsFile: ledger,
        meta: { kind: agentKind(role), role, model, taskId, slot: null, worktree: null, runId: ctx.runId, parentId: ctx.agentId },
      });
      return { code: r.code, output: r.output, usage: r.usage, agentId: r.agentId };
    },
    emit,
    // Every write is SYNCHRONOUS: the next round's `load()` must see this round's results.
    verify,
    recordFindings: execIo.recordFindings,
    apply: execIo.apply,
    patchFile: execIo.patchFile,
    commit: (task, needsHuman) => {
      commitTask(task, { needsHuman });
      clearSerialLeftover(config.storeFile); // `git add -A` sweeps the whole main tree — unfinished work (if any) went into this commit
    },
    diff: () => sh("git", ["diff", "HEAD"]),
    gateFiles: () => readGateFiles(runGit, execIo.readText, root, root),
    roleLog: (id, role, text) => writeLog(id, role, text),
    contextPack: (task) => {
      const file = contextPackFile(task);
      if (file === null) return null;
      try {
        return fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        return null;
      }
    },
    changedFiles: () => sh("git", ["diff", "--name-only", "HEAD"]).split("\n").filter((f) => f !== ""),
    syncPlanner: execIo.syncPlanner,
    writeInbox: () => { writeInbox(); },
    observe: () => ({ alive: parallel.alive(), exited: parallel.exited(), worktrees: listWorktrees(root).map((w) => w.id), now: Date.now() }),
    kill: (id) => parallel.kill(id),
    workerLog: (id, line) => writeLog(id, "worker", `${new Date().toISOString()} ${line}\n`),
    log,
    parallel,
  };
}

/**
 * A-079: CI of the main branch is red → ONE warning line; not red / disabled / error → null. REPORTS only — does not change
 * `stopReason`, does not stop, does not touch push (stopping push + new work is `ciClosedFor` below). Never throws.
 * @param {string} root @param {import("./project-config.mjs").CiWatch|null|undefined} [cfg] @param {import("./ci-status.mjs").CiDeps} [deps]
 * @returns {string|null}
 */
export function ciWarningLine(root, cfg = config.ci, deps = {}) {
  try {
    return cfg ? ciWarning(readCiStatus(root, cfg, deps), cfg.branch) : null;
  } catch {
    return null;
  }
}

/**
 * A-084: CI gate closed (`ci.gate = block` + main-branch CI red + currently on that branch) → `{reason}` where `reason` is
 * the run's `stopReason`; otherwise null. Outer layer of `tick`: fills `State.ciClosed` each round. Never throws.
 * @param {string} root @param {import("./project-config.mjs").CiWatch|null|undefined} [cfg] @param {import("./ci-status.mjs").CiDeps} [deps]
 * @returns {{reason: string}|null}
 */
export function ciClosedFor(root, cfg = config.ci, deps = {}) {
  const gate = ciGateNow(root, cfg, deps);
  if (!gate.closed || !gate.status || !cfg) return null;
  return { reason: ciClosedStopReason(gate.status, cfg.branch, gate.unpushed) };
}

/**
 * ONE conductor run with an event ledger (A-037): `run.start` → `agent.start` (kind conductor, pid of this process)
 * → `runConductor` → `agent.end` → `run.end`. Sets AGENT_QUEUE_RUN_ID / AGENT_QUEUE_AGENT_ID on this process
 * so every child command (`cli start`, `run-planner.sh`, verify…) attaches its events to this run.
 * A thrown error still closes the run (`exitCode` 1, `stopReason` = the error) and is rethrown. NOT used for `--dry-run` (read-only).
 * @param {string} root @param {{maxRounds?: number}} [options] @returns {Promise<RunReport>}
 */
export async function runSession(root, options = {}) {
  const runId = newId("run");
  const agentId = newId("agt");
  process.env.AGENT_QUEUE_RUN_ID = runId;
  process.env.AGENT_QUEUE_AGENT_ID = agentId;
  const ledger = ledgerFile(root);
  /** @param {string} type @param {Record<string, unknown>} fields */
  const emit = (type, fields) => appendEvent(ledger, makeEvent(type, { runId, ...fields }));
  const conductor = { agentId, kind: "conductor", pid: process.pid };
  const startedAt = Date.now();
  emit("run.start", { source: "conductor", workers: config.workers });
  emit("agent.start", conductor);
  /** @param {number} exitCode @param {string} stopReason @param {number|null} rounds */
  const finish = (exitCode, stopReason, rounds) => {
    emit("agent.end", {
      ...conductor, exitCode, durationMs: Date.now() - startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // the conductor is code, it spends no tokens
    });
    emit("run.end", { stopReason, rounds });
  };
  try {
    const io = realIo(root, { runId, agentId });
    const ciOpen = ciWarningLine(root);
    if (ciOpen !== null) io.log(ciOpen);
    const run = await runConductor(io, options);
    // Re-read right before `run.end` (cached for 5 minutes, so usually no extra `gh` call).
    const ciClose = ciWarningLine(root);
    if (ciClose !== null) io.log(ciClose);
    finish(0, run.stopReason, run.rounds);
    return run;
  } catch (err) {
    finish(1, `error: ${err instanceof Error ? err.message : String(err)}`, null);
    throw err;
  }
}

// Run directly: `npm run conductor [-- --max-rounds N | --dry-run]`
if (process.argv[1] && process.argv[1].endsWith("conductor.mjs")) {
  const { projectRoot } = await import("./project-config.mjs");
  const root = projectRoot();
  process.chdir(root);
  if (process.argv.includes("--dry-run")) {
    // READ-ONLY: one `tick` on the on-disk state, then print. Bypasses `runConductor`/`realIo`, so no
    // `start`, no worktree created, no INBOX written, no log file opened.
    const state = { ...loadState(), ciClosed: ciClosedFor(root) };
    // A real round starts with `recover`; there are no live processes to observe before running.
    const plan = [...recover(state, { alive: [], worktrees: state.worktrees, now: Date.now() }), ...tick(state)];
    // A-084: with the CI gate closed this line comes first — the plan below opens no new task.
    const closedLine = state.ciClosed ? `CI GATE CLOSED: ${state.ciClosed.reason}\n` : "";
    process.stdout.write(`${closedLine}First-round plan (--dry-run: read-only, nothing runs · ${config.workers} worker slot(s))\n${renderPlan(plan)}\n`);
    const ciDry = ciWarningLine(root);
    if (ciDry !== null) process.stdout.write(`${ciDry}\n`);
  } else {
    const { conductorReport } = await import("./report.mjs");
    const at = process.argv.indexOf("--max-rounds");
    const maxRounds = at === -1 ? undefined : Number(process.argv[at + 1]);
    const run = await runSession(root, { maxRounds });
    const inbox = fs.existsSync("tasks/INBOX.md") ? fs.readFileSync("tasks/INBOX.md", "utf8") : "";
    const counts = inboxCounts(inbox);
    const waiting = counts.questions + counts.approvals;
    process.stdout.write(`\n${conductorReport(run, waiting)}\n`);
  }
}

/**
 * The CLI command handed to the planner. A slash-command `cliHint` (plugin projects: `/agent-orchestration:task`)
 * cannot run inside `claude -p`, where slash commands are disabled — fall back to `node <this dir>/cli.mjs`.
 * @returns {string}
 */
export function plannerCli() {
  if (!config.cliHint.startsWith("/")) return config.cliHint;
  return `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs")}"`;
}
