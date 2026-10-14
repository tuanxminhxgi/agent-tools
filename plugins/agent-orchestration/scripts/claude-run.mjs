// @ts-check
/**
 * `claude -p` RUNNER WITH AN EVENT LOG (A-036) — the single place that opens a `claude` process for the dashboard.
 *
 * Previously `claude -p` ran via `spawnSync` (conductor) or a bare command (shell scripts): the process was only
 * known to exist AFTER it finished, and there were no tokens. Here:
 *   - async `spawn`, writing `agent.start` (with `pid`) RIGHT after opening — before the process finishes;
 *   - always adds `--output-format stream-json --verbose`, reads stdout line by line: text goes to the text log as
 *     before, the `result` line gives `usage`/`total_cost_usd`;
 *   - `close` → `agent.end` (exit code, duration, usage, `sessionId` from the `system/init` line, `peakContext` =
 *     largest context of a single call — A-050: the total `usage` accumulates cache reads across turns, so it says
 *     nothing about how "big" the session is).
 *
 * Rules: a broken event log does NOT break `claude` or change its exit code (`appendEvent` never throws); events
 * contain NO full prompt or secrets (only `redactPrompt`); `code: 127` only when the process could not be opened.
 *
 * Command-line mode for shell scripts:
 *   node claude-run.mjs --kind worker --role developer --task A-001 --run-id R --log logs/x.log -- <claude args> <prompt>
 *   node claude-run.mjs event run.start|run.end --source run-backlog --run-id R [--stop-reason "…"]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendEvent, assistantUsage, eventsFile, makeEvent, newId, parseStreamLine, redactPrompt } from "./events.mjs";

/** @typedef {import("./events.mjs").Usage} Usage */
/** @typedef {{kind: "worker"|"role"|"planner"|"conductor", role?: string, model?: string, taskId?: string,
 *   slot?: number|null, worktree?: string|null, runId: string, parentId?: string|null, resumedFrom?: string|null,
 *   resumeKind?: import("./events.mjs").ResumeKind|null}} AgentMeta
 *   `resumedFrom`: agentId of the session being `--resume`d (A-052/A-083) — lets the dashboard link two turns of one session.
 *   `resumeKind` (A-083): `chain` resumes the previous task's session · `retry` resumes this task's own session after a red verify. */

/** @type {Usage} */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * PURE FUNCTION: add `--output-format stream-json --verbose` if absent; keep the rest in order.
 * An existing `--output-format` (including `--output-format=x`) or `--verbose` is left as is, never duplicated.
 * @param {string[]} args @returns {string[]}
 */
export function streamArgs(args) {
  const out = [...args];
  if (!out.some((a) => a === "--output-format" || a.startsWith("--output-format="))) out.push("--output-format", "stream-json");
  if (!out.includes("--verbose")) out.push("--verbose");
  return out;
}

/**
 * PURE FUNCTION (A-087): is this stdout line the `result` line reporting the session stopped on `--max-budget-usd`.
 * The real shape of this line has NOT been checked against the CLI (no documentation in the repo) — detected by a `subtype`
 * containing `budget` AND `is_error: true`; missing either one means the cap was not hit.
 * @param {string} line @returns {boolean}
 */
export function isBudgetStop(line) {
  try {
    const o = JSON.parse(line);
    return o?.type === "result" && o.is_error === true && typeof o.subtype === "string" && /budget/i.test(o.subtype);
  } catch {
    return false;
  }
}

/** The `claude` command, split on whitespace so tests can point it at `node <fake>`. @param {NodeJS.ProcessEnv} env @returns {string[]} */
function claudeCommand(env) {
  const raw = (env.AGENT_QUEUE_CLAUDE_BIN || process.env.AGENT_QUEUE_CLAUDE_BIN || "").trim();
  return raw === "" ? ["claude"] : raw.split(/\s+/);
}

/** @param {string} line @returns {boolean} the line is a JSON object (unknown stream-json event types count too) */
function isJsonObject(line) {
  try {
    const o = JSON.parse(line);
    return typeof o === "object" && o !== null;
  } catch {
    return false;
  }
}

/**
 * `stdinPrompt`: the prompt goes through stdin instead of the end of the command line (a large prompt — e.g. with a
 * diff — stays under the argument length limit). Aborting `signal` = kill the process (conductor kill); `timeoutMs`
 * expiry = SIGKILL. `redact` masks text before it reaches the text log (the worker's DB password); the event log
 * doesn't need it because `makeEvent` already masks and holds no output. `logBase`: base for the `log` field of
 * `agent.start` (default `cwd`); a worker running in a worktree must pass the repo root, otherwise the log path becomes `../..`.
 * @param {{args: string[], prompt: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string,
 *          meta: AgentMeta, eventsFile?: string|null, now?: () => number, spawnImpl?: typeof spawn,
 *          stdinPrompt?: boolean, signal?: AbortSignal, timeoutMs?: number, redact?: (text: string) => string,
 *          logBase?: string}} job
 * @returns {Promise<{code: number, output: string, usage: Usage, costUsd: number|null, agentId: string, pid: number|null,
 *   sessionId: string|null, peakContext: number|null, budgetExceeded: boolean}>}
 */
export async function runClaude(job) {
  const now = job.now ?? Date.now;
  const spawnFn = job.spawnImpl ?? spawn;
  const { meta } = job;
  // `null` means "ledger off" on purpose (unlike `undefined` = use the default path).
  const ledger = job.eventsFile !== undefined ? job.eventsFile : eventsFile(job.cwd, job.env);
  const agentId = newId("agt");
  const logPath = path.resolve(job.cwd, job.logFile);
  const relLog = path.relative(job.logBase ?? job.cwd, logPath);
  const logField = relLog === "" || relLog.startsWith("..") ? job.logFile : relLog;

  /** @param {string} type @param {Record<string, unknown>} fields */
  const emit = (type, fields) => {
    try {
      appendEvent(ledger, makeEvent(type, fields, now()));
    } catch {
      // The event log must never crash the `claude` process.
    }
  };

  let logWarned = false;
  /** APPEND to the text log; if the log can't be written, warn once then stay quiet. @param {string|Buffer} data */
  const writeLog = (data) => {
    try {
      fs.appendFileSync(logPath, job.redact ? job.redact(data.toString()) : data);
    } catch (e) {
      if (logWarned) return;
      logWarned = true;
      process.stderr.write(`[agent-queue] could not write log ${logPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    // writeLog will warn when writing.
  }

  const [bin, ...binArgs] = claudeCommand(job.env);
  const viaStdin = job.stdinPrompt === true;
  const argv = [...binArgs, ...streamArgs(job.args), ...(job.prompt === "" || viaStdin ? [] : [job.prompt])];
  // AGENT_QUEUE_TASK_ID: the PostCompact hook (A-055) writes the summary into the task's own log directory.
  const env = { ...job.env, AGENT_QUEUE_RUN_ID: meta.runId, AGENT_QUEUE_AGENT_ID: agentId, ...(meta.taskId ? { AGENT_QUEUE_TASK_ID: meta.taskId } : {}) };
  const startedAt = now();

  /** @type {import("node:child_process").ChildProcess|null} */
  let child = null;
  /** @type {unknown} */
  let spawnError = null;
  try {
    child = spawnFn(bin, argv, { cwd: job.cwd, env, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"], signal: job.signal });
  } catch (e) {
    spawnError = e;
  }
  const pid = child !== null && typeof child.pid === "number" ? child.pid : null;
  if (viaStdin && child?.stdin) {
    child.stdin.on("error", () => {}); // claude exited early → EPIPE, not our error
    child.stdin.end(job.prompt);
  }

  const common = {
    runId: meta.runId, agentId, parentId: meta.parentId ?? null, kind: meta.kind, role: meta.role,
    taskId: meta.taskId, slot: meta.slot, worktree: meta.worktree, pid,
  };
  // RIGHT after spawn, before any await: the ledger knows the process exists while it is still running.
  emit("agent.start", { ...common, model: meta.model, ...redactPrompt(job.prompt), log: logField, resumedFrom: meta.resumedFrom ?? undefined,
    resumeKind: meta.resumeKind ?? undefined });

  /** State read from stdout — kept in one object so TS doesn't narrow it to `never` across the closure.
   * @type {{result: {usage: Usage, costUsd: number|null, numTurns: number|null, text: string}|null, initModel: string|null,
   *   sessionId: string|null, peakContext: number|null, firstCall: {cacheRead: number, cacheWrite: number}|null, budgetExceeded: boolean}} */
  const seen = { result: null, initModel: null, sessionId: null, peakContext: null, firstCall: null, budgetExceeded: false };
  /** Text in arrival order — fallback for `output` when there is no `result` line. @type {string[]} */
  const fallback = [];

  /** @param {string} line */
  const onLine = (line) => {
    const u = assistantUsage(line);
    if (u !== null) {
      seen.peakContext = Math.max(seen.peakContext ?? 0, u.input + u.cacheRead + u.cacheWrite);
      // First call (A-054): a `--resume`d session hitting the cache has cacheRead ≈ old context; a miss shows a large cacheWrite.
      if (seen.firstCall === null) seen.firstCall = { cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
    }
    if (isBudgetStop(line)) seen.budgetExceeded = true;
    const parsed = parseStreamLine(line);
    if (parsed === null) {
      // Non-JSON lines (older claude, odd messages) go to the log verbatim; JSON of other types is dropped.
      if (line.trim() !== "" && !isJsonObject(line)) {
        writeLog(`${line}\n`);
        fallback.push(line);
      }
      return;
    }
    if (parsed.kind === "init") {
      seen.initModel = parsed.model;
      seen.sessionId = parsed.sessionId;
    } else if (parsed.kind === "text") {
      writeLog(`${parsed.text}\n`);
      fallback.push(parsed.text);
    } else {
      if (parsed.text !== "") writeLog(`${parsed.text}\n`);
      seen.result = { usage: parsed.usage, costUsd: parsed.costUsd, numTurns: parsed.numTurns, text: parsed.text };
    }
  };

  /** @type {Promise<void>} */
  const linesDone = new Promise((resolve) => {
    if (!child?.stdout) return resolve();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", onLine);
    rl.once("close", () => resolve());
  });
  child?.stderr?.on("data", (/** @type {Buffer} */ chunk) => writeLog(chunk));

  /** @type {Promise<number>} */
  const exited = new Promise((resolve) => {
    if (child === null) {
      writeLog(`[claude-run] could not start process: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}\n`);
      return resolve(127);
    }
    child.once("error", (e) => {
      // No pid = never started (ENOENT…): `close` may never come, finish now.
      if (child?.pid === undefined) {
        writeLog(`[claude-run] could not start process: ${e.message}\n`);
        resolve(127);
      }
    });
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  });

  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  const limit = job.timeoutMs;
  if (child !== null && limit !== undefined && limit > 0) {
    const running = child;
    timer = setTimeout(() => {
      writeLog(`\n(exceeded ${Math.round(limit / 60000)} min — killed)\n`);
      running.kill("SIGKILL");
    }, limit);
  }
  const code = await exited;
  if (timer !== null) clearTimeout(timer);
  if (child?.pid !== undefined) await linesDone;

  const final = seen.result;
  const usage = final?.usage ?? NO_USAGE;
  const costUsd = final?.costUsd ?? null;
  emit("agent.end", {
    ...common,
    model: meta.model ?? seen.initModel ?? undefined,
    exitCode: code,
    durationMs: Math.max(0, now() - startedAt),
    usage,
    costUsd,
    numTurns: final?.numTurns ?? null,
    sessionId: seen.sessionId,
    peakContext: seen.peakContext,
    firstCall: seen.firstCall,
  });

  return {
    code, output: final ? final.text : fallback.join("\n"), usage, costUsd, agentId, pid,
    sessionId: seen.sessionId, peakContext: seen.peakContext, budgetExceeded: seen.budgetExceeded,
  };
}

// ─── Command-line mode ──────────────────────────────────────────────────────────────────────────

/** Flag → field name. */
const FLAGS = {
  "--kind": "kind", "--role": "role", "--model": "model", "--task": "taskId", "--slot": "slot",
  "--worktree": "worktree", "--run-id": "runId", "--parent-id": "parentId", "--log": "log",
  "--source": "source", "--workers": "workers", "--stop-reason": "stopReason", "--rounds": "rounds",
};

/**
 * PURE FUNCTION: `--flag value` / `--flag=value` up to `--` (the rest are claude's arguments).
 * @param {string[]} argv
 * @returns {{opts: Record<string, string>, rest: string[]|null, error: string|null}}
 */
export function parseOptions(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") return { opts, rest: argv.slice(i + 1), error: null };
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const key = Object.hasOwn(FLAGS, flag) ? FLAGS[/** @type {keyof typeof FLAGS} */ (flag)] : null;
    if (key === null) return { opts, rest: null, error: `unknown flag: ${arg}` };
    const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) return { opts, rest: null, error: `flag ${flag} is missing a value` };
    opts[key] = value;
  }
  return { opts, rest: null, error: null };
}

/** @param {string|undefined} v @returns {number|undefined} */
const toNumber = (v) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

const USAGE_TEXT = [
  "usage: claude-run.mjs [--kind worker|role|planner|conductor] [--role R] [--model M] [--task ID] [--slot N]",
  "                      [--worktree P] [--run-id ID] [--parent-id ID] --log FILE -- <claude args> <prompt>",
  "       claude-run.mjs event run.start|run.end --source S [--run-id ID] [--workers N] [--stop-reason R] [--rounds N]",
].join("\n");

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {string} cwd
 * @returns {Promise<number>} exit code — `claude`'s in run mode; 0 for `event` (a broken ledger changes nothing); 2 on misuse
 */
export async function runCli(argv, env, cwd) {
  /** @param {string} message */
  const usage = (message) => {
    process.stderr.write(`${message}\n${USAGE_TEXT}\n`);
    return 2;
  };

  if (argv[0] === "event") {
    const type = argv[1];
    if (type !== "run.start" && type !== "run.end") return usage(`event type must be run.start or run.end (got: ${type ?? "empty"})`);
    const parsed = parseOptions([...argv.slice(2), "--"]);
    if (parsed.error) return usage(parsed.error);
    const { opts } = parsed;
    appendEvent(eventsFile(cwd, env), makeEvent(type, {
      runId: opts.runId ?? env.AGENT_QUEUE_RUN_ID ?? null,
      source: opts.source,
      workers: toNumber(opts.workers),
      stopReason: opts.stopReason,
      rounds: toNumber(opts.rounds),
    }));
    return 0;
  }

  const parsed = parseOptions(argv);
  if (parsed.error) return usage(parsed.error);
  const { opts, rest } = parsed;
  if (rest === null || rest.length === 0) return usage("missing `-- <claude args>`");
  if (!opts.log) return usage("missing --log");
  const kind = opts.kind ?? "worker";
  if (kind !== "worker" && kind !== "role" && kind !== "planner" && kind !== "conductor") return usage(`invalid --kind: ${kind}`);

  // The prompt is the last argument (as in `claude -p "$PROMPT"`); if the last argument starts with `-`, there is no prompt.
  const last = rest[rest.length - 1];
  const hasPrompt = !last.startsWith("-");
  const result = await runClaude({
    args: hasPrompt ? rest.slice(0, -1) : rest,
    prompt: hasPrompt ? last : "",
    cwd,
    env,
    logFile: opts.log,
    meta: {
      kind,
      role: opts.role,
      model: opts.model,
      taskId: opts.taskId,
      slot: toNumber(opts.slot) ?? null,
      worktree: opts.worktree ?? null,
      runId: opts.runId ?? env.AGENT_QUEUE_RUN_ID ?? newId("run"),
      parentId: opts.parentId ?? null,
    },
  });
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.env, process.cwd());
}
