// @ts-check
/**
 * SubagentStart / SubagentStop hook (A-038) — records subagents a Claude Code session calls (via the
 * Agent tool) in the dashboard's event log: `agent.start` when a subagent opens, `agent.end` when it finishes,
 * tokens summed from the subagent's own transcript (`agent_transcript_path`).
 *
 * If the session is a conductor child process (`runClaude` passes AGENT_QUEUE_AGENT_ID), the subagent hangs
 * under that parent agent in the tree; otherwise under `session-<session_id>`.
 *
 * Three rules:
 *   - NEVER break the session: always exit 0, never block a subagent. Bad payload, unwritable log,
 *     missing transcript → at most one stderr line.
 *   - STDOUT ALWAYS EMPTY: SubagentStart's stdout is injected into the subagent's context.
 *   - NO SECRETS: never records the prompt, `last_assistant_message`, env — `makeEvent` keeps only declared fields.
 *
 * Does NOT read AGENT_QUEUE_DISABLE: conductor child sessions must record subagents too. Disable with
 * AGENT_QUEUE_EVENTS=0 (disables the whole log).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendEvent, eventsFile, makeEvent, readEvents, transcriptUsage } from "../scripts/events.mjs";

/** Window for finding the `agent.start` with the same `agentId` to compute duration. */
const START_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Transcript read chunk — never load the whole file into memory. */
const CHUNK_BYTES = 64 * 1024;
/** Max depth when walking up the process tree. */
const MAX_PROC_DEPTH = 16;

/**
 * @typedef {{input: number, output: number, cacheRead: number, cacheWrite: number}} Usage
 * @typedef {{usage: Usage, model: string|null, numTurns: number}} TranscriptUsage
 * @typedef {{pid?: number|null, durationMs?: number|null}} Extra
 * @typedef {{ppid: number, args: string[]}} ProcInfo
 */

/** @param {unknown} v @returns {string} trimmed string, or "" */
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * PURE FUNCTION. Hook payload → event, or null (nothing written).
 * null when: payload is not an object, unknown hook type, empty `agent_type` (Claude Code internal agents:
 * prompt suggestions, `/btw`…), or missing `agent_id`.
 * @param {unknown} payload parsed stdin
 * @param {NodeJS.ProcessEnv} env
 * @param {Date|number} now
 * @param {TranscriptUsage|null} [usage] `transcriptUsage` result (SubagentStop only); null = unreadable → the event records usage/numTurns null
 * @param {Extra} [extra]
 * @returns {import("../scripts/events.mjs").AgentEvent|null}
 */
export function toEvent(payload, env, now, usage = null, extra = {}) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const hook = str(p.hook_event_name);
  if (hook !== "SubagentStart" && hook !== "SubagentStop") return null;
  const role = str(p.agent_type);
  const agentId = str(p.agent_id);
  if (role === "" || agentId === "") return null;

  const session = str(p.session_id);
  const sessionNode = session === "" ? null : `session-${session}`;
  const common = {
    runId: str(env.AGENT_QUEUE_RUN_ID) || sessionNode,
    agentId,
    parentId: str(env.AGENT_QUEUE_AGENT_ID) || sessionNode,
    kind: "subagent",
    role,
    pid: extra.pid ?? null,
  };
  if (hook === "SubagentStart") return makeEvent("agent.start", common, now);
  return makeEvent("agent.end", {
    ...common,
    model: usage?.model ?? null,
    // A subagent has no exit code; SubagentStop means it returned its result to the parent session.
    exitCode: 0,
    durationMs: extra.durationMs ?? null,
    // Unreadable usage = UNKNOWN, recorded as null (A-091) — not four zeros as if the subagent cost nothing.
    usage: usage?.usage ?? null,
    numTurns: usage?.numTurns ?? null,
  }, now);
}

/**
 * Read a file line by line, in 64 KB chunks. Joins BYTES before decoding UTF-8 — a chunk boundary inside a
 * multi-byte character doesn't corrupt the line. File can't be opened → no lines.
 * @param {string} file @returns {Generator<string>}
 */
export function* readLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    /** @type {Buffer[]} */
    let pending = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      let start = 0;
      for (let i = 0; i < n; i += 1) {
        if (buf[i] !== 0x0a) continue;
        pending.push(Buffer.from(buf.subarray(start, i)));
        yield Buffer.concat(pending).toString("utf8");
        pending = [];
        start = i + 1;
      }
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length > 0) yield Buffer.concat(pending).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * PURE FUNCTION. Is this command line a Claude Code process?
 * The native install runs as `…/claude/versions/<x.y.z>` (exactly what macOS `ps` shows); the npm install is
 * `node …/claude` or `node …/@anthropic-ai/claude-code/cli.js`.
 * @param {string[]} args
 */
export function isClaudeCommand(args) {
  const [exe = "", script = ""] = args;
  const base = path.basename(exe).toLowerCase();
  if (base === "claude" || base === "claude.exe") return true;
  if (/[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe)) return true;
  if (base === "node" || base === "node.exe") return /(^|[\\/])claude(-code)?([\\/]|$)/.test(script);
  return false;
}

/**
 * Walk up the process tree from `startPid` to the first Claude Code process. Not found → null.
 * @param {number} startPid @param {(pid: number) => ProcInfo|null} readProc
 * @returns {number|null}
 */
export function findClaudePid(startPid, readProc) {
  let pid = startPid;
  for (let depth = 0; depth < MAX_PROC_DEPTH && pid > 1; depth += 1) {
    const info = readProc(pid);
    if (!info) return null;
    if (isClaudeCommand(info.args)) return pid;
    pid = info.ppid;
  }
  return null;
}

/**
 * Process info: on Linux read `/proc`, elsewhere call `ps`. Error → null.
 * @param {number} pid @returns {ProcInfo|null}
 */
export function readProc(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 2 (comm) is parenthesised and may contain spaces → cut after the last `)`.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a) => a !== "");
      return Number.isInteger(ppid) ? { ppid, args } : null;
    }
    const r = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout ?? "").trim());
    return m ? { ppid: Number(m[1]), args: m[2].split(/\s+/) } : null;
  } catch {
    return null;
  }
}

/**
 * Duration since the latest `agent.start` with the same `agentId` in the log; none → null.
 * @param {string} file @param {string} agentId @param {number} nowMs
 */
function durationFromLedger(file, agentId, nowMs) {
  const starts = readEvents(file, { sinceMs: nowMs - START_LOOKBACK_MS })
    .filter((e) => e.type === "agent.start" && e.agentId === agentId);
  const last = starts.at(-1);
  if (!last) return null;
  const ms = Date.parse(last.ts);
  return Number.isNaN(ms) ? null : Math.max(0, nowMs - ms);
}

/**
 * @typedef {object} Deps
 * @property {() => number} [now]
 * @property {(message: string) => void} [warn]
 * @property {() => number|null} [claudePid]
 */

/**
 * Never throws, always returns 0, prints nothing to stdout.
 * @param {string} stdin @param {NodeJS.ProcessEnv} env @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function main(stdin, env, deps = {}) {
  const warn = deps.warn ?? ((/** @type {string} */ m) => process.stderr.write(`[subagent-events] ${m}\n`));
  try {
    /** @type {unknown} */
    let payload;
    try {
      payload = JSON.parse(stdin);
    } catch {
      warn("stdin payload is not JSON — ignored");
      return 0;
    }
    const nowMs = (deps.now ?? Date.now)();
    // Filter early (internal agents, unknown hooks) before reading the transcript or probing processes.
    if (toEvent(payload, env, nowMs) === null) return 0;

    const root = env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = eventsFile(root, env);
    if (!file) return 0;

    const p = /** @type {Record<string, unknown>} */ (payload);
    const pid = (deps.claudePid ?? (() => findClaudePid(process.ppid, readProc)))();
    /** @type {TranscriptUsage|null} */
    let usage = null;
    /** @type {number|null} */
    let durationMs = null;
    if (p.hook_event_name === "SubagentStop") {
      const transcript = str(p.agent_transcript_path);
      // Transcript with no path / unopenable / no assistant message yet → unknown (null), not 0.
      const read = transcript === "" ? null : transcriptUsage(readLines(transcript));
      usage = read !== null && read.numTurns > 0 ? read : null;
      durationMs = durationFromLedger(file, str(p.agent_id), nowMs);
    }
    const event = toEvent(payload, env, nowMs, usage, { pid, durationMs });
    if (event) appendEvent(file, event, { warn });
  } catch (e) {
    try {
      warn(`unexpected error, ignored: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // The warning must not break the session either.
    }
  }
  return 0;
}

// Run when executed directly; not when imported by tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    // Broken stdin → empty payload, main ignores it.
  }
  process.exit(await main(raw, process.env));
}
