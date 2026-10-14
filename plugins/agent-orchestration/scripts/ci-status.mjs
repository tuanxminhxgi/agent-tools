// @ts-check
/**
 * A-079 — CI status of the main branch, read via `gh`. For REPORTING (INBOX + conductor log); blocking push/new work on
 * red CI (A-084) is only the pure decision `ciGate` at the end of this file — its callers are `commit.mjs`,
 * `conductor.mjs`, the Stop hook.
 *
 * `summarizeRuns` is a pure function over the run array; `readCiStatus` is a thin IO layer — it NEVER throws: `gh`
 * missing, slow, failing or returning broken JSON all yield `{state: "unknown", reason}` so `inbox` and the conductor
 * don't break with it. The cache keeps only the declared fields of `CiStatus` — no tokens, run names or user names.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Each `gh` command is abandoned after this many milliseconds. */
export const GH_TIMEOUT_MS = 8_000;
/** The cache stays valid for this long. */
export const CACHE_TTL_MS = 5 * 60_000;
const CACHE_FILE = path.join("logs", "agent-queue", "ci-status.json");
const RUN_LIMIT = 30;
const RED = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * @typedef {Object} CiStatus
 * @property {"green"|"red"|"unknown"} state
 * @property {number} redStreak          consecutive red runs counting from the newest (0 if not red)
 * @property {string|null} lastGreenAt   `createdAt` of the most recent green run
 * @property {string|null} url           the run that decided the state
 * @property {string|null} headSha
 * @property {{job: string, step: string}[]} failed  first red step of each red job
 * @property {string|null} reason        why `unknown` (one line)
 */

/**
 * @typedef {Object} Run  one element of `gh run list --json conclusion,status,headSha,url,createdAt,databaseId`
 * @property {string} [conclusion] @property {string} [status] @property {string} [headSha]
 * @property {string} [url] @property {string} [createdAt] @property {number} [databaseId]
 */

/**
 * @typedef {Object} ExecResult
 * @property {number|null} code  exit code (`null` = could not run / was killed)
 * @property {string} stdout
 * @property {"missing"|"timeout"|"other"|null} error
 */

/**
 * @typedef {Object} CiDeps
 * @property {(file: string, args: string[], opts: {cwd: string, timeoutMs: number}) => ExecResult} [exec]
 * @property {() => Date} [now]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * Fold the run list (newest → oldest) into a status. PURE FUNCTION.
 * Skips unfinished runs and `cancelled`/`skipped`/any conclusion other than `success` or red; the first remaining run decides.
 * @param {Run[]} runs
 * @returns {{state: "green"|"red"|"unknown", redStreak: number, lastGreenAt: string|null, url: string|null, headSha: string|null, runId: number|null}}
 */
export function summarizeRuns(runs) {
  const decisive = runs.filter((r) => r.status === "completed" && (r.conclusion === "success" || RED.has(r.conclusion ?? "")));
  const newest = decisive[0];
  if (newest === undefined) return { state: "unknown", redStreak: 0, lastGreenAt: null, url: null, headSha: null, runId: null };
  const firstGreen = decisive.find((r) => r.conclusion === "success");
  const info = { url: newest.url ?? null, headSha: newest.headSha ?? null, runId: newest.databaseId ?? null };
  if (newest.conclusion === "success") return { state: "green", redStreak: 0, lastGreenAt: newest.createdAt ?? null, ...info };
  const streak = firstGreen === undefined ? decisive.length : decisive.indexOf(firstGreen);
  return { state: "red", redStreak: streak, lastGreenAt: firstGreen?.createdAt ?? null, ...info };
}

/** @param {string} reason @returns {CiStatus} */
function unknown(reason) {
  return { state: "unknown", redStreak: 0, lastGreenAt: null, url: null, headSha: null, failed: [], reason };
}

/** @type {NonNullable<CiDeps["exec"]>} */
function realExec(file, args, { cwd, timeoutMs }) {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
  const code = /** @type {NodeJS.ErrnoException|undefined} */ (r.error)?.code;
  /** @type {ExecResult["error"]} */
  let error = null;
  if (code === "ENOENT") error = "missing";
  else if (code === "ETIMEDOUT" || r.signal === "SIGTERM") error = "timeout";
  else if (r.error) error = "other";
  return { code: r.status, stdout: r.stdout ?? "", error };
}

/**
 * Run one `gh` command and parse JSON. Failure → throws an `Error` with ONE line (caught only by `readCiStatus`).
 * @param {NonNullable<CiDeps["exec"]>} exec @param {string} root @param {string[]} args @returns {unknown}
 */
function gh(exec, root, args) {
  const r = exec("gh", args, { cwd: root, timeoutMs: GH_TIMEOUT_MS });
  if (r.error === "missing") throw new Error("gh command not found");
  if (r.error === "timeout") throw new Error(`gh took longer than ${GH_TIMEOUT_MS / 1000} seconds`);
  if (r.error !== null || r.code !== 0) throw new Error(`gh exited with code ${r.code ?? "?"}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error("gh returned invalid JSON");
  }
}

/**
 * First red step of each red job in `gh run view --json jobs`. PURE FUNCTION, tolerant of malformed data.
 * @param {unknown} view @returns {{job: string, step: string}[]}
 */
export function failedSteps(view) {
  const jobs = /** @type {{jobs?: unknown}} */ (view ?? {}).jobs;
  if (!Array.isArray(jobs)) return [];
  /** @type {{job: string, step: string}[]} */
  const out = [];
  for (const job of jobs) {
    if (job === null || typeof job !== "object" || !RED.has(String(job.conclusion))) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const step = steps.find((/** @type {{conclusion?: unknown}} */ s) => s !== null && typeof s === "object" && RED.has(String(s.conclusion)));
    out.push({ job: oneLine(String(job.name ?? "?")), step: oneLine(String(step?.name ?? "?")) });
  }
  return out;
}

/** @param {string} s */
function oneLine(s) {
  return s.replace(/[\s`]+/g, " ").trim();
}

/** @param {unknown} v @returns {v is CiStatus} */
function isStatus(v) {
  if (v === null || typeof v !== "object") return false;
  const s = /** @type {Partial<CiStatus>} */ (v);
  return (s.state === "green" || s.state === "red" || s.state === "unknown")
    && Number.isInteger(s.redStreak) && Array.isArray(s.failed);
}

/** Declared fields only — no stray data gets into the cache. @param {CiStatus} s @returns {CiStatus} */
function pick(s) {
  return {
    state: s.state, redStreak: s.redStreak, lastGreenAt: s.lastGreenAt ?? null, url: s.url ?? null,
    headSha: s.headSha ?? null, failed: s.failed.map((f) => ({ job: String(f.job), step: String(f.step) })), reason: s.reason ?? null,
  };
}

/**
 * Read the CI status of the workflow/branch declared in config. NEVER throws.
 * `cfg` null or `AGENT_QUEUE_CI_STATUS=0` → `unknown/"off"` without calling `gh`. 5-minute cache at
 * `logs/agent-queue/ci-status.json`; a broken cache is ignored.
 * @param {string} root @param {import("./project-config.mjs").CiWatch|null|undefined} cfg @param {CiDeps} [deps]
 * @returns {CiStatus}
 */
export function readCiStatus(root, cfg, deps = {}) {
  const env = deps.env ?? process.env;
  if (!cfg || env.AGENT_QUEUE_CI_STATUS === "0") return unknown("off");
  // Same as `events.mjs`: under `node --test` without a fake `exec`, never call the real `gh` (older tests call writeInbox).
  if (env.NODE_TEST_CONTEXT && !deps.exec) return unknown("off");
  const exec = deps.exec ?? realExec;
  const now = (deps.now ?? (() => new Date()))();
  const cache = path.join(root, CACHE_FILE);

  try {
    const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
    const age = now.getTime() - new Date(saved.at).getTime();
    if (age >= 0 && age < CACHE_TTL_MS && isStatus(saved.status)) return pick(saved.status);
  } catch {
    // missing / broken → read again from gh
  }

  /** @type {CiStatus} */
  let status;
  try {
    const runs = gh(exec, root, [
      "run", "list", "--workflow", cfg.workflow, "--branch", cfg.branch, "--limit", String(RUN_LIMIT),
      "--json", "conclusion,status,headSha,url,createdAt,databaseId",
    ]);
    if (!Array.isArray(runs)) throw new Error("gh returned JSON of the wrong shape");
    const { runId, ...sum } = summarizeRuns(runs);
    /** @type {{job: string, step: string}[]} */
    let failed = [];
    if (sum.state === "red" && runId !== null) {
      try {
        failed = failedSteps(gh(exec, root, ["run", "view", String(runId), "--json", "jobs"]));
      } catch {
        // still report red without step details
      }
    }
    status = { ...sum, failed, reason: sum.state === "unknown" ? "no completed run yet" : null };
  } catch (err) {
    status = unknown(oneLine(err instanceof Error ? err.message : String(err)));
  }
  status = pick(status);

  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, `${JSON.stringify({ at: now.toISOString(), status }, null, 2)}\n`);
  } catch {
    // a failing cache write must not break INBOX
  }
  return status;
}

/**
 * Lines of the INBOX section "CI on <branch>" (empty unless red). PURE FUNCTION.
 * `closed` (A-084): gate is closed → add the "push HALTED" line; `unpushed` null drops the commit count.
 * @param {CiStatus|null|undefined} ci @param {{unpushed: number|null}|null} [closed]
 * @param {string} [branch]  watched branch (`ci.branch`) shown in the heading
 * @param {string|null} [localHint]  `ci.localHint` — command to rerun a job locally; null = no line
 * @returns {string[]}
 */
export function ciInboxLines(ci, closed = null, branch = "main", localHint = null) {
  if (!ci || ci.state !== "red") return [];
  const last = [
    ci.url === null ? null : `Latest run: ${ci.url}`,
    ci.headSha === null ? null : `commit \`${ci.headSha.slice(0, 7)}\``,
    ci.lastGreenAt === null ? "no green run in the last 30 runs" : `last green ${ci.lastGreenAt.slice(0, 10)}`,
  ].filter((p) => p !== null);
  return [
    `## CI on ${branch} (red ${ci.redStreak} runs in a row)`,
    "",
    `- ${last.join(" · ")}`,
    ...ci.failed.map((f) => `- \`${f.job}\` red at step \`${f.step}\``),
    ...(closed ? [`- Conductor has HALTED pushing (ci.gate = block)${closed.unpushed === null ? "" : ` · ${closed.unpushed} unpushed commit(s)`}`] : []),
    ...(localHint ? [`- Rerun locally: \`${localHint}\``] : []),
    "",
  ];
}

/**
 * A-084 — gate blocking push + new work. PURE FUNCTION. Closed ONLY WHEN `gate` = "block" AND CI is red AND the current
 * branch is `cfg.branch` itself (a task on another branch doesn't turn `main` red, and its push doesn't land on `main`).
 * Every other case — green, `unknown` (no `gh`, offline, run in progress/cancelled, CI reading disabled), `ci: null` —
 * is OPEN: the gate never locks itself out of ignorance. `AGENT_QUEUE_CI_GATE=warn|block` overrides the config's `gate`
 * (the bypass for one run pushing a fix); other values are ignored.
 * @param {CiStatus|null|undefined} status
 * @param {import("./project-config.mjs").CiWatch|null|undefined} cfg
 * @param {string|null|undefined} branch  current git branch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{closed: boolean, reason: string|null}}
 */
export function ciGate(status, cfg, branch, env = process.env) {
  const open = { closed: false, reason: null };
  if (!cfg || !status || status.state !== "red") return open;
  const override = env.AGENT_QUEUE_CI_GATE;
  const gate = override === "warn" || override === "block" ? override : cfg.gate;
  if (gate !== "block" || branch !== cfg.branch) return open;
  return { closed: true, reason: `CI on ${cfg.branch} red for ${status.redStreak} run(s) (ci.gate = block)` };
}

/**
 * @param {string} cwd @param {string[]} args @returns {string|null} trimmed stdout; null if git fails
 */
function gitOut(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

/**
 * CI gate for the outer layers (conductor, Stop hook, INBOX): reads CI via `readCiStatus` (5-minute cache) and the
 * current branch, then asks `ciGate`. NEVER throws — any error means "open". `unpushed` = number of commits HEAD is
 * ahead of upstream (`git rev-list --count` over upstream..HEAD), null if unreadable (only computed when closed).
 * @param {string} root @param {import("./project-config.mjs").CiWatch|null|undefined} cfg @param {CiDeps} [deps]
 * @returns {{closed: boolean, reason: string|null, status: CiStatus|null, unpushed: number|null}}
 */
export function ciGateNow(root, cfg, deps = {}) {
  try {
    if (!cfg) return { closed: false, reason: null, status: null, unpushed: null };
    const status = readCiStatus(root, cfg, deps);
    const branch = gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const gate = ciGate(status, cfg, branch, deps.env);
    if (!gate.closed) return { ...gate, status, unpushed: null };
    const count = gitOut(root, ["rev-list", "--count", "@{u}..HEAD"]);
    return { ...gate, status, unpushed: count !== null && /^\d+$/.test(count) ? Number(count) : null };
  } catch {
    return { closed: false, reason: null, status: null, unpushed: null };
  }
}

/**
 * Conductor stop reason when the gate is closed (A-084). PURE FUNCTION. `unpushed` null → the "unpushed commit(s)" part is dropped.
 * @param {CiStatus} status @param {string} branch @param {number|null} unpushed @returns {string}
 */
export function ciClosedStopReason(status, branch, unpushed) {
  return `CI on ${branch} red for ${status.redStreak} run(s) — stopped taking new work${unpushed === null ? "" : `; ${unpushed} unpushed commit(s)`}. `
    + "Fix CI then `git push`, or run once with AGENT_QUEUE_CI_GATE=warn";
}

/**
 * Warning line for the conductor log; null unless CI is red. PURE FUNCTION.
 * @param {CiStatus|null|undefined} ci @param {string} branch @returns {string|null}
 */
export function ciWarning(ci, branch) {
  if (!ci || ci.state !== "red") return null;
  const where = ci.failed.length === 0 ? "" : ` (${ci.failed.map((f) => `${f.job}: ${f.step}`).join("; ")})`;
  return `WARNING: CI on ${branch} red for ${ci.redStreak} runs in a row${where}${ci.url === null ? "" : ` — ${ci.url}`}`;
}
