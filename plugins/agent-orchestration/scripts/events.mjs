// @ts-check
/**
 * AGENT EVENT LEDGER — layer 1 of the dashboard (requirements/bang-dieu-khien-agent.md).
 * The single module that defines the event format, safe appends, file rotation, reading back,
 * and two usage parsers: `claude -p` `stream-json` lines and subagent transcripts.
 * Every writer and every reader goes through here.
 *
 * Three rules:
 *   - WRITING NEVER BREAKS THE CALLER: `appendEvent` catches every error, warns exactly once
 *     per process, then stays quiet (the conductor/hooks must not slow down or die because of the ledger).
 *   - NO SECRETS: `makeEvent` keeps only declared fields (no `prompt`, no `env`) and masks
 *     URL passwords in every string; prompts only go through `redactPrompt` (first 200 chars + sha256).
 *   - NO DELETION: a rotated file is renamed to `events-<ISO>.jsonl` and never deleted here
 *     (retention is Q-005).
 *
 * `costUsd` is a client-side estimate ("equivalent"), not a bill.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maskSecrets } from "./worker.mjs";

export const SCHEMA_VERSION = 1;
export const EVENT_TYPES = ["run.start", "run.end", "agent.start", "agent.end", "task.transition",
  "pattern.chosen", "verify.result", "finding", "inbox.changed", "agent.compact", "role.skipped"];
export const AGENT_KINDS = ["conductor", "worker", "role", "planner", "subagent"];
export const MAX_BYTES = 50 * 1024 * 1024;

/** How many leading prompt characters may be stored in the ledger. */
const PROMPT_HEAD_CHARS = 200;

/** @typedef {"chain"|"retry"} ResumeKind */
/** @typedef {{input: number, output: number, cacheRead: number, cacheWrite: number}} Usage */
/** @typedef {{cmd: string, ok: boolean, durationMs: number, skipped?: true}} VerifyCheck */

/** Limits for `verify.result`: `cmd` length and number of trailing `failTail` lines. */
export const MAX_CHECK_CMD_CHARS = 200;
export const MAX_FAIL_TAIL_LINES = 20;

/**
 * @typedef {object} AgentEvent
 * @property {number} schemaVersion
 * @property {string} ts ISO 8601
 * @property {string} type one of EVENT_TYPES
 * @property {string|null} [runId]
 * @property {string|null} [agentId]
 * @property {string|null} [parentId]
 * @property {string|null} [kind] one of AGENT_KINDS
 * @property {string|null} [role]
 * @property {string|null} [model]
 * @property {string|null} [taskId]
 * @property {number|null} [slot]
 * @property {string|null} [worktree]
 * @property {number|null} [pid]
 * @property {string|null} [source] run.start
 * @property {number|null} [workers] run.start
 * @property {string|null} [stopReason] run.end
 * @property {number|null} [rounds] run.end
 * @property {string|null} [promptHead] agent.start
 * @property {string|null} [promptSha256] agent.start
 * @property {string|null} [log] agent.start — path relative to the repo root, under `logs/`
 * @property {string|null} [resumedFrom] agent.start — agentId of the session that was `--resume`d (A-052; since A-083 also `retry` runs)
 * @property {ResumeKind|null} [resumeKind] agent.start — `chain`: resumes the developer session of the PREVIOUS task (A-052) ·
 *   `retry`: resumes THIS task's session after a red verify (A-053) · absent/null: fresh session
 * @property {string|null} [trigger] agent.compact — "boundary" (conductor, task boundary) · "auto" · "manual" (A-055)
 * @property {number|null} [before] agent.compact — context (tokens) before compacting, null when unknown
 * @property {string|null} [file] finding, agent.compact — summary file `logs/agent-queue/<id>/compact-<n>.md`
 * @property {number|null} [exitCode] agent.end
 * @property {number|null} [durationMs] agent.end
 * @property {Usage|null} [usage] agent.end
 * @property {number|null} [costUsd] agent.end
 * @property {number|null} [numTurns] agent.end
 * @property {string|null} [sessionId] agent.end — Claude Code session id (usable with `--resume`), null when unreadable
 * @property {number|null} [peakContext] agent.end — largest context of a single call (input + cache read + cache write)
 * @property {{cacheRead: number, cacheWrite: number}|null} [firstCall] agent.end — usage of the FIRST call (A-054): a resumed
 *   session (`--resume`) hits the cache when `cacheRead` ≈ the previous session's context, misses when it must rewrite it (large `cacheWrite`)
 * @property {string|null} [from] task.transition
 * @property {string|null} [to] task.transition
 * @property {string|null} [event] task.transition
 * @property {string|null} [pattern] pattern.chosen
 * @property {string|boolean|null} [evaluate] pattern.chosen
 * @property {string|null} [reason] pattern.chosen, verify.result, role.skipped (A-090 — why a reviewer was skipped; never quotes diff lines)
 * @property {boolean|null} [ok] verify.result
 * @property {VerifyCheck[]|null} [checks] verify.result — each `verify:` command; null = no structured result could be read
 * @property {string|null} [failTail] verify.result — last ≤ 20 output lines of the first red command
 * @property {"pre-review"|"integrate"|null} [phase] verify.result (A-089) — verify run BEFORE reviewers, or at the integrate step;
 *   older events lack this field: read as `integrate` (`verifyPhase`)
 * @property {string|null} [severity] finding
 * @property {number|null} [count] finding
 * @property {string|null} [file] finding
 * @property {number|null} [questions] inbox.changed
 * @property {number|null} [approvals] inbox.changed
 */

/** Fields common to every event. */
const COMMON_FIELDS = ["runId", "agentId", "parentId", "kind", "role", "model", "taskId", "slot", "worktree", "pid"];

/** Type-specific fields. @type {Record<string, string[]>} */
const TYPE_FIELDS = {
  "run.start": ["source", "workers"],
  "run.end": ["stopReason", "rounds"],
  "agent.start": ["promptHead", "promptSha256", "log", "resumedFrom", "resumeKind"],
  "agent.end": ["exitCode", "durationMs", "usage", "costUsd", "numTurns", "sessionId", "peakContext", "firstCall"],
  "task.transition": ["from", "to", "event"],
  "pattern.chosen": ["pattern", "evaluate", "reason"],
  "verify.result": ["ok", "reason", "checks", "failTail", "phase"],
  "finding": ["severity", "count", "file"],
  "inbox.changed": ["questions", "approvals"],
  "agent.compact": ["trigger", "before", "file"],
  "role.skipped": ["reason"],
};

/**
 * Ledger path: env AGENT_QUEUE_EVENTS_FILE (tests, e2e) or <root>/logs/agent-queue/events.jsonl;
 * AGENT_QUEUE_EVENTS=0 → null (ledger off; `appendEvent(null, …)` is a no-op).
 * @param {string} root @param {NodeJS.ProcessEnv} [env] @returns {string|null}
 */
export function eventsFile(root, env = process.env) {
  if (env.AGENT_QUEUE_EVENTS === "0") return null;
  const override = env.AGENT_QUEUE_EVENTS_FILE;
  if (override) return override;
  return path.join(root, "logs", "agent-queue", "events.jsonl");
}

/**
 * Like `eventsFile`, but for emit points in shared code (`store`, `findings`, `inbox`, conductor):
 * under `node --test` without AGENT_QUEUE_EVENTS_FILE, NOTHING is written — older tests must not
 * pollute the real `logs/agent-queue/events.jsonl`.
 * @param {string} root @param {NodeJS.ProcessEnv} [env] @returns {string|null}
 */
export function ledgerFile(root, env = process.env) {
  if (env.NODE_TEST_CONTEXT && !env.AGENT_QUEUE_EVENTS_FILE) return null;
  return eventsFile(root, env);
}

/**
 * Short id, unique on this machine: `${prefix}-${base36 time}-${random}`.
 * @param {string} prefix @returns {string}
 */
export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Scalars only — stray objects (e.g. `env` mistakenly put in `worktree`) are dropped.
 * Strings always go through `maskSecrets`. @param {unknown} value @returns {string|number|boolean|null|undefined}
 */
function cleanScalar(value) {
  if (value === null) return null;
  if (typeof value === "string") return maskSecrets(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

/** @param {unknown} n @returns {number} a finite number ≥ 0, otherwise 0 */
function count(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Usage in ledger form. @param {unknown} value @returns {Usage|null|undefined} */
function cleanUsage(value) {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const u = /** @type {Record<string, unknown>} */ (value);
  return { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
}

/** `agent.end.firstCall`: only the two cache counts. @param {unknown} value @returns {{cacheRead: number, cacheWrite: number}|null|undefined} */
function cleanFirstCall(value) {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const u = /** @type {Record<string, unknown>} */ (value);
  return { cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
}

/**
 * `verify.result.checks`: each item keeps only {cmd, ok, durationMs, skipped?}; `cmd` is masked, then truncated
 * (mask BEFORE truncating, like `redactPrompt`). Non-object items are dropped. Not an array → undefined.
 * @param {unknown} value @returns {VerifyCheck[]|null|undefined}
 */
function cleanChecks(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  /** @type {VerifyCheck[]} */
  const checks = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const c = /** @type {Record<string, unknown>} */ (item);
    if (typeof c.cmd !== "string") continue;
    /** @type {VerifyCheck} */
    const check = { cmd: maskSecrets(c.cmd).slice(0, MAX_CHECK_CMD_CHARS), ok: c.ok === true, durationMs: count(c.durationMs) };
    if (c.skipped === true) check.skipped = true;
    checks.push(check);
  }
  return checks;
}

/** `verify.result.failTail`: masks passwords, keeps the last ≤ MAX_FAIL_TAIL_LINES lines. @param {unknown} value @returns {string|null|undefined} */
function cleanTail(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return maskSecrets(value).split("\n").slice(-MAX_FAIL_TAIL_LINES).join("\n");
}

/** `verify.result.phase`: only the two declared values. @param {unknown} value @returns {"pre-review"|"integrate"|null|undefined} */
function cleanPhase(value) {
  if (value === null) return null;
  return value === "pre-review" || value === "integrate" ? value : undefined;
}

/**
 * Phase of a `verify.result`: events before A-089 have no `phase` → `integrate` (back then verify only ran at the integrate step).
 * @param {AgentEvent} event @returns {"pre-review"|"integrate"}
 */
export function verifyPhase(event) {
  return event.phase === "pre-review" ? "pre-review" : "integrate";
}

/**
 * PURE FUNCTION. Filters down to declared fields, adds schemaVersion + ts (ISO from `now`), drops undefined fields.
 * Unknown type → only common fields remain. `prompt`, `env` and every undeclared field are dropped.
 * @param {string} type @param {Record<string, unknown>} fields @param {Date|number} [now]
 * @returns {AgentEvent}
 */
export function makeEvent(type, fields, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const ts = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
  /** @type {Record<string, unknown>} */
  const event = { schemaVersion: SCHEMA_VERSION, ts, type };
  for (const key of [...COMMON_FIELDS, ...(TYPE_FIELDS[type] ?? [])]) {
    const raw = fields?.[key];
    if (raw === undefined) continue;
    const value = key === "usage" ? cleanUsage(raw)
      : key === "firstCall" ? cleanFirstCall(raw)
      : key === "checks" ? cleanChecks(raw)
      : key === "failTail" ? cleanTail(raw)
      : key === "phase" ? cleanPhase(raw)
      : cleanScalar(raw);
    if (value !== undefined) event[key] = value;
  }
  return /** @type {AgentEvent} */ (event);
}

/**
 * {promptHead: first 200 chars after maskSecrets, promptSha256} — NEVER returns the full prompt.
 * Mask BEFORE truncating: cutting inside `postgres://u:password` (before the `@`) would make the regex miss it.
 * @param {string} prompt @returns {{promptHead: string, promptSha256: string}}
 */
export function redactPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  let head = maskSecrets(text).slice(0, PROMPT_HEAD_CHARS);
  // Never leave half a surrogate pair (an emoji cut in two).
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return { promptHead: head, promptSha256: crypto.createHash("sha256").update(text).digest("hex") };
}

let warned = false;

/** Tests only: allow warning again in the same process. */
export function resetAppendWarning() {
  warned = false;
}

/** @param {string} message */
function defaultWarn(message) {
  process.stderr.write(`[agent-queue] ${message}\n`);
}

/** @param {unknown} e @returns {boolean} */
const isEnoent = (e) => typeof e === "object" && e !== null && /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT";

/**
 * Renames the live file to `events-<ISO>.jsonl` once it exceeds `maxBytes`. Deletes nothing.
 * File vanished midway (another process just rotated it) → treated as rotated.
 * @param {string} file @param {number} maxBytes
 */
function rotateIfNeeded(file, maxBytes) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    if (isEnoent(e)) return;
    throw e;
  }
  if (size <= maxBytes) return;
  const dir = path.dirname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = path.join(dir, `events-${stamp}.jsonl`);
  // Never overwrite a previously rotated file (two rotations in the same millisecond).
  for (let n = 1; fs.existsSync(target); n += 1) target = path.join(dir, `events-${stamp}-${n}.jsonl`);
  try {
    fs.renameSync(file, target);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

/**
 * Never throws. Error → opts.warn(msg) exactly ONCE per process, then silent. Rotates when size > maxBytes.
 * `file` null (ledger off) → does nothing.
 * @param {string|null|undefined} file @param {AgentEvent} event
 * @param {{maxBytes?: number, warn?: (message: string) => void}} [opts]
 */
export function appendEvent(file, event, opts = {}) {
  if (!file) return;
  try {
    const line = `${JSON.stringify(event)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, opts.maxBytes ?? MAX_BYTES);
    fs.appendFileSync(file, line);
  } catch (e) {
    if (warned) return;
    warned = true;
    try {
      const reason = e instanceof Error ? e.message : String(e);
      (opts.warn ?? defaultWarn)(`cannot write event ledger ${file}: ${reason} (warning shown once)`);
    } catch {
      // The warning must not break the caller either.
    }
  }
}

/**
 * Emits ONE event from shared code. Never throws. `runId`/`agentId` default to
 * AGENT_QUEUE_RUN_ID / AGENT_QUEUE_AGENT_ID (set by the conductor and `runClaude`) — so events from a
 * subcommand (`cli start`, `verify`…) attach to the run/agent that is running it.
 * @param {string} root repo root (where `logs/` lives) @param {string} type @param {Record<string, unknown>} fields
 * @param {NodeJS.ProcessEnv} [env]
 */
export function emitEvent(root, type, fields, env = process.env) {
  try {
    const file = ledgerFile(root, env);
    if (!file) return;
    appendEvent(file, makeEvent(type, {
      ...fields,
      runId: fields.runId ?? env.AGENT_QUEUE_RUN_ID ?? null,
      agentId: fields.agentId ?? env.AGENT_QUEUE_AGENT_ID ?? null,
    }));
  } catch {
    // The event ledger must never break the caller.
  }
}

/**
 * Reads the file + every `events-*.jsonl` in the same directory, ascending by ts; broken lines/unknown schema are dropped.
 * An unreadable file counts as empty. @param {string} file @param {{sinceMs?: number}} [opts]
 * @returns {AgentEvent[]}
 */
export function readEvents(file, opts = {}) {
  const dir = path.dirname(file);
  /** @type {string[]} */
  let rotated = [];
  try {
    rotated = fs.readdirSync(dir).filter((n) => /^events-.+\.jsonl$/.test(n)).sort().map((n) => path.resolve(dir, n));
  } catch {
    // Directory missing → only the main file is left (which will not be readable either).
  }
  const files = [...new Set([...rotated, path.resolve(file)])];
  /** @type {{ms: number, event: AgentEvent}[]} */
  const found = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.type !== "string") continue;
      const ms = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
      if (Number.isNaN(ms)) continue;
      if (opts.sinceMs !== undefined && ms < opts.sinceMs) continue;
      found.push({ ms, event: parsed });
    }
  }
  // Stable sort: equal ts keeps order older rotated files → current file → line order.
  return found.sort((a, b) => a.ms - b.ms).map((x) => x.event);
}

/** @param {unknown} v @returns {number|null} */
const numberOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Claude Code `usage` → ledger Usage. Missing field → 0.
 * @param {unknown} usage @returns {Usage}
 */
export function usageFromResult(usage) {
  const u = typeof usage === "object" && usage !== null ? /** @type {Record<string, unknown>} */ (usage) : {};
  return {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
  };
}

/**
 * One stdout line of `claude -p --output-format stream-json --verbose`.
 * Non-JSON line, or a type we do not care about → null.
 * @param {string} line
 * @returns {{kind: "init", model: string|null, sessionId: string|null}
 *   | {kind: "text", text: string}
 *   | {kind: "result", text: string, usage: Usage, costUsd: number|null, numTurns: number|null, durationMs: number|null, isError: boolean}
 *   | null}
 */
export function parseStreamLine(line) {
  if (typeof line !== "string" || line.trim() === "") return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  if (o.type === "system" && o.subtype === "init") {
    return {
      kind: "init",
      model: typeof o.model === "string" ? o.model : null,
      sessionId: typeof o.session_id === "string" ? o.session_id : null,
    };
  }
  if (o.type === "assistant") {
    const content = o.message?.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string")
      .map((/** @type {any} */ b) => b.text)
      .join("\n");
    return text === "" ? null : { kind: "text", text };
  }
  if (o.type === "result") {
    return {
      kind: "result",
      text: typeof o.result === "string" ? o.result : "",
      usage: usageFromResult(o.usage),
      costUsd: numberOrNull(o.total_cost_usd),
      numTurns: numberOrNull(o.num_turns),
      durationMs: numberOrNull(o.duration_ms),
      isError: o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success"),
    };
  }
  return null;
}

/**
 * Context size of ONE call in a stream-json `assistant` line: input + cache read + cache write
 * (output excluded — it is not in the context at call time). One message is printed as several lines with the same
 * `usage`, so callers take the MAX (not the sum) to avoid double counting. Not `assistant`, or no
 * `usage` → null.
 * @param {string} line @returns {number|null}
 */
export function contextOfLine(line) {
  const u = assistantUsage(line);
  return u === null ? null : u.input + u.cacheRead + u.cacheWrite;
}

/**
 * `usage` of a stream-json `assistant` line (ledger form), otherwise null (A-054: `firstCall`).
 * @param {string} line @returns {Usage|null}
 */
export function assistantUsage(line) {
  if (typeof line !== "string" || line.trim() === "") return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o?.type !== "assistant" || typeof o.message?.usage !== "object" || o.message.usage === null) return null;
  return usageFromResult(o.message.usage);
}

/**
 * Subagent transcript lines → total usage. One message is written as SEVERAL lines (one per content
 * block, same `message.id`), so each `message.id` counts ONCE and the LAST line wins.
 * Lines without `message.id` cannot be deduplicated → each line is one message. `model` comes from the
 * last message with a real model (skipping `<synthetic>`, the fake model Claude Code puts on error notices).
 * @param {Iterable<string>} lines
 * @returns {{usage: Usage, model: string|null, numTurns: number}}
 */
export function transcriptUsage(lines) {
  /** @type {Map<string, {usage: Usage, model: string|null}>} */
  const messages = new Map();
  let index = 0;
  for (const line of lines) {
    index += 1;
    if (typeof line !== "string" || line.trim() === "") continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== "assistant" || typeof o.message !== "object" || o.message === null) continue;
    const id = typeof o.message.id === "string" && o.message.id !== "" ? o.message.id : `line:${index}`;
    const model = typeof o.message.model === "string" && o.message.model !== "<synthetic>" ? o.message.model : null;
    // Move to the end so the final `model` belongs to the message written last.
    messages.delete(id);
    messages.set(id, { usage: usageFromResult(o.message.usage), model });
  }
  /** @type {Usage} */
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** @type {string|null} */
  let model = null;
  for (const m of messages.values()) {
    total.input += m.usage.input;
    total.output += m.usage.output;
    total.cacheRead += m.usage.cacheRead;
    total.cacheWrite += m.usage.cacheWrite;
    if (m.model !== null) model = m.model;
  }
  return { usage: total, model, numTurns: messages.size };
}
