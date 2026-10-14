// @ts-check
/**
 * LAYER 2 of the agent dashboard — folds events into display state
 * (requirements/bang-dieu-khien-agent.md). Every number on the page is a function of two things:
 * the event list (`readEvents`) and a backlog snapshot (`Snapshot`).
 *
 * PURE FUNCTIONS: no fs, no `process`, no `Date.now()`, no `process.kill`. The clock (`now`)
 * and the process probe (`isAlive`) are injected by the caller — the server (A-039) and the `usage` command share
 * these functions, tested with case tables like `tick`/`choosePattern`.
 *
 * Reading rules:
 *   - "Signal lost" (`lost`) is DISPLAY only: the agent has `agent.start`, no `agent.end`, and its pid
 *     is dead. Emits no event, changes no task status — recovery is the conductor's job (A-024).
 *   - `pid: null` (a subagent that does not know its parent process) → `running` until `agent.end`, never `lost`.
 *   - Tokens = input + output + cacheRead + cacheWrite. `costUsd` is summed separately, is an "equivalent", never mixed into tokens.
 *   - Line order in the ledger is not trusted: an `agent.end` arriving before its `agent.start` still pairs by `agentId`.
 */

/** @typedef {import("./events.mjs").AgentEvent} AgentEvent */
/** @typedef {import("./events.mjs").Usage} Usage */
/** @typedef {"running"|"ok"|"failed"|"lost"} AgentStatus */
/** @typedef {AgentStatus|"waiting"} NodeStatus */

/**
 * @typedef {object} AgentRow
 * @property {string} agentId
 * @property {string|null} parentId
 * @property {string|null} runId
 * @property {string|null} kind
 * @property {string|null} role
 * @property {string|null} model
 * @property {string|null} taskId
 * @property {number|null} slot
 * @property {string|null} worktree
 * @property {number|null} pid
 * @property {string|null} log
 * @property {string|null} startedAt ISO
 * @property {string|null} endedAt ISO
 * @property {number|null} durationMs finished: from `agent.end`; running: `now - startedAt`; signal lost: null
 * @property {number|null} exitCode
 * @property {Usage|null} usage null until finished
 * @property {number|null} costUsd
 * @property {number|null} numTurns
 * @property {string|null} sessionId Claude Code session id from `agent.end` (A-050)
 * @property {number|null} peakContext largest context of a single call (A-050); null when an older ledger did not record it
 * @property {string|null} resumedFrom agentId of the session that was `--resume`d (A-052; since A-083 also `retry` runs), from `agent.start`
 * @property {"chain"|"retry"|null} resumeKind how the session was resumed (A-083), from `agent.start`; older events without this field
 *   read as `chain` when `resumedFrom` is set (before A-083 only `chain` runs wrote it), otherwise null
 * @property {{cacheRead: number, cacheWrite: number}|null} firstCall usage of the first call (A-054), from `agent.end`
 * @property {AgentStatus} status
 */

/**
 * Backlog snapshot built from disk by the server/CLI — functions here never read disk.
 * Task `gate`: "none" | "money" | "migration" | "manual".
 * `worktrees`: task ids of the worktrees that actually exist.
 * @typedef {{
 *   tasks: {id: string, title: string, status: string, gate: string|null, owner: string|null}[],
 *   inbox: {questions: number, approvals: number, items: string[]},
 *   worktrees: string[],
 * }} Snapshot
 */

/**
 * @typedef {object} TreeNode
 * @property {string} id
 * @property {"conductor"|"lane"|"task"|"role"|"verifier"|"integrator"|"subagent"} kind
 * @property {string} label
 * @property {string|null} detail task title / verify reason / model
 * @property {NodeStatus} status
 * @property {string|null} agentId
 * @property {string|null} taskId
 * @property {string|null} role
 * @property {string|null} model
 * @property {number|null} slot lane: 0 = sequential, n = slot n
 * @property {string|null} startedAt
 * @property {TreeNode[]} children
 */

/** Identity fields copied from events into the agent row. */
const IDENTITY = /** @type {const} */ (["parentId", "runId", "kind", "role", "model", "taskId", "slot", "worktree", "pid", "log"]);

const UNKNOWN = "(unknown)";
const TOP_N = 5;
/** Floating-point error in summed cost: round to 6 decimal places. */
const roundCost = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;

/** @param {number|Date|null|undefined} v @returns {number} milliseconds, 0 when invalid */
function toMs(v) {
  if (v instanceof Date) return v.getTime();
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** @param {string|null} iso @returns {number|null} */
function parseMs(iso) {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** @param {unknown} n @returns {number} */
function count(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

/** @param {Usage} u @returns {number} */
export function totalTokens(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/**
 * LOCAL date (process time zone) as YYYY-MM-DD. Reads the time zone via Date, not via `process`.
 * @param {number} ms @returns {string}
 */
export function localDay(ms) {
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** @param {string} id @returns {AgentRow} */
function blankRow(id) {
  return {
    agentId: id, parentId: null, runId: null, kind: null, role: null, model: null, taskId: null, slot: null,
    worktree: null, pid: null, log: null, startedAt: null, endedAt: null, durationMs: null, exitCode: null,
    usage: null, costUsd: null, numTurns: null, sessionId: null, peakContext: null, resumedFrom: null, resumeKind: null, firstCall: null,
    status: "running",
  };
}

/**
 * Pairs `agent.start`/`agent.end` by `agentId` → one row per agent, ascending by start time.
 * Identity fields come from `agent.start` (if present), falling back to `agent.end` — the result does not depend
 * on the order of the two lines. No `agent.end` yet: pid null → `running`; pid alive → `running`; pid dead → `lost`.
 * With `agent.end`: exit code 0 → `ok`, anything else → `failed`.
 * @param {AgentEvent[]} events
 * @param {{isAlive: (pid: number) => boolean, now: number|Date}} ctx
 * @returns {AgentRow[]}
 */
export function foldAgents(events, { isAlive, now }) {
  const nowMs = toMs(now);
  /** @type {Map<string, AgentRow>} */
  const rows = new Map();
  for (const e of events) {
    if (e.type !== "agent.start" && e.type !== "agent.end") continue;
    if (typeof e.agentId !== "string" || e.agentId === "") continue;
    let row = rows.get(e.agentId);
    if (!row) {
      row = blankRow(e.agentId);
      rows.set(e.agentId, row);
    }
    const isStart = e.type === "agent.start";
    const fields = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (row));
    const from = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (e));
    for (const key of IDENTITY) {
      const v = from[key] ?? null;
      if (v === null) continue;
      // `agent.start` wins; `agent.end` only fills gaps — both line orders give the same result.
      if (isStart || fields[key] === null) fields[key] = v;
    }
    if (isStart) {
      if (row.startedAt === null || e.ts < row.startedAt) row.startedAt = e.ts;
      if (typeof e.resumedFrom === "string") row.resumedFrom = e.resumedFrom;
      row.resumeKind = e.resumeKind === "chain" || e.resumeKind === "retry" ? e.resumeKind : typeof e.resumedFrom === "string" ? "chain" : null;
    } else {
      row.endedAt = e.ts;
      row.exitCode = typeof e.exitCode === "number" ? e.exitCode : null;
      row.durationMs = typeof e.durationMs === "number" ? e.durationMs : null;
      row.costUsd = typeof e.costUsd === "number" ? e.costUsd : null;
      row.numTurns = typeof e.numTurns === "number" ? e.numTurns : null;
      row.sessionId = typeof e.sessionId === "string" ? e.sessionId : null;
      row.peakContext = typeof e.peakContext === "number" ? e.peakContext : null;
      const f = e.firstCall;
      row.firstCall = f && typeof f === "object" ? { cacheRead: count(f.cacheRead), cacheWrite: count(f.cacheWrite) } : null;
      const u = e.usage;
      row.usage = u && typeof u === "object"
        ? { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) }
        : null;
    }
  }

  /** @type {Map<number, boolean>} */
  const alive = new Map();
  const probe = (/** @type {number} */ pid) => {
    let a = alive.get(pid);
    if (a === undefined) {
      a = isAlive(pid);
      alive.set(pid, a);
    }
    return a;
  };

  for (const row of rows.values()) {
    const endMs = parseMs(row.endedAt);
    // `agent.end` without any `agent.start`: infer the start time from the duration (only for drawing the Gantt bar).
    if (row.startedAt === null && endMs !== null && row.durationMs !== null) {
      row.startedAt = new Date(endMs - row.durationMs).toISOString();
    }
    const startMs = parseMs(row.startedAt);
    if (row.endedAt !== null) {
      row.status = row.exitCode === 0 ? "ok" : "failed";
      if (row.durationMs === null && startMs !== null && endMs !== null) row.durationMs = Math.max(0, endMs - startMs);
    } else if (row.pid === null || probe(row.pid)) {
      row.status = "running";
      row.durationMs = startMs === null ? null : Math.max(0, nowMs - startMs);
    } else {
      row.status = "lost";
    }
  }

  return [...rows.values()].sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return a.startedAt < b.startedAt ? -1 : 1;
    }
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });
}

/**
 * @typedef {object} UsageBucket
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} tokens input + output + cacheRead + cacheWrite
 * @property {number|null} costUsd sum of `costUsd` over agents that have a price; null when none has one
 * @property {number|null} peakContext largest context among contributing agents (MAX, not a sum); null when
 *   no agent recorded it (A-050) — a measure of "how big a session got", unlike `tokens`, which sums every call
 * @property {number} agents number of finished agents contributing (WITH usage)
 * @property {number} unknown number of finished agents whose usage is `null` = tokens unknown (A-091: NOT 0 tokens).
 *   Only counted in `total`, `byModel`, `byRole`; `byTask`/`byDay`/`top` only include agents with usage
 */

/** @returns {UsageBucket} */
function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: null, peakContext: null, agents: 0, unknown: 0 };
}

/** @param {UsageBucket} b @param {AgentRow} a */
function addTo(b, a) {
  const u = /** @type {Usage} */ (a.usage);
  b.input += u.input;
  b.output += u.output;
  b.cacheRead += u.cacheRead;
  b.cacheWrite += u.cacheWrite;
  b.tokens += totalTokens(u);
  if (a.costUsd !== null) b.costUsd = roundCost((b.costUsd ?? 0) + a.costUsd);
  if (a.peakContext !== null) b.peakContext = Math.max(b.peakContext ?? 0, a.peakContext);
  b.agents += 1;
}

/**
 * @param {Map<string, UsageBucket>} map
 * @param {(a: [string, UsageBucket], b: [string, UsageBucket]) => number} order
 * @returns {Record<string, UsageBucket>}
 */
function toRecord(map, order) {
  return Object.fromEntries([...map.entries()].sort(order));
}

/** Most tokens first, ties by ascending key. @type {(a: [string, UsageBucket], b: [string, UsageBucket]) => number} */
const byTokensDesc = (a, b) => b[1].tokens - a[1].tokens || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
/**
 * Most expensive (USD) first; unpriced after everything priced; ties as in `byTokensDesc` (A-050: the page measures in USD).
 * @type {(a: [string, UsageBucket], b: [string, UsageBucket]) => number}
 */
const byCostDesc = (a, b) => (b[1].costUsd ?? -1) - (a[1].costUsd ?? -1) || byTokensDesc(a, b);
/** @type {(a: [string, UsageBucket], b: [string, UsageBucket]) => number} */
const byKeyAsc = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Sums tokens of FINISHED agents (with `usage`) by model / role / task / LOCAL day. A finished agent whose
 * `usage` is `null` (unreadable) is NOT counted as 0: it goes into the `unknown` counter of `total`/`byModel`/`byRole`.
 * An agent's timestamp is when it finished (when usage was recorded); `sinceMs` keeps agents that finished
 * at or after that point. Agents without a task (planner) are left out of `byTask` but still count in the total.
 * `warnPerTask`: token threshold for ONE task (`null`/absent = off); `overThreshold` lists task ids over the threshold.
 * `now` is accepted for symmetry with the other functions and unused — the time window is set by `sinceMs`.
 * @param {AgentRow[]} agents
 * @param {{sinceMs?: number|null, now?: number|Date, warnPerTask?: number|null}} [opts]
 * @returns {{
 *   total: UsageBucket,
 *   byModel: Record<string, UsageBucket>, byRole: Record<string, UsageBucket>,
 *   byTask: Record<string, UsageBucket>, byDay: Record<string, UsageBucket>,
 *   top: (UsageBucket & {taskId: string})[], overThreshold: string[],
 * }}
 */
export function usageBy(agents, { sinceMs = null, warnPerTask = null } = {}) {
  const total = emptyBucket();
  /** @type {Map<string, UsageBucket>} */
  const model = new Map();
  /** @type {Map<string, UsageBucket>} */
  const role = new Map();
  /** @type {Map<string, UsageBucket>} */
  const task = new Map();
  /** @type {Map<string, UsageBucket>} */
  const day = new Map();
  const bucket = (/** @type {Map<string, UsageBucket>} */ m, /** @type {string} */ k) => {
    let b = m.get(k);
    if (!b) {
      b = emptyBucket();
      m.set(k, b);
    }
    return b;
  };

  for (const a of agents) {
    // Running: no usage yet is normal, not counted. Finished with null usage: unknown — counted separately, never as 0.
    if (a.usage === null && a.endedAt === null) continue;
    const at = parseMs(a.endedAt ?? a.startedAt);
    if (sinceMs !== null && (at === null || at < sinceMs)) continue;
    if (a.usage === null) {
      total.unknown += 1;
      bucket(model, a.model ?? UNKNOWN).unknown += 1;
      bucket(role, a.role ?? a.kind ?? UNKNOWN).unknown += 1;
      continue;
    }
    addTo(total, a);
    addTo(bucket(model, a.model ?? UNKNOWN), a);
    addTo(bucket(role, a.role ?? a.kind ?? UNKNOWN), a);
    if (a.taskId !== null) addTo(bucket(task, a.taskId), a);
    if (at !== null) addTo(bucket(day, localDay(at)), a);
  }

  const byTask = toRecord(task, byCostDesc);
  const top = [...task.entries()].sort(byCostDesc).slice(0, TOP_N).map(([taskId, b]) => ({ taskId, ...b }));
  const limit = typeof warnPerTask === "number" && warnPerTask > 0 ? warnPerTask : null;
  const overThreshold = limit === null ? [] : [...task.entries()].sort(byTokensDesc).filter(([, b]) => b.tokens > limit).map(([id]) => id);

  return {
    total,
    byModel: toRecord(model, byCostDesc),
    byRole: toRecord(role, byCostDesc),
    byTask,
    byDay: toRecord(day, byKeyAsc),
    top,
    overThreshold,
  };
}

/** @returns {Snapshot} */
function emptySnapshot() {
  return { tasks: [], inbox: { questions: 0, approvals: 0, items: [] }, worktrees: [] };
}

/** @param {Partial<Snapshot>|null|undefined} s @returns {Snapshot} */
function normalizeSnapshot(s) {
  const base = emptySnapshot();
  if (!s) return base;
  return {
    tasks: s.tasks ?? base.tasks,
    inbox: { ...base.inbox, ...(s.inbox ?? {}) },
    worktrees: s.worktrees ?? base.worktrees,
  };
}

/**
 * `runId` of the NEWEST run: the run whose first event is latest (ties → larger id).
 * No event carries a runId → null.
 * @param {AgentEvent[]} events @returns {string|null}
 */
export function latestRunId(events) {
  /** @type {Map<string, string>} */
  const first = new Map();
  for (const e of events) {
    if (typeof e.runId !== "string" || e.runId === "") continue;
    const seen = first.get(e.runId);
    if (seen === undefined || e.ts < seen) first.set(e.runId, e.ts);
  }
  /** @type {string|null} */
  let best = null;
  for (const [id, ts] of first) {
    if (best === null) best = id;
    else {
      const b = /** @type {string} */ (first.get(best));
      if (ts > b || (ts === b && id > best)) best = id;
    }
  }
  return best;
}

/** Precedence when folding child statuses up into the parent node. */
const PRECEDENCE = /** @type {NodeStatus[]} */ (["running", "lost", "failed", "waiting", "ok"]);

/** @param {NodeStatus[]} statuses @returns {NodeStatus} */
function rollup(statuses) {
  for (const s of PRECEDENCE) if (statuses.includes(s)) return s;
  return "ok";
}

/**
 * @param {Partial<TreeNode> & {id: string, kind: TreeNode["kind"], label: string, status: NodeStatus}} p
 * @returns {TreeNode}
 */
function node(p) {
  return {
    detail: null, agentId: null, taskId: null, role: null, model: null, slot: null, startedAt: null, children: [], ...p,
  };
}

/** @param {AgentRow} a @returns {TreeNode} */
function agentNode(a) {
  return node({
    id: a.agentId,
    kind: a.kind === "subagent" ? "subagent" : "role",
    label: a.role ?? a.kind ?? a.agentId,
    detail: a.model,
    status: a.status,
    agentId: a.agentId,
    taskId: a.taskId,
    role: a.role,
    model: a.model,
    slot: a.slot,
    startedAt: a.startedAt,
  });
}

/** @param {TreeNode} n @returns {boolean} whether any node in the subtree is `running` */
function anyRunning(n) {
  return n.status === "running" || n.children.some(anyRunning);
}

/**
 * Scope of a run: agents carrying that `runId` + their descendants via `parentId` (subagents have no runId).
 * Keeps the order of `agents`; parent cycles do not hang.
 * @param {AgentRow[]} agents @param {string|null} runId @returns {AgentRow[]}
 */
function agentsInRun(agents, runId) {
  /** @type {Map<string, AgentRow[]>} */
  const byParent = new Map();
  for (const a of agents) {
    if (a.parentId === null) continue;
    const list = byParent.get(a.parentId);
    if (list) list.push(a);
    else byParent.set(a.parentId, [a]);
  }
  /** @type {Map<string, AgentRow>} */
  const scope = new Map();
  const queue = agents.filter((a) => a.runId === runId);
  for (let a = queue.pop(); a; a = queue.pop()) {
    if (scope.has(a.agentId)) continue;
    scope.set(a.agentId, a);
    for (const c of byParent.get(a.agentId) ?? []) queue.push(c);
  }
  return agents.filter((a) => scope.has(a.agentId));
}

/**
 * Orchestration tree of the newest run: Conductor → lane (Sequential = slot 0 · Slot n) → task → role chain →
 * verifier → integrator; subagents hang under their parent agent via `parentId`. Agents of other runs only enter the tree
 * as descendants (via `parentId`) of an agent in the run.
 *
 * Node sources: roles/subagents from `agents`; `verifier` from each `verify.result`; `integrator` from a
 * `task.transition` to `done` AFTER a passing `verify.result` (integration only happens after a green verify). No
 * `roles` table needed — role names are taken verbatim from events.
 * Task status: a `running` node in the chain → `running`; otherwise the status of the LAST node in the chain
 * (a later attempt overrides an earlier one); a `needs-human` task in the snapshot → `waiting`.
 * Root: if there is a conductor agent → follows it; else a `run.end` → `ok`; else folded from the lanes.
 * @param {AgentRow[]} agents @param {AgentEvent[]} events @param {Partial<Snapshot>|null} [snapshot]
 * @returns {TreeNode}
 */
export function buildTree(agents, events, snapshot) {
  const snap = normalizeSnapshot(snapshot);
  const snapTask = new Map(snap.tasks.map((t) => [t.id, t]));
  const runId = latestRunId(events);

  const inScope = agentsInRun(agents, runId);
  const conductor = inScope.find((a) => a.kind === "conductor") ?? null;
  const others = inScope.filter((a) => a.kind !== "conductor");

  // Agent nodes; a subagent (parent is a non-conductor agent within scope) hangs under its parent.
  /** @type {Map<string, TreeNode>} */
  const nodes = new Map(others.map((a) => [a.agentId, agentNode(a)]));
  /** @type {AgentRow[]} */
  const topLevel = [];
  for (const a of others) {
    const parent = a.parentId === null || a.parentId === a.agentId ? undefined : nodes.get(a.parentId);
    if (parent) parent.children.push(/** @type {TreeNode} */ (nodes.get(a.agentId)));
    else topLevel.push(a);
  }

  const runEvents = events.filter((e) => (e.runId ?? null) === runId);

  // Group by task: chain = top-level agents + verifier + integrator, ordered by time.
  /** @type {Map<string, {slot: number|null, chain: {ms: number, node: TreeNode}[], done: boolean}>} */
  const tasks = new Map();
  const taskEntry = (/** @type {string} */ id) => {
    let t = tasks.get(id);
    if (!t) {
      t = { slot: null, chain: [], done: false };
      tasks.set(id, t);
    }
    return t;
  };
  /** @type {Map<number, TreeNode[]>} */
  const laneItems = new Map();
  const pushLane = (/** @type {number} */ slot, /** @type {TreeNode} */ n) => {
    const list = laneItems.get(slot);
    if (list) list.push(n);
    else laneItems.set(slot, [n]);
  };

  for (const a of topLevel) {
    const n = /** @type {TreeNode} */ (nodes.get(a.agentId));
    if (a.taskId === null) {
      pushLane(a.slot ?? 0, n);
      continue;
    }
    const t = taskEntry(a.taskId);
    if (t.slot === null && a.slot !== null) t.slot = a.slot;
    t.chain.push({ ms: parseMs(a.startedAt) ?? 0, node: n });
  }

  /** @type {Map<string, boolean>} */
  const verifiedOk = new Map();
  for (const [i, e] of runEvents.entries()) {
    if (typeof e.taskId !== "string") continue;
    const ms = parseMs(e.ts) ?? 0;
    if (e.type === "verify.result") {
      const t = taskEntry(e.taskId);
      if (t.slot === null && typeof e.slot === "number") t.slot = e.slot;
      verifiedOk.set(e.taskId, e.ok === true);
      t.chain.push({
        ms,
        node: node({
          id: `verifier:${e.taskId}:${i}`, kind: "verifier", label: "verifier", detail: e.reason ?? null,
          status: e.ok === true ? "ok" : "failed", taskId: e.taskId, slot: e.slot ?? null, startedAt: e.ts,
        }),
      });
    } else if (e.type === "task.transition" && e.to === "done") {
      const t = taskEntry(e.taskId);
      if (t.slot === null && typeof e.slot === "number") t.slot = e.slot;
      t.done = true;
      if (verifiedOk.get(e.taskId) === true) {
        t.chain.push({
          ms,
          node: node({
            id: `integrator:${e.taskId}:${i}`, kind: "integrator", label: "integrator", status: "ok", taskId: e.taskId,
            slot: e.slot ?? null, startedAt: e.ts,
          }),
        });
      }
    }
  }

  for (const [id, t] of tasks) {
    // Stable: equal timestamps keep insertion order (agent → verifier → integrator).
    const chain = t.chain.map((c, i) => ({ ...c, i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
    const meta = snapTask.get(id);
    const last = chain.at(-1);
    /** @type {NodeStatus} */
    let status = last ? last.node.status : "ok";
    if (chain.some((c) => anyRunning(c.node))) status = "running";
    else if (meta?.status === "needs-human") status = "waiting";
    else if (status === "ok" && !t.done && meta?.status === "doing") status = "running";
    const taskNode = node({
      id: `task:${id}`, kind: "task", label: id, detail: meta?.title ?? null, status, taskId: id,
      slot: t.slot, startedAt: chain[0] ? new Date(chain[0].ms).toISOString() : null, children: chain.map((c) => c.node),
    });
    pushLane(t.slot ?? 0, taskNode);
  }

  const lanes = [...laneItems.entries()].sort((a, b) => a[0] - b[0]).map(([slot, children]) => node({
    id: `lane:${slot}`, kind: "lane", label: slot === 0 ? "Sequential" : `Slot ${slot}`, slot, children,
    status: rollup(children.map((c) => c.status)),
  }));

  /** @type {NodeStatus} */
  let rootStatus;
  if (conductor) rootStatus = conductor.status;
  else if (runEvents.some((e) => e.type === "run.end")) rootStatus = "ok";
  else {
    rootStatus = rollup(lanes.map((l) => l.status));
    // Run still open with nothing running: waiting for the final result, not finished yet.
    if (rootStatus === "ok" && runId !== null) rootStatus = "running";
  }
  const start = runEvents.find((e) => e.type === "run.start");
  return node({
    id: conductor?.agentId ?? start?.agentId ?? (runId === null ? "conductor" : `run:${runId}`),
    kind: "conductor",
    label: "Conductor",
    detail: runId,
    status: rootStatus,
    agentId: conductor?.agentId ?? start?.agentId ?? null,
    startedAt: conductor?.startedAt ?? start?.ts ?? null,
    children: lanes,
  });
}

/**
 * Gantt bars of a run: one bar per agent (conductor excluded), by slot (0 = sequential).
 * Running → extends to `now`; signal lost → to the run's last known activity (not extended to `now`
 * so it does not pretend to still be running). A run without agents → empty `bars`, `startMs`/`endMs` null.
 * @param {AgentRow[]} agents @param {string|null} runId
 * @param {{now?: number|Date}} [opts]
 * @returns {{runId: string|null, startMs: number|null, endMs: number|null,
 *   bars: {slot: number, agentId: string, label: string, startMs: number, endMs: number, status: AgentStatus}[]}}
 */
export function timeline(agents, runId, { now } = {}) {
  const mine = agents.filter((a) => a.runId === runId && a.kind !== "conductor" && parseMs(a.startedAt) !== null);
  if (mine.length === 0) return { runId, startMs: null, endMs: null, bars: [] };
  const nowMs = now === undefined ? null : toMs(now);
  let lastKnown = 0;
  for (const a of mine) lastKnown = Math.max(lastKnown, parseMs(a.endedAt) ?? 0, parseMs(a.startedAt) ?? 0);
  const bars = mine.map((a) => {
    const startMs = /** @type {number} */ (parseMs(a.startedAt));
    const ended = parseMs(a.endedAt);
    const endMs = ended ?? (a.status === "running" ? Math.max(startMs, nowMs ?? lastKnown) : Math.max(startMs, lastKnown));
    return {
      slot: a.slot ?? 0, agentId: a.agentId, label: `${a.role ?? a.kind ?? a.agentId}${a.taskId ? ` ${a.taskId}` : ""}`,
      startMs, endMs, status: a.status,
    };
  }).sort((x, y) => x.slot - y.slot || x.startMs - y.startMs || (x.agentId < y.agentId ? -1 : 1));
  return {
    runId,
    startMs: Math.min(...bars.map((b) => b.startMs)),
    endMs: Math.max(...bars.map((b) => b.endMs)),
    bars,
  };
}

/**
 * Work waiting on a human: INBOX questions · `needs-human` tasks · `todo` tasks behind a money/migration gate ·
 * orphan worktrees (no task with that id, or the task is `done` — same rule as `orphanWorktrees` in worker.mjs,
 * copied here so this module does not depend on fs).
 * @param {Partial<Snapshot>|null} [snapshot]
 * @returns {{questions: {count: number, items: string[]}, needsHuman: {id: string, title: string}[],
 *   gated: {id: string, title: string, gate: string}[], orphanWorktrees: string[]}}
 */
export function waiting(snapshot) {
  const snap = normalizeSnapshot(snapshot);
  const byId = (/** @type {{id: string}} */ a, /** @type {{id: string}} */ b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const status = new Map(snap.tasks.map((t) => [t.id, t.status]));
  return {
    questions: { count: snap.inbox.questions, items: [...snap.inbox.items] },
    needsHuman: snap.tasks.filter((t) => t.status === "needs-human").map(({ id, title }) => ({ id, title })).sort(byId),
    gated: snap.tasks
      .filter((t) => t.status === "todo" && (t.gate === "money" || t.gate === "migration"))
      .map((t) => ({ id: t.id, title: t.title, gate: /** @type {string} */ (t.gate) })).sort(byId),
    orphanWorktrees: snap.worktrees.filter((id) => {
      const s = status.get(id);
      return s === undefined || s === "done";
    }).sort(),
  };
}

/**
 * @typedef {object} AttemptVerify
 * @property {boolean} ok
 * @property {import("./events.mjs").VerifyCheck[]|null} checks null when the event carries no `checks`
 * @property {string|null} failTail
 * @property {string|null} reason
 */

/**
 * One attempt of a task: the agents running between two `verify.result`s (subagents follow their parent's attempt) and the
 * verify that closes it; `verify` null = the last attempt has not been verified yet.
 * @typedef {object} Attempt
 * @property {number} n starts at 1
 * @property {string|null} startedAt
 * @property {string|null} endedAt null while an agent is still running or lost
 * @property {number|null} durationMs running: `now - startedAt`; signal lost: null
 * @property {number} tokens input + output + cacheRead + cacheWrite, summed over every call of the agents
 * @property {number} output tokens written by the model (A-050) — comparable to "tokens" in an interactive session
 * @property {number|null} costUsd sum of `costUsd` (equivalent); null when no agent has a price
 * @property {number|null} peakContext largest context among the attempt's agents; null when an older ledger did not record it
 * @property {string[]} agents
 * @property {AttemptVerify|null} verify
 */

/** @typedef {{kind: "same-failure", cmd: string, count: number}} Diagnosis */
/** @typedef {"running"|"ok"|"failed"|"waiting"} RunStatus */

/**
 * @typedef {object} TaskRun
 * @property {string} taskId
 * @property {string|null} title from the backlog snapshot; null when the snapshot lacks the task
 * @property {number|null} slot
 * @property {RunStatus} status
 * @property {Attempt[]} attempts
 * @property {Diagnosis|null} diagnosis
 */

/** @param {AttemptVerify|null} v @returns {string|null} "same failure" key: the first red command, or `reason` when there are no `checks` */
function failureKey(v) {
  if (v === null || v.ok) return null;
  const red = v.checks?.find((c) => !c.ok && c.skipped !== true);
  return red?.cmd ?? v.reason ?? null;
}

/**
 * Diagnosis from attempts: a trailing streak of consecutive RED attempts (verified ones only) with the same failure key and length
 * ≥ 2 → `same-failure`. A green attempt breaks the streak. Without `checks`, `reason` is compared (`cmd` is then the reason).
 * @param {Attempt[]} attempts @returns {Diagnosis|null}
 */
export function diagnose(attempts) {
  const verified = attempts.filter((a) => a.verify !== null);
  const key = failureKey(verified.at(-1)?.verify ?? null);
  if (key === null) return null;
  let run = 0;
  for (let i = verified.length - 1; i >= 0 && failureKey(verified[i].verify) === key; i -= 1) run += 1;
  return run >= 2 ? { kind: "same-failure", cmd: key, count: run } : null;
}

/**
 * @param {number} n @param {AgentRow[]} rows @param {AgentEvent|null} v the verify.result closing the attempt
 * @param {number} nowMs @returns {Attempt}
 */
function makeAttempt(n, rows, v, nowMs) {
  const iso = (/** @type {number|null} */ ms) => (ms === null ? null : new Date(ms).toISOString());
  const starts = rows.map((a) => parseMs(a.startedAt)).filter((ms) => ms !== null);
  const verifyMs = v === null ? null : parseMs(v.ts);
  const startMs = starts.length > 0 ? Math.min(...starts) : verifyMs;
  const ends = rows.map((a) => parseMs(a.endedAt)).filter((ms) => ms !== null);
  /** @type {number|null} */
  let endMs;
  /** @type {number|null} */
  let durationMs;
  if (rows.some((a) => a.status === "running")) {
    endMs = null;
    durationMs = startMs === null ? null : Math.max(0, nowMs - startMs);
  } else if (rows.some((a) => a.status === "lost")) {
    endMs = null;
    durationMs = null;
  } else {
    endMs = ends.length > 0 ? Math.max(...ends) : verifyMs;
    durationMs = startMs === null || endMs === null ? null : Math.max(0, endMs - startMs);
  }
  let tokens = 0;
  let output = 0;
  /** @type {number|null} */
  let costUsd = null;
  /** @type {number|null} */
  let peakContext = null;
  for (const a of rows) {
    if (a.usage !== null) {
      tokens += totalTokens(a.usage);
      output += a.usage.output;
    }
    if (a.costUsd !== null) costUsd = roundCost((costUsd ?? 0) + a.costUsd);
    if (a.peakContext !== null) peakContext = Math.max(peakContext ?? 0, a.peakContext);
  }
  return {
    n, startedAt: iso(startMs), endedAt: iso(endMs), durationMs, tokens, output, costUsd, peakContext,
    agents: rows.map((a) => a.agentId),
    verify: v === null ? null : { ok: v.ok === true, checks: v.checks ?? null, failTail: v.failTail ?? null, reason: v.reason ?? null },
  };
}

/**
 * Tasks of a run, each with its sequence of attempts. Agents (conductor excluded) are grouped by `taskId` — a subagent
 * without `taskId` inherits its parent's; attempts are split at each `verify.result` of the task: agents starting at or
 * after the verify belong to the next attempt, subagents follow the attempt of their top-most parent. A verify without agents
 * is still an attempt. Last attempt not yet verified → `verify: null`.
 *
 * Task status: an agent running in the last attempt → `running`; snapshot `needs-human` → `waiting`; last attempt
 * verified → `ok`/`failed` per verify; not verified but has a `failed`/`lost` agent → `failed`; otherwise (agents
 * done, awaiting verify) → `running` (task `done` in the snapshot → `ok`).
 * Ordered by the start of the first attempt, ties by id. `runId` null → empty.
 * @param {AgentRow[]} agents @param {AgentEvent[]} events @param {string|null} runId
 * @param {{now?: number|Date, snapshot?: Partial<Snapshot>|null}} [opts]
 * @returns {TaskRun[]}
 */
export function taskRuns(agents, events, runId, { now, snapshot = null } = {}) {
  if (runId === null) return [];
  const nowMs = toMs(now);
  const meta = new Map(normalizeSnapshot(snapshot).tasks.map((t) => [t.id, t]));
  const inRun = agentsInRun(agents, runId).filter((a) => a.kind !== "conductor");
  const byId = new Map(inRun.map((a) => [a.agentId, a]));

  // Effective taskId: the agent's own, else walk up the parent chain (cycle-safe via `seen`).
  /** @type {Map<string, string|null>} */
  const taskOf = new Map();
  for (const a of inRun) {
    const seen = new Set();
    /** @type {AgentRow|undefined} */
    let cur = a;
    while (cur && cur.taskId === null && !seen.has(cur.agentId)) {
      seen.add(cur.agentId);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    taskOf.set(a.agentId, cur?.taskId ?? null);
  }
  // Top-most agent of the parent chain with the SAME task — decides which attempt the agent belongs to.
  const topOf = (/** @type {AgentRow} */ a) => {
    const seen = new Set([a.agentId]);
    let cur = a;
    for (;;) {
      const p = cur.parentId === null ? undefined : byId.get(cur.parentId);
      if (!p || seen.has(p.agentId) || taskOf.get(p.agentId) !== taskOf.get(a.agentId)) return cur;
      seen.add(p.agentId);
      cur = p;
    }
  };

  /** @type {Map<string, {rows: AgentRow[], verifies: {ms: number, e: AgentEvent}[]}>} */
  const groups = new Map();
  const group = (/** @type {string} */ id) => {
    let g = groups.get(id);
    if (!g) {
      g = { rows: [], verifies: [] };
      groups.set(id, g);
    }
    return g;
  };
  for (const a of inRun) {
    const id = taskOf.get(a.agentId) ?? null;
    if (id !== null) group(id).rows.push(a);
  }
  for (const e of events) {
    if (e.type !== "verify.result" || typeof e.taskId !== "string" || (e.runId ?? null) !== runId) continue;
    group(e.taskId).verifies.push({ ms: parseMs(e.ts) ?? 0, e });
  }

  /** @type {{run: TaskRun, firstMs: number}[]} */
  const out = [];
  for (const [taskId, g] of groups) {
    const verifies = g.verifies.map((v, i) => ({ ...v, i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
    const buckets = Array.from({ length: verifies.length + 1 }, () => /** @type {AgentRow[]} */ ([]));
    for (const a of g.rows) {
      const top = parseMs(topOf(a).startedAt) ?? 0;
      let idx = 0;
      while (idx < verifies.length && verifies[idx].ms <= top) idx += 1;
      buckets[idx].push(a);
    }
    /** @type {Attempt[]} */
    const attempts = [];
    /** @type {AgentRow[]} */
    let lastRows = [];
    for (const [i, rows] of buckets.entries()) {
      const v = verifies[i]?.e ?? null;
      if (rows.length === 0 && v === null) continue;
      rows.sort((a, b) => (parseMs(a.startedAt) ?? 0) - (parseMs(b.startedAt) ?? 0) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
      attempts.push(makeAttempt(attempts.length + 1, rows, v, nowMs));
      lastRows = rows;
    }
    const m = meta.get(taskId);
    const lastVerify = attempts.at(-1)?.verify ?? null;
    /** @type {RunStatus} */
    let status;
    if (lastRows.some((a) => a.status === "running")) status = "running";
    else if (m?.status === "needs-human") status = "waiting";
    else if (lastVerify !== null) status = lastVerify.ok ? "ok" : "failed";
    else if (lastRows.some((a) => a.status === "failed" || a.status === "lost")) status = "failed";
    else status = m?.status === "done" ? "ok" : "running";
    const slot = g.rows.find((a) => a.slot !== null)?.slot ?? verifies.map((v) => v.e.slot).find((s) => typeof s === "number") ?? null;
    out.push({
      run: { taskId, title: m?.title ?? null, slot, status, attempts, diagnosis: diagnose(attempts) },
      firstMs: parseMs(attempts[0]?.startedAt ?? null) ?? Infinity,
    });
  }
  return out.sort((a, b) => a.firstMs - b.firstMs || (a.run.taskId < b.run.taskId ? -1 : a.run.taskId > b.run.taskId ? 1 : 0)).map((o) => o.run);
}

/** @typedef {{kind: "failed"|"question"|"needs-human"|"gated"|"orphan", id: string, text: string, anchor: string}} AttentionItem */

/** @param {TaskRun} run @returns {string} */
function failedText(run) {
  if (run.diagnosis) return `${run.taskId} · red ${run.diagnosis.count} attempts in a row with the same failure: ${run.diagnosis.cmd}`;
  return `${run.taskId} · ${run.attempts.at(-1)?.verify?.reason ?? "last attempt red or signal lost"}`;
}

/**
 * The "needs you" strip: everything waiting on a human, by urgency — red task > INBOX question > `needs-human` > money/migration
 * gate > orphan worktree; by id within each kind. `anchor`: `task:<id>` for a red task (jumps to the task
 * in the attempts list), `waiting` for the others (jumps to the waiting-on-human block).
 * Red tasks = `runs` tasks with `status` failed (skipped when the snapshot already says `done`) + `failed` tasks in the snapshot
 * (the state machine only lets a human move `failed` on).
 * @param {Partial<Snapshot>|null} snapshot @param {TaskRun[]} runs @returns {AttentionItem[]}
 */
export function attention(snapshot, runs) {
  const snap = normalizeSnapshot(snapshot);
  const wait = waiting(snapshot);
  const status = new Map(snap.tasks.map((t) => [t.id, t]));
  /** @type {Map<string, string>} */
  const failed = new Map();
  for (const r of runs) if (r.status === "failed" && status.get(r.taskId)?.status !== "done") failed.set(r.taskId, failedText(r));
  for (const t of snap.tasks) if (t.status === "failed" && !failed.has(t.id)) failed.set(t.id, `${t.id} · ${t.title} — task is failed, waiting for you to retry or release`);

  /** @type {AttentionItem[]} */
  const items = [...failed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, text]) => ({ kind: "failed", id, text, anchor: `task:${id}` }));
  for (const q of wait.questions.items) items.push({ kind: "question", id: q.split(" · ")[0], text: q, anchor: "waiting" });
  const extra = wait.questions.count - wait.questions.items.length;
  if (extra > 0) items.push({ kind: "question", id: "inbox", text: `${extra} more question(s) in INBOX`, anchor: "waiting" });
  for (const t of wait.needsHuman) items.push({ kind: "needs-human", id: t.id, text: `${t.id} · ${t.title} — waiting for your confirmation`, anchor: "waiting" });
  for (const t of wait.gated) items.push({ kind: "gated", id: t.id, text: `${t.id} · ${t.title} — ${t.gate} gate, waiting for your approval`, anchor: "waiting" });
  for (const id of wait.orphanWorktrees) items.push({ kind: "orphan", id, text: `Orphan worktree ${id}`, anchor: "waiting" });
  return items;
}

/**
 * Full dashboard state — what the server returns at `/api/state`.
 * Cards: `running` = agents running (conductor excluded) · `workers` = max slots (`workers`, null if
 * unknown) · `tasksOk`/`tasksFailed` = tasks of the newest run finished green / red · `attempts` = total attempts
 * of those tasks · `runStartMs`/`runEndMs` = first/last timestamp of the run (null without agents) · `tokensRun` =
 * tokens of the newest run · `tokensToday` = tokens of agents finished on the LOCAL day of `now` · `tokensTotal` =
 * tokens of all finished agents (per `sinceMs`) · `waiting` = total items waiting on a human.
 * A-050: `tokens*` accumulate cache reads across every call, so they are not comparable to an interactive session — the page shows
 * `outputRun`/`outputToday` (tokens written by the model) and `costRun`/`costToday`/`costTotal` (USD equivalent, null when
 * no agent has a price). `tokens*` are kept for older JSON readers.
 * `runs` and `attention` are pre-aggregated for the page — the page only draws.
 * @param {AgentEvent[]} events @param {Partial<Snapshot>|null} snapshot
 * @param {{isAlive: (pid: number) => boolean, now: number|Date, workers?: number|null, warnPerTask?: number|null,
 *   sinceMs?: number|null, plan?: unknown}} ctx
 */
export function buildState(events, snapshot, { isAlive, now, workers = null, warnPerTask = null, sinceMs = null, plan = null }) {
  const nowMs = toMs(now);
  const agents = foldAgents(events, { isAlive, now: nowMs });
  const runId = latestRunId(events);
  const usage = usageBy(agents, { sinceMs, warnPerTask });
  const wait = waiting(snapshot);
  const today = localDay(nowMs);

  let tokensToday = 0;
  let tokensRun = 0;
  let outputToday = 0;
  let outputRun = 0;
  /** @type {number|null} */
  let costToday = null;
  /** @type {number|null} */
  let costRun = null;
  const plus = (/** @type {number|null} */ sum, /** @type {number|null} */ x) => (x === null ? sum : roundCost((sum ?? 0) + x));
  for (const a of agents) {
    if (a.usage === null) continue;
    const t = totalTokens(a.usage);
    const at = parseMs(a.endedAt ?? a.startedAt);
    if (at !== null && localDay(at) === today) {
      tokensToday += t;
      outputToday += a.usage.output;
      costToday = plus(costToday, a.costUsd);
    }
    if (runId !== null && a.runId === runId) {
      tokensRun += t;
      outputRun += a.usage.output;
      costRun = plus(costRun, a.costUsd);
    }
  }

  const runs = taskRuns(agents, events, runId, { now: nowMs, snapshot });
  const span = timeline(agents, runId, { now: nowMs });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    cards: {
      running: agents.filter((a) => a.status === "running" && a.kind !== "conductor").length,
      workers,
      tasksOk: runs.filter((r) => r.status === "ok").length,
      tasksFailed: runs.filter((r) => r.status === "failed").length,
      attempts: runs.reduce((n, r) => n + r.attempts.length, 0),
      runStartMs: span.startMs,
      runEndMs: span.endMs,
      tokensRun,
      tokensToday,
      tokensTotal: usage.total.tokens,
      outputRun,
      outputToday,
      costRun,
      costToday,
      costTotal: usage.total.costUsd,
      waiting: wait.questions.count + wait.needsHuman.length + wait.gated.length + wait.orphanWorktrees.length,
    },
    agents,
    tree: buildTree(agents, events, snapshot),
    timeline: span,
    usage,
    waiting: wait,
    runs,
    attention: attention(snapshot, runs),
    plan,
  };
}
