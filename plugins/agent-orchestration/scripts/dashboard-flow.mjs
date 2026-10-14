// @ts-check
/**
 * The "Flow" panel of the agent dashboard (requirements/bang-dieu-khien-agent-luong-dong.md) — the STATIC SHAPE:
 * swimlanes, nodes, edges, coordinates. Same ledger + same parameters → the same `{lanes, nodes, edges, width, height}` down
 * to every number, so nodes do not jump around during replay.
 *
 * PURE FUNCTIONS: no fs, no `process`, no system clock. `now` and `isAlive` are injected by the caller and only
 * pass through `foldAgents` (node status comes from there).
 *
 * Reading rules:
 *   - Line order in the ledger is not trusted: every ordering in the result derives from `ts` (events) or
 *     `startedAt` then `agentId` (agents) — shuffling lines while keeping `ts` leaves coordinates unchanged.
 *   - Broken events (not an object, unknown `schemaVersion`, missing/bad `ts`) are dropped, never thrown.
 *   - `x`/`y` are a node's top-left corner; node size lives in `FLOW_GRID` (integers, fixed grid).
 *     `y` grows downwards: a subagent has a LARGER `y` than its parent.
 */

import { SCHEMA_VERSION } from "./events.mjs";
import { foldAgents, latestRunId, totalTokens } from "./dashboard.mjs";

/** @typedef {import("./events.mjs").AgentEvent} AgentEvent */
/** @typedef {import("./dashboard.mjs").AgentRow} AgentRow */
/** @typedef {import("./dashboard.mjs").NodeStatus} NodeStatus */
/** @typedef {"conductor"|"planner"|"seq"|`slot-${number}`|"fixer"|"integrator"} LaneId */
/** @typedef {{id: LaneId, label: string, y: number, height: number}} FlowLane */
/**
 * depth 0 = an agent of the run, 1+ = subagent. `parentId` is the parent IN THE GRAPH: the parent node for a subagent, or the
 * conductor node for a top-level agent; null for the conductor and the integrator.
 * @typedef {{id: string, lane: LaneId, kind: "conductor"|"planner"|"role"|"subagent"|"integrator",
 *   agentId: string|null, parentId: string|null, taskId: string|null, role: string|null, model: string|null,
 *   status: NodeStatus, startedAt: string|null, durationMs: number|null, tokens: number|null,
 *   x: number, y: number, depth: number}} FlowNode
 */
/** @typedef {{id: string, from: string, to: string, kind: "assign"|"spawn"|"handoff"|"integrate"}} FlowEdge */

/** Fixed grid (px). Column 0 is the conductor, each lane's top-level agents start at column 1, the integrator is in the last column. */
export const FLOW_GRID = Object.freeze({
  gutter: 120, padX: 24, padY: 12, colW: 200, nodeW: 160, nodeH: 40, rowH: 56, depthDx: 12, maxIndent: 3,
});

/** Caps the lane count when the ledger has absurd `slot`s; a slot outside [1, MAX_SLOT] counts as no slot (lane `seq`). */
const MAX_SLOT = 64;

/** @param {unknown} n @returns {number|null} */
const slotOf = (n) => (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_SLOT ? n : null);

/** @param {unknown} v @returns {string|null} */
const idOf = (v) => (typeof v === "string" && v !== "" ? v : null);

/** @param {string|null} iso @returns {number|null} */
function msOf(iso) {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Keeps readable events: object, right schema, with `type` and a parseable `ts`. @param {unknown} events @returns {AgentEvent[]} */
function usable(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e)
    && e.schemaVersion === SCHEMA_VERSION && typeof e.type === "string" && typeof e.ts === "string"
    && !Number.isNaN(Date.parse(e.ts)));
}

/**
 * Events of one run: events carrying that `runId`, plus events of descendants via `parentId` (a subagent inside a
 * session may carry another `runId` or none) — same scoping rule as `buildTree`. Sorted by `ts`; ties keep
 * line order. Empty/null `runId` → [].
 * @param {AgentEvent[]} events @param {string|null|undefined} runId @returns {AgentEvent[]}
 */
export function runScope(events, runId) {
  if (typeof runId !== "string" || runId === "") return [];
  const list = usable(events);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const e of list) {
    const id = idOf(e.agentId);
    if (e.runId === runId && id !== null) ids.add(id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const e of list) {
      const id = idOf(e.agentId);
      if (id === null || ids.has(id)) continue;
      const parent = idOf(e.parentId);
      if (parent !== null && ids.has(parent)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return list
    .filter((e) => {
      const id = idOf(e.agentId);
      return e.runId === runId || (id !== null && ids.has(id));
    })
    .map((e) => ({ e, ms: Date.parse(e.ts) }))
    .sort((a, b) => a.ms - b.ms)
    .map((x) => x.e);
}

/** @param {AgentRow} a @returns {LaneId} lane of a top-level agent; subagents follow their parent */
function laneOfRoot(a) {
  if (a.kind === "conductor") return "conductor";
  if (a.kind === "planner") return "planner";
  if (a.role === "fixer") return "fixer";
  const s = slotOf(a.slot);
  return s === null ? "seq" : `slot-${s}`;
}

/**
 * @param {{events: AgentEvent[], runId?: string|null, workers?: number|null,
 *   isAlive: (pid: number) => boolean, now: number|Date}} args
 * @returns {{lanes: FlowLane[], nodes: FlowNode[], edges: FlowEdge[], width: number, height: number}}
 */
export function layoutFlow({ events, runId, workers, isAlive, now }) {
  const { gutter, padX, padY, colW, nodeW, nodeH, rowH, depthDx, maxIndent } = FLOW_GRID;
  const clean = usable(events);
  const run = idOf(runId) ?? latestRunId(clean);
  const scoped = runScope(clean, run);
  const rows = foldAgents(scoped, { isAlive, now });

  // Conductor: the agent of kind "conductor" if any, else the `agentId` of run.start, else "conductor".
  const runStart = scoped.find((e) => e.type === "run.start" && e.runId === run && idOf(e.agentId) !== null) ?? null;
  const runEnd = scoped.find((e) => e.type === "run.end" && e.runId === run) ?? null;
  const conductorRow = rows.find((r) => r.kind === "conductor") ?? null;
  const conductorId = conductorRow?.agentId ?? idOf(runStart?.agentId) ?? "conductor";
  const agents = rows.filter((r) => r !== conductorRow && r.agentId !== conductorId);

  // Parent-child tree between agents; parent is the conductor or out of scope → top-level agent.
  const byId = new Set(agents.map((a) => a.agentId));
  /** @type {Map<string, string>} */
  const parentOf = new Map();
  for (const a of agents) {
    if (a.parentId !== null && a.parentId !== a.agentId && byId.has(a.parentId)) parentOf.set(a.agentId, a.parentId);
  }
  // Parent-child cycle (broken ledger): cut the closing link, following the sorted agent order so the result is deterministic.
  for (const a of agents) {
    const seen = new Set([a.agentId]);
    let cur = a.agentId;
    for (let up = parentOf.get(cur); up !== undefined; up = parentOf.get(cur)) {
      if (seen.has(up)) {
        parentOf.delete(cur);
        break;
      }
      seen.add(up);
      cur = up;
    }
  }
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const a of agents) {
    const p = parentOf.get(a.agentId);
    if (p === undefined) continue;
    const list = children.get(p);
    if (list) list.push(a.agentId);
    else children.set(p, [a.agentId]);
  }
  const roots = agents.filter((a) => !parentOf.has(a.agentId));

  // Grid position: each top-level agent gets one column in its lane (by start order), subagents stack under their parent
  // in pre-order traversal.
  /** @type {Map<string, {lane: LaneId, col: number, row: number, depth: number}>} */
  const place = new Map();
  /** @type {Map<LaneId, number>} */
  const nextCol = new Map();
  /** @type {Map<LaneId, number>} */
  const rowsUsed = new Map();
  for (const root of roots) {
    const lane = laneOfRoot(root);
    const col = nextCol.get(lane) ?? 1;
    nextCol.set(lane, col + 1);
    let row = 0;
    /** @type {[string, number][]} */
    const stack = [[root.agentId, 0]];
    for (let top = stack.pop(); top; top = stack.pop()) {
      place.set(top[0], { lane, col, row, depth: top[1] });
      row += 1;
      const kids = children.get(top[0]) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], top[1] + 1]);
    }
    rowsUsed.set(lane, Math.max(rowsUsed.get(lane) ?? 1, row));
  }

  // Lanes in fixed order. N = max(workers, largest slot in the run's ledger).
  let slots = typeof workers === "number" && Number.isInteger(workers) ? Math.min(Math.max(workers, 0), MAX_SLOT) : 0;
  for (const e of scoped) slots = Math.max(slots, slotOf(e.slot) ?? 0);
  /** @type {[LaneId, string][]} */
  const defs = [["conductor", "Conductor"], ["planner", "Planner"], ["seq", "Sequential"]];
  for (let n = 1; n <= slots; n++) defs.push([`slot-${n}`, `Slot ${n}`]);
  defs.push(["fixer", "Fixer"], ["integrator", "Integrator"]);

  /** @type {FlowLane[]} */
  const lanes = [];
  /** @type {Map<LaneId, FlowLane>} */
  const laneById = new Map();
  let height = 0;
  for (const [id, label] of defs) {
    const laneHeight = 2 * padY + ((rowsUsed.get(id) ?? 1) - 1) * rowH + nodeH;
    const lane = { id, label, y: height, height: laneHeight };
    lanes.push(lane);
    laneById.set(id, lane);
    height += laneHeight;
  }

  /** @param {LaneId} lane @param {number} col @param {number} row @param {number} depth */
  const at = (lane, col, row, depth) => ({
    x: gutter + padX + col * colW + Math.min(depth, maxIndent) * depthDx,
    y: /** @type {FlowLane} */ (laneById.get(lane)).y + padY + row * rowH,
  });

  // Edges: first top-level agent of each task ← conductor (assign), later roles of the same task ← the previous role (handoff),
  // parent → subagent (spawn), last role of a `done` task → integrator (integrate).
  /** @type {FlowEdge[]} */
  const edges = [];
  /** @param {string} from @param {string} to @param {FlowEdge["kind"]} kind */
  const link = (from, to, kind) => edges.push({ id: `${from}->${to}`, from, to, kind });
  /** @type {Map<string, string>} */
  const lastOfTask = new Map();
  for (const a of roots) {
    const prev = a.taskId === null ? undefined : lastOfTask.get(a.taskId);
    if (prev === undefined) link(conductorId, a.agentId, "assign");
    else link(prev, a.agentId, "handoff");
    if (a.taskId !== null) lastOfTask.set(a.taskId, a.agentId);
  }
  for (const a of agents) {
    const p = parentOf.get(a.agentId);
    if (p !== undefined) link(p, a.agentId, "spawn");
  }
  const doneTasks = new Set(scoped.filter((e) => e.type === "task.transition" && e.to === "done").map((e) => e.taskId));
  for (const [taskId, agentId] of lastOfTask) {
    if (doneTasks.has(taskId)) link(agentId, "integrator", "integrate");
  }

  // Nodes.
  const startedAt = conductorRow?.startedAt ?? runStart?.ts ?? null;
  const startMs = msOf(startedAt);
  const endMs = runEnd === null ? null : msOf(runEnd.ts);
  /** @type {NodeStatus} */
  let conductorStatus = "waiting";
  if (conductorRow) conductorStatus = conductorRow.status;
  else if (runEnd) conductorStatus = "ok";
  else if (runStart || agents.some((a) => a.status === "running")) conductorStatus = "running";

  /** @type {FlowNode[]} */
  const nodes = [{
    id: conductorId, lane: "conductor", kind: "conductor", agentId: conductorRow?.agentId ?? null, parentId: null,
    taskId: null, role: conductorRow?.role ?? null, model: conductorRow?.model ?? null, status: conductorStatus,
    startedAt,
    durationMs: conductorRow?.durationMs ?? (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null),
    tokens: conductorRow?.usage ? totalTokens(conductorRow.usage) : null,
    ...at("conductor", 0, 0, 0), depth: 0,
  }];
  let lastCol = 0;
  for (const a of agents) {
    const p = /** @type {NonNullable<ReturnType<typeof place.get>>} */ (place.get(a.agentId));
    lastCol = Math.max(lastCol, p.col);
    nodes.push({
      id: a.agentId, lane: p.lane,
      kind: p.depth > 0 ? "subagent" : a.kind === "planner" ? "planner" : a.kind === "conductor" ? "conductor" : "role",
      agentId: a.agentId, parentId: parentOf.get(a.agentId) ?? conductorId, taskId: a.taskId, role: a.role, model: a.model,
      status: a.status, startedAt: a.startedAt, durationMs: a.durationMs, tokens: a.usage ? totalTokens(a.usage) : null,
      ...at(p.lane, p.col, p.row, p.depth), depth: p.depth,
    });
  }
  const integratorCol = lastCol + 1;
  nodes.push({
    id: "integrator", lane: "integrator", kind: "integrator", agentId: null, parentId: null, taskId: null, role: null,
    model: null, status: edges.some((e) => e.kind === "integrate") ? "ok" : "waiting", startedAt: null,
    durationMs: null, tokens: null, ...at("integrator", integratorCol, 0, 0), depth: 0,
  });

  return { lanes, nodes, edges, width: at("integrator", integratorCol, 0, 0).x + nodeW + padX, height };
}

/**
 * Page effects. `packet.reverse` = return signal; `dash.on` = toggles the flowing dashed line on an edge with a running agent.
 * @typedef {{type: "show"|"spawn"|"pulse"|"stopPulse"|"shake"|"blink"|"fadeOut", node: string}
 *   | {type: "packet", edge: string, reverse: boolean}
 *   | {type: "dash", edge: string, on: boolean}
 *   | {type: "status", node: string, status: NodeStatus}
 *   | {type: "label", node: string, text: string}
 *   | {type: "badge", text: string}} Effect
 */
/**
 * `seq`/`seqEnd`: index of the frame's first/last event in `runScope`. `at`: ms of the first event ("signal lost" frame: `now`).
 * @typedef {{id: string, seq: number, seqEnd: number, at: number, effects: Effect[]}} Frame
 */

/** Effects with motion: `reducedMotion` drops them all (except `spawn`, which becomes `show` so the node still appears). */
export const MOTION_EFFECTS = ["spawn", "pulse", "shake", "blink", "fadeOut", "packet", "dash"];

const NEEDS_YOU = "needs you";

/**
 * Events of one run → effect frames for the page to replay (requirements/bang-dieu-khien-agent-luong-dong.md).
 * Every effect traces back to an event: a frame's `seq`..`seqEnd` are indexes into `runScope(events, runId)`.
 *
 *   - Node/edge ids come from `layoutFlow` of the WHOLE run, so `pattern.chosen` labels the task's first role node even
 *     though that node only appears later — the page holds the label until the node spawns.
 *   - Batching: consecutive events whose `ts` is ≤ `batchMs` after the group's first event share one frame (fan-out into
 *     several parallel packets). Frames without any effect (e.g. `finding`, `run.end`) are dropped.
 *   - `dash` only toggles on `assign`/`handoff` edges (top-level agents); on/off always come in pairs, even when the agent fails.
 *   - `inbox.changed` with both counts 0 (INBOX just cleared) produces no badge.
 *   - "Signal lost" frames `lost:<agentId>` come LAST, with `seq = seqEnd` = the run's last event (so `seq` never
 *     decreases along the list) and `at = now`. The "signal lost" rule belongs to `foldAgents`; this is just how it is shown.
 *
 * PURE FUNCTION: same input → same output. Emits no events, changes no task status.
 * @param {AgentEvent[]} events
 * @param {{runId?: string|null, isAlive: (pid: number) => boolean, now: number|Date, reducedMotion?: boolean,
 *   batchMs?: number}} opts
 * @returns {Frame[]}
 */
export function eventsToFrames(events, { runId, isAlive, now, reducedMotion = false, batchMs = 1000 }) {
  const run = idOf(runId) ?? latestRunId(usable(events));
  const scoped = runScope(events, run);
  if (scoped.length === 0) return [];
  const { nodes, edges } = layoutFlow({ events, runId: run, workers: null, isAlive, now });
  const nowMs = now instanceof Date ? now.getTime() : now;
  const span = Number.isFinite(batchMs) && batchMs > 0 ? batchMs : 0;

  const conductorId = nodes[0].id;
  const nodeIds = new Set(nodes.map((n) => n.id));
  /** Incoming edge of each node (assign/handoff for top-level agents, spawn for subagents); integrate handled separately. @type {Map<string, FlowEdge>} */
  const inEdge = new Map();
  /** @type {Map<string, string|null>} */
  const taskOfNode = new Map(nodes.map((n) => [n.id, n.taskId]));
  /** @type {Map<string, FlowEdge>} */
  const integrateOf = new Map();
  for (const e of edges) {
    if (e.kind !== "integrate") inEdge.set(e.to, e);
    else {
      const taskId = taskOfNode.get(e.from);
      if (taskId !== undefined && taskId !== null) integrateOf.set(taskId, e);
    }
  }
  /** First and last role (top-level agents) of each task, node order = start order. @type {Map<string, string>} */
  const firstOfTask = new Map();
  /** @type {Map<string, string>} */
  const lastOfTask = new Map();
  for (const n of nodes) {
    if (n.taskId === null || n.depth !== 0) continue;
    if (!firstOfTask.has(n.taskId)) firstOfTask.set(n.taskId, n.id);
    lastOfTask.set(n.taskId, n.id);
  }

  /** @param {AgentEvent} e @returns {Effect[]} */
  const effectsOf = (e) => {
    /** @type {Effect[]} */
    const out = [];
    const agentId = idOf(e.agentId);
    const taskId = idOf(e.taskId);
    switch (e.type) {
      case "run.start":
        out.push({ type: "show", node: conductorId }, { type: "status", node: conductorId, status: "running" });
        break;
      case "pattern.chosen": {
        const text = idOf(e.pattern);
        if (text !== null) out.push({ type: "label", node: (taskId === null ? undefined : firstOfTask.get(taskId)) ?? conductorId, text });
        break;
      }
      case "agent.start": {
        if (agentId === null || !nodeIds.has(agentId)) break;
        const edge = inEdge.get(agentId);
        if (edge === undefined) {
          if (agentId === conductorId) out.push({ type: "show", node: agentId }, { type: "status", node: agentId, status: "running" });
          break;
        }
        out.push({ type: "packet", edge: edge.id, reverse: false }, { type: "spawn", node: agentId }, { type: "pulse", node: agentId });
        if (edge.kind !== "spawn") out.push({ type: "dash", edge: edge.id, on: true });
        break;
      }
      case "agent.end": {
        if (agentId === null || !nodeIds.has(agentId)) break;
        const edge = inEdge.get(agentId);
        const ok = e.exitCode === 0;
        if (ok && edge !== undefined) out.push({ type: "packet", edge: edge.id, reverse: true });
        out.push({ type: "status", node: agentId, status: ok ? "ok" : "failed" });
        if (!ok) out.push({ type: "shake", node: agentId });
        if (edge !== undefined) out.push({ type: "stopPulse", node: agentId });
        if (edge !== undefined && edge.kind !== "spawn") out.push({ type: "dash", edge: edge.id, on: false });
        break;
      }
      case "verify.result": {
        const node = e.ok === false && taskId !== null ? lastOfTask.get(taskId) : undefined;
        if (node !== undefined) out.push({ type: "status", node, status: "failed" }, { type: "shake", node }, { type: "stopPulse", node });
        break;
      }
      case "task.transition":
        if (e.to === "needs-human") out.push({ type: "badge", text: NEEDS_YOU });
        if (e.to === "done" && taskId !== null) {
          const integrate = integrateOf.get(taskId);
          if (integrate !== undefined) out.push({ type: "packet", edge: integrate.id, reverse: false });
          for (const n of nodes) if (n.taskId === taskId) out.push({ type: "fadeOut", node: n.id });
        }
        break;
      case "inbox.changed":
        if (!(e.questions === 0 && e.approvals === 0)) out.push({ type: "badge", text: NEEDS_YOU });
        break;
      default:
    }
    return out;
  };

  /** @type {Frame[]} */
  const frames = [];
  for (let i = 0; i < scoped.length;) {
    const at = Date.parse(scoped[i].ts);
    /** @type {Effect[]} */
    const effects = [];
    let j = i;
    for (; j < scoped.length && (j === i || Date.parse(scoped[j].ts) - at <= span); j++) effects.push(...effectsOf(scoped[j]));
    frames.push({ id: `f${i}`, seq: i, seqEnd: j - 1, at, effects });
    i = j;
  }
  for (const n of nodes) {
    if (n.status !== "lost" || n.agentId === null) continue;
    frames.push({
      id: `lost:${n.agentId}`, seq: scoped.length - 1, seqEnd: scoped.length - 1, at: nowMs,
      effects: [{ type: "status", node: n.id, status: "lost" }, { type: "blink", node: n.id }],
    });
  }

  const motion = /** @type {readonly string[]} */ (MOTION_EFFECTS);
  return frames
    .map((f) => reducedMotion ? { ...f, effects: f.effects.flatMap(calm(motion)) } : f)
    .filter((f) => f.effects.length > 0);
}

/**
 * Runs in the ledger, NEWEST FIRST (same rule as `latestRunId`: later `startedAt` first, ties → larger id first).
 * `startedAt` = earliest `ts` of the run; `endedAt` = `ts` of `run.end` (null while the run is unfinished);
 * `workers` = `workers` of `run.start` (null when not given).
 * @param {AgentEvent[]} events
 * @returns {{runId: string, startedAt: string, endedAt: string|null, workers: number|null}[]}
 */
export function listRuns(events) {
  /** @type {Map<string, {runId: string, startedAt: string, endedAt: string|null, workers: number|null}>} */
  const runs = new Map();
  for (const e of usable(events)) {
    const id = idOf(e.runId);
    if (id === null) continue;
    let run = runs.get(id);
    if (run === undefined) {
      run = { runId: id, startedAt: e.ts, endedAt: null, workers: null };
      runs.set(id, run);
    } else if (Date.parse(e.ts) < Date.parse(run.startedAt)) run.startedAt = e.ts;
    if (e.type === "run.end" && (run.endedAt === null || Date.parse(e.ts) > Date.parse(run.endedAt))) run.endedAt = e.ts;
    if (e.type === "run.start" && typeof e.workers === "number" && Number.isInteger(e.workers) && e.workers >= 0) run.workers = e.workers;
  }
  return [...runs.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

/**
 * Payload for `GET /api/flow`: layout + frames + events of ONE run. `runId` omitted → newest run; ledger without runs →
 * `runId: null` with empty arrays; `runId` not in the ledger → `null` (the server turns it into 404).
 * `after` (integer ≥ -1, default -1): only returns `events` whose `runScope` index is > `after` and `frames` with `seq > after`;
 * `lost:*` frames are always returned (the page dedupes by `id`); `layout` is always complete since new nodes can appear.
 * PURE FUNCTION: no fs, no clock — `now`/`isAlive` are injected by the caller.
 * @param {AgentEvent[]} events
 * @param {{runId?: string|null, after?: number|null, reducedMotion?: boolean, isAlive: (pid: number) => boolean,
 *   now: number|Date, workers?: number|null}} opts
 * @returns {{runId: string|null, runs: ReturnType<typeof listRuns>, layout: ReturnType<typeof layoutFlow>,
 *   frames: Frame[], events: AgentEvent[]}|null}
 */
export function flowFor(events, { runId, after, reducedMotion = false, isAlive, now, workers = null }) {
  const runs = listRuns(events);
  const wanted = idOf(runId);
  if (wanted !== null && !runs.some((r) => r.runId === wanted)) return null;
  const run = wanted ?? runs[0]?.runId ?? null;
  const layout = layoutFlow({ events, runId: run, workers, isAlive, now });
  if (run === null) return { runId: null, runs, layout, frames: [], events: [] };
  const from = typeof after === "number" && Number.isInteger(after) && after >= -1 ? after : -1;
  const frames = eventsToFrames(events, { runId: run, isAlive, now, reducedMotion })
    .filter((f) => f.seq > from || f.id.startsWith("lost:"));
  return { runId: run, runs, layout, frames, events: runScope(events, run).slice(from + 1) };
}

/** `reducedMotion`: `spawn` → `show`, every other motion effect dropped, `status`/`label`/`badge` kept. @param {readonly string[]} motion */
function calm(motion) {
  return (/** @type {Effect} */ x) => {
    if (x.type === "spawn") return [/** @type {Effect} */ ({ type: "show", node: x.node })];
    return motion.includes(x.type) ? [] : [x];
  };
}
