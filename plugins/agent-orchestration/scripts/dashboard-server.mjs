// @ts-check
/**
 * LAYER 2 of the agent dashboard — `npm run agents:ui` (A-039, requirements/bang-dieu-khien-agent.md).
 * READ-ONLY Node server on 127.0.0.1: builds `buildState` (dashboard.mjs) from the event ledger + `tasks/` and
 * serves it to the static page (dashboard-page.mjs).
 *
 *   GET /                  the seven-panel page
 *   GET /api/state         `buildState` JSON (cards · agents · tree · timeline · usage · waiting · plan)
 *   GET /api/flow[?runId=<id>][&after=<seq>][&reducedMotion=1]
 *                          `flowFor` (dashboard-flow.mjs): {runId, runs, layout, frames, events} of one run (default:
 *                          latest run); `after` returns only new frames; unknown runId → 404, bad `after` → 400
 *   GET /api/stream        SSE, `event: state` — pushed when the ledger or `tasks/` changes (1 s poll, only while a client is connected)
 *   GET /api/log/:agentId  last ≤ 200 lines of the agent's log, passwords masked
 *   anything else → 404 · methods other than GET/HEAD → 405 with `Allow: GET, HEAD`
 *
 * HARD RULES (each one has a test):
 *   - Writes no file, never calls `start`/`apply`/`writeInbox`/`syncPlanner`. `plan` is built like the conductor's
 *     `--dry-run`: `recover` + `tick` + `renderPlan` on state read from disk.
 *   - Listens on loopback only; unknown `Host` is rejected (DNS rebinding defence — a browser can be tricked into
 *     calling 127.0.0.1 under someone else's domain).
 *   - `/api/log` only serves files inside `<root>/logs/` (after both `path.resolve` and `realpath`).
 *   - Never loads a whole log file into memory (`tail` reads backwards in blocks).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildState } from "./dashboard.mjs";
import { eventsFile as ledgerPath, readEvents } from "./events.mjs";
import { loadBacklog, loadBugs, loadQuestions, criticalPath } from "./backlog.mjs";
import { loadRequirements } from "./planner.mjs";
import { listWorktrees, maskSecrets } from "./worker.mjs";
import { recover, tick, renderPlan } from "./conductor.mjs";
import { loadProjectConfig, projectRoot } from "./project-config.mjs";
import { inboxCounts } from "./inbox.mjs";
import { PAGE_HTML } from "./dashboard-page.mjs";
import { flowFor } from "./dashboard-flow.mjs";

/** Max log lines returned, backward read block size, and byte cap for one `tail`. */
export const LOG_LINES = 200;
const BLOCK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;
const POLL_MS = 1000;
const PING_EVERY = 15;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * Last ≤ `n` lines of a file, read backwards in `blockSize` blocks from the end, stopping once there are enough lines or
 * `maxBytes` is reached — never loads the whole file. A first line cut midway (file start not reached) is dropped.
 * Unreadable file → `[]`.
 * @param {string} file @param {number} n
 * @param {{blockSize?: number, maxBytes?: number}} [opts]
 * @returns {string[]}
 */
export function tail(file, n, { blockSize = BLOCK_BYTES, maxBytes = MAX_TAIL_BYTES } = {}) {
  if (!(n > 0)) return [];
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    let pos = fs.fstatSync(fd).size;
    /** @type {Buffer[]} */
    const chunks = [];
    let read = 0;
    let newlines = 0;
    // n+1 newlines ⇒ n complete lines (whether or not the last line ends with "\n").
    while (pos > 0 && read < maxBytes && newlines <= n) {
      const len = Math.min(blockSize, pos, maxBytes - read);
      pos -= len;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const r = fs.readSync(fd, buf, got, len - got, pos + got);
        if (r === 0) break;
        got += r;
      }
      chunks.unshift(buf.subarray(0, got));
      read += len;
      for (const byte of buf) if (byte === 10) newlines += 1;
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (pos > 0) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n).map((l) => l.replace(/\r$/, ""));
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {number} pid @returns {boolean} is the process alive? (`kill(pid, 0)` only probes, sends no signal) */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * @template T
 * @param {() => T} fn @param {T} fallback
 * @returns {T}
 */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** @param {string} file @returns {string} */
function statSig(file) {
  try {
    const s = fs.statSync(file);
    return `${file}:${s.mtimeMs}:${s.size}`;
  } catch {
    return `${file}:-`;
  }
}

/** @param {string} dir @param {(name: string) => boolean} keep @returns {string[]} */
function dirSig(dir, keep) {
  const names = attempt(() => fs.readdirSync(dir).filter(keep).sort(), /** @type {string[]} */ ([]));
  return [`${dir}/`, ...names.map((n) => statSig(path.join(dir, n)))];
}

/**
 * Signature of the data sources: changes when the ledger (rotated files included) or any `tasks/*.md`, `tasks/questions/*.md`,
 * `requirements/*.md` changes mtime/size, or a worktree is added/removed. Much cheaper than re-reading.
 * @param {string} root @param {string|null} events @returns {string}
 */
function signature(root, events) {
  const md = (/** @type {string} */ n) => n.endsWith(".md");
  const tasks = path.join(root, "tasks");
  const parts = [
    ...(events === null ? [] : dirSig(path.dirname(events), (n) => /^events.*\.jsonl$/.test(n) || path.join(path.dirname(events), n) === events)),
    ...dirSig(tasks, md),
    ...dirSig(path.join(tasks, "questions"), md),
    ...dirSig(path.join(root, "requirements"), md),
    // Worktrees: directory names only (added/removed), no stat of each `.env` next to them.
    ...dirSig(path.join(root, ".claude", "worktrees"), () => false),
    ...attempt(() => fs.readdirSync(path.join(root, ".claude", "worktrees")).sort(), /** @type {string[]} */ ([])),
  ];
  return parts.join("\n");
}

/**
 * @typedef {object} Inputs  what is read from disk — changes when `signature` changes
 * @property {import("./events.mjs").AgentEvent[]} events
 * @property {import("./dashboard.mjs").Snapshot} snapshot
 * @property {{text: string, actions: unknown[]}} plan
 * @property {Map<string, import("./backlog.mjs").Task>} backlog
 * @property {import("./backlog.mjs").Bug[]} bugs
 * @property {Map<string, import("./backlog.mjs").Question>} questions
 * @property {import("./planner.mjs").Requirement[]} requirements
 */

/**
 * Reads disk (READ-ONLY). Any part that fails (half-written front-matter while an agent edits a file) keeps the
 * previous good read — the dashboard must not crash over a half-written task file.
 * @param {{root: string, events: string|null, workers: number, nowMs: number}} ctx
 * @param {Inputs|null} prev @returns {Inputs}
 */
function readInputs({ root, events, workers, nowMs }, prev) {
  const tasksDir = path.join(root, "tasks");
  const backlog = attempt(() => loadBacklog(tasksDir), prev?.backlog ?? new Map());
  const bugs = attempt(() => [...loadBugs(tasksDir).values()], prev?.bugs ?? []);
  const questions = attempt(() => loadQuestions(tasksDir), prev?.questions ?? new Map());
  const requirements = attempt(() => loadRequirements(path.join(root, "requirements")), prev?.requirements ?? []);
  const critical = attempt(() => criticalPath(path.join(tasksDir, "INDEX.md")), /** @type {string[]} */ ([]));
  const worktrees = attempt(() => listWorktrees(root).map((w) => w.id), /** @type {string[]} */ ([]));
  const inbox = attempt(() => fs.readFileSync(path.join(tasksDir, "INBOX.md"), "utf8"), "");

  const open = [...questions.values()].filter((q) => q.status === "open");
  /** @type {import("./dashboard.mjs").Snapshot} */
  const snapshot = {
    tasks: [...backlog.values()].map((t) => ({ id: t.id, title: t.title, status: t.status, gate: t.gate, owner: t.owner })),
    inbox: { questions: open.length, approvals: inboxCounts(inbox).approvals, items: open.map((q) => `${q.id} · ${q.title}`) },
    worktrees,
  };

  /** @type {import("./conductor.mjs").State} */
  const state = { backlog, running: [], bugs, plannerRunning: false, plannerWork: null, workers, worktrees, requirements, questions, critical };
  /** @type {Inputs["plan"]} */
  let plan;
  try {
    // Like `conductor --dry-run`: a real loop starts with `recover` (no live process to observe yet).
    const actions = [...recover(state, { alive: [], worktrees, now: nowMs }), ...tick(state)];
    plan = { text: renderPlan(actions), actions };
  } catch (err) {
    plan = { text: `(could not build plan: ${err instanceof Error ? err.message : String(err)})`, actions: [] };
  }
  return { events: events === null ? [] : readEvents(events), snapshot, plan, backlog, bugs, questions, requirements };
}

/** @param {string|undefined} header @returns {boolean} `Host` points at this machine (missing header = HTTP/1.0, allowed) */
function hostAllowed(header) {
  if (header === undefined) return true;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(header.trim());
  if (!m) return false;
  return LOOPBACK_HOSTS.includes(m[1].replace(/^\[|\]$/g, "").toLowerCase());
}

/** @param {string} dir @param {string} target @returns {boolean} `target` is INSIDE `dir` (not `dir` itself) */
function inside(dir, target) {
  return target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * Safe path of a log file declared in an event, or null if it escapes `<root>/logs/`
 * (symlinks included) or is not a regular file.
 * @param {string} root @param {string} log @returns {string|null}
 */
function safeLogPath(root, log) {
  const logsDir = path.resolve(root, "logs");
  const target = path.resolve(root, log);
  if (!inside(logsDir, target)) return null;
  try {
    const real = fs.realpathSync(target);
    if (!inside(fs.realpathSync(logsDir), real) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * @param {http.ServerResponse} res @param {number} status @param {string} type @param {string|Buffer} body
 * @param {Record<string, string>} [extra]
 */
function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}

const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

/**
 * Starts the server. Loopback only (other `host` → throws). Writes no file.
 * @param {{root: string, port?: number, host?: string, eventsFile?: string|null, now?: () => number, env?: NodeJS.ProcessEnv}} opts
 *   `eventsFile`: ledger path (default: `AGENT_QUEUE_EVENTS_FILE` or `<root>/logs/agent-queue/events.jsonl`;
 *   `null` = no ledger). `port` omitted → config `dashboard.port`.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startServer({ root, port, host = "127.0.0.1", eventsFile, now = Date.now, env = process.env }) {
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`Listens on loopback (127.0.0.1) only, refusing host "${host}"`);
  const projectConfig = loadProjectConfig(root);
  const listenPort = port ?? projectConfig.dashboard.port;
  const events = eventsFile === undefined ? ledgerPath(root, env) : eventsFile;
  const envWorkers = Number(env.AGENT_QUEUE_WORKERS);
  const workers = env.AGENT_QUEUE_WORKERS !== undefined && Number.isInteger(envWorkers) && envWorkers >= 0 ? envWorkers : projectConfig.workers;
  const warnPerTask = projectConfig.dashboard.tokenWarnPerTask;

  /** @type {string|null} */
  let seen = null;
  /** @type {Inputs|null} */
  let inputs = null;

  /** Current state: re-reads disk ONLY when the source signature changes; time/live pids are always recomputed. */
  function current() {
    const nowMs = now();
    const sig = signature(root, events);
    if (inputs === null || sig !== seen) {
      inputs = readInputs({ root, events, workers, nowMs }, inputs);
      seen = sig;
    }
    const state = buildState(inputs.events, inputs.snapshot, { isAlive, now: nowMs, workers, warnPerTask, plan: inputs.plan });
    return { state, json: JSON.stringify(state), key: JSON.stringify({ ...state, generatedAt: null }) };
  }

  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  /** @type {string|null} */
  let lastKey = null;
  let ticks = 0;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  /** @param {http.ServerResponse} res @param {string} json */
  const frame = (res, json) => res.write(`event: state\ndata: ${json}\n\n`);

  function poll() {
    ticks += 1;
    const { json, key } = current();
    if (key !== lastKey) {
      lastKey = key;
      for (const c of clients) frame(c, json);
    } else if (ticks % PING_EVERY === 0) {
      for (const c of clients) c.write(": ping\n\n");
    }
  }

  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch {
      if (res.headersSent) res.end();
      else send(res, 500, "text/plain; charset=utf-8", "Internal error\n");
    }
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function route(req, res) {
    if (!hostAllowed(req.headers.host)) return send(res, 403, "text/plain; charset=utf-8", "Host not allowed\n");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, "text/plain; charset=utf-8", "Read-only: only GET and HEAD are accepted\n", { Allow: "GET, HEAD" });
    }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML, PAGE_HEADERS);
    if (pathname === "/api/state") return send(res, 200, "application/json; charset=utf-8", current().json);
    if (pathname === "/api/flow") return flow(res, new URL(req.url ?? "/", "http://127.0.0.1").searchParams);
    if (pathname === "/api/stream") return stream(req, res);
    if (pathname.startsWith("/api/log/")) return log(res, pathname.slice("/api/log/".length));
    return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
  }

  /** Only assembles parameters; all computation lives in `flowFor`. @param {http.ServerResponse} res @param {URLSearchParams} query */
  function flow(res, query) {
    const text = "text/plain; charset=utf-8";
    const afterRaw = query.get("after");
    const after = afterRaw === null ? -1 : /^-?\d+$/.test(afterRaw) ? Number(afterRaw) : NaN;
    if (!Number.isSafeInteger(after) || after < -1) return send(res, 400, text, "after must be an integer ≥ -1\n");
    const nowMs = now();
    current();
    const body = flowFor(/** @type {Inputs} */ (inputs).events, {
      runId: query.get("runId"), after, reducedMotion: query.get("reducedMotion") === "1", isAlive, now: nowMs, workers,
    });
    if (body === null) return send(res, 404, text, "No such run\n");
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(body));
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function stream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    res.write("retry: 2000\n\n");
    const { json, key } = current();
    frame(res, json);
    if (clients.size === 0) lastKey = key;
    clients.add(res);
    res.on("close", () => {
      clients.delete(res);
      if (clients.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    });
    if (timer === null) {
      timer = setInterval(poll, POLL_MS);
      timer.unref();
    }
  }

  /** @param {http.ServerResponse} res @param {string} rawId */
  function log(res, rawId) {
    /** @type {string} */
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return send(res, 404, "text/plain; charset=utf-8", "No such agent\n");
    }
    const agent = current().state.agents.find((a) => a.agentId === id);
    if (!agent) return send(res, 404, "text/plain; charset=utf-8", "No such agent\n");
    const file = agent.log === null ? null : safeLogPath(root, agent.log);
    if (file === null) return send(res, 404, "text/plain; charset=utf-8", "This agent has no log yet\n");
    const lines = tail(file, LOG_LINES);
    return send(res, 200, "text/plain; charset=utf-8", maskSecrets(lines.length === 0 ? "" : `${lines.join("\n")}\n`));
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });

  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    port: address.port,
    async close() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const c of clients) c.end();
      clients.clear();
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
    },
  };
}

/** @param {string[]} argv @returns {number|null|"invalid"} port from `--port N`/`--port=N`; null = not given */
function portFromArgs(argv) {
  const at = argv.findIndex((a) => a === "--port" || a.startsWith("--port="));
  if (at === -1) return null;
  const raw = argv[at].includes("=") ? argv[at].slice("--port=".length) : argv[at + 1];
  const n = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw) && n <= 65535 ? n : "invalid";
}

// Run directly: `npm run agents:ui [-- --port N]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fromArgs = portFromArgs(process.argv.slice(2));
  if (fromArgs === "invalid") {
    process.stderr.write("--port must be an integer 0–65535\n");
    process.exit(2);
  }
  try {
    const root = projectRoot();
    const server = await startServer({ root, port: fromArgs ?? undefined });
    process.stdout.write(`Agent dashboard: http://127.0.0.1:${server.port}  (read-only · Ctrl+C to stop)\n`);
    const stop = () => {
      void server.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    process.stderr.write(code === "EADDRINUSE" ? "Port in use — pick another: npm run agents:ui -- --port N\n" : `Could not start the dashboard: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
