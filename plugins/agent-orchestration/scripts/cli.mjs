#!/usr/bin/env node
// @ts-check
/**
 * LAYER 3 (surface) — one entry point shared by humans AND every loop mechanism.
 *
 * Thanks to this surface, changing how the loop runs (Stop hook ⇄ headless
 * driver ⇄ CI) needs no change to Layer 1 or Layer 2: every mechanism only calls
 * `next` / `prompt` / `start` / `done`.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBacklog, loadBugs, loadQuestions, readyQueue, criticalPath, missingDeps, skillsFor } from "./backlog.mjs";
import { can, eventsFrom, InvalidTransitionError } from "./task.machine.mjs";
import { applyEvent, readStore, startSession, recordError, recordCompleted } from "./store.mjs";
import { verifyTask } from "./verify.mjs";
import { evaluateGate } from "./gates.mjs";
import { doctor } from "./doctor.mjs";
import { commitTask } from "./commit.mjs";
import { sessionReport } from "./report.mjs";
import { migrate } from "./migrate.mjs";
import { writeInbox } from "./inbox.mjs";
import { choosePattern, reassess, parseNumstat } from "./pattern.mjs";
import { syncPlanner, nextWork, loadRequirements } from "./planner.mjs";
import {
  createWorktree, removeWorktree, linkDependencies, cloneDependencies, workerEnv, workerOwner, isWorkerOwned, readDotenv, worktreePath,
  maskSecrets, envFilePath, renderEnv,
} from "./worker.mjs";
import { integrate } from "./integrator.mjs";
import { planInit, applyInit, defaultTemplatesDir } from "./init.mjs";
import { eventsFile, readEvents } from "./events.mjs";
import { foldAgents, usageBy, totalTokens } from "./dashboard.mjs";
import { execFileSync } from "node:child_process";
import { config } from "./config.mjs";
import { projectRoot } from "./project-config.mjs";
import { taskQuality, qualityBy, MIN_SAMPLES } from "./quality.mjs";
import { runReview, realReviewIo } from "./review.mjs";

/**
 * Every path in the system is relative to the repo root — where `tasks/` lives.
 * Without re-anchoring, running `npm run task` from a subdirectory (e.g. `packages/api`)
 * breaks (exactly the bug hit on first real use). Walk upwards instead of pinning to
 * the script location, so it also works on a fake backlog in tests.
 */
function findRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "tasks"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No `tasks/` yet (e.g. a new project before `init`): the root is the git root / the
  // directory holding the config — NOT the script location. In the plugin, scripts live in
  // the plugin cache directory; anchoring there writes the backlog to the wrong place (P-003).
  return projectRoot();
}
process.chdir(findRoot());

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const wantJson = argv.includes("--json");

/** @param {string} name */
function flag(name) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** @param {string} s */
function out(s) { process.stdout.write(`${s}\n`); }
/** @param {unknown} v */
function json(v) { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); }
/** @param {string} s */
function fail(s) { process.stderr.write(`${s}\n`); process.exit(1); }

/**
 * `7d` / `36h` → milliseconds. No match (or 0) → null.
 * @param {string} text @returns {number|null}
 */
function parseSince(text) {
  const m = /^(\d+)([dh])$/.exec(text);
  if (!m || Number(m[1]) === 0) return null;
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

/** @param {number} n */
const fmtInt = (n) => n.toLocaleString("en-US");

/**
 * Token table: one row per key, separate input/output/cache columns + total.
 * @param {string} title @param {string} keyHeader
 * @param {Record<string, import("./dashboard.mjs").UsageBucket>} rows
 * @returns {string[]}
 */
function usageTable(title, keyHeader, rows) {
  const entries = Object.entries(rows);
  const width = Math.max(keyHeader.length, ...entries.map(([k]) => k.length));
  // A-050: USD and peak context come first — "total" sums cache reads across every call, for reference only.
  const cols = ["agent", "USD", "output", "peak context", "cacheRead", "cacheWrite", "input", "total"];
  const cell = (/** @type {string} */ v, /** @type {number} */ i) => v.padStart(Math.max(cols[i].length, 11));
  const line = (/** @type {string} */ key, /** @type {string[]} */ vals) => `${key.padEnd(width)} ${vals.map(cell).join(" ")}`;
  return [
    title,
    line(keyHeader, cols),
    // A-091: a group with only agents of unknown usage (usage null) prints `—` in every token column, not 0.
    ...entries.map(([k, b]) => b.agents === 0 && b.unknown > 0 ? line(k, ["0", ...Array(cols.length - 1).fill("—")]) : line(k, [
      fmtInt(b.agents), b.costUsd === null ? "—" : `$${b.costUsd.toFixed(2)}`, fmtInt(b.output),
      b.peakContext === null ? "—" : fmtInt(b.peakContext), fmtInt(b.cacheRead), fmtInt(b.cacheWrite), fmtInt(b.input), fmtInt(b.tokens),
    ])),
    "",
  ];
}

/** @param {string|undefined} id */
function mustFind(id) {
  if (!id) fail(`Missing task id. Example: ${config.cliHint} start A-001`);
  const backlog = loadBacklog();
  const task = backlog.get(/** @type {string} */ (id));
  if (!task) fail(`No task ${id}`);
  return { task: /** @type {import("./backlog.mjs").Task} */ (task), backlog };
}

/**
 * Working-tree diff against HEAD — each task is one commit, so this is the current
 * task's share. `git diff` does not see untracked files, so they are counted separately.
 * Not a git repo → empty diff, no throw.
 * @returns {import("./pattern.mjs").DiffStat}
 */
function workingDiff() {
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const tracked = parseNumstat(git(["diff", "--numstat", "HEAD"]));
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter((f) => f !== "")
      .map((f) => ({ path: f, added: fs.readFileSync(f, "utf8").split("\n").length, deleted: 0 }));
    return { files: [...tracked.files, ...untracked] };
  } catch {
    return { files: [] };
  }
}

/**
 * The task in `doing` in THIS worktree, if any. Invariant: at most one at a time.
 * Tasks assigned to a worker (`owner: worker:w<n>`) live in their own worktree and don't count.
 */
function currentTask() {
  const backlog = loadBacklog();
  const doing = [...backlog.values()].filter((t) => t.status === "doing" && !isWorkerOwned(t.owner));
  if (doing.length > 1) {
    fail(`${doing.length} tasks are in doing at once: ${doing.map((t) => t.id).join(", ")}`);
  }
  return doing[0] ?? null;
}

const commands = {
  /** Table of the whole backlog. */
  status() {
    const backlog = loadBacklog();
    const rows = [...backlog.values()].map((t) => ({
      id: t.id,
      status: t.status,
      gate: evaluateGate(t).reason,
      missing: missingDeps(t, backlog),
      title: t.title,
    }));
    const filter = flag("block");
    const shown = filter ? rows.filter((r) => r.id.startsWith(filter)) : rows;
    if (wantJson) return json(shown);

    out(`${"ID".padEnd(6)} ${"status".padEnd(12)} ${"waiting on".padEnd(14)} title`);
    out("-".repeat(78));
    for (const r of shown) {
      const waiting = r.missing.length > 0 ? r.missing.join(",") : "—";
      out(`${r.id.padEnd(6)} ${r.status.padEnd(12)} ${waiting.padEnd(14)} ${r.title.slice(0, 40)}`);
    }
    const counts = shown.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));
    out("");
    out(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · "));
  },

  /** Next task. Exit code 1 when nothing is left — so the shell stops the loop. */
  next() {
    const backlog = loadBacklog();
    const queue = readyQueue(backlog, criticalPath());
    const task = queue[0];
    if (!task) {
      if (wantJson) json(null);
      else out("No ready tasks left.");
      process.exit(1);
    }
    const gate = evaluateGate(task);

    // `--plain` for the shell: print only the id, with exit codes DISTINGUISHING the two
    // stop reasons — 1 = nothing left, 2 = hit a gate. The driver needs this to report correctly.
    if (argv.includes("--plain")) {
      if (gate.gated) {
        process.stderr.write(`${task.id}: ${gate.reason}\n`);
        process.exit(2);
      }
      out(task.id);
      return;
    }

    if (wantJson) return json({ id: task.id, title: task.title, ...gate });
    out(`${task.id} · ${task.title}`);
    if (gate.gated) out(`⚠ needs human approval: ${gate.reason}`);
  },

  /** Full prompt for the agent. */
  prompt(id = argv[1]) {
    const { task } = mustFind(id);
    const skills = skillsFor(task);
    const text = [
      `Do task ${task.id}: ${task.title}`,
      "",
      `Read the conventions in AGENTS.md before changing anything. The task is in ${task.file}:`,
      "",
      task.body.trim(),
      "",
      ...(skills.length
        ? [
            "---",
            `This task falls within the scope of ${skills.length > 1 ? "skills" : "skill"} ${skills
              .map((s) => `\`${s}\``)
              .join(" and ")}.`,
            ...skills.map(
              (s) =>
                `  - .claude/skills/${s}/SKILL.md — read the section at the top of the file that applies it to ${config.projectName ?? "this repo"} FIRST,` +
                " because the generic skill contradicts the repo conventions on a few points.",
            ),
            "",
          ]
        : []),
      "---",
      "When finished: Do NOT edit the `status` field and do not mark the task done yourself.",
      "The checker (`" + config.cliHint + " done " + task.id + "`) runs the following commands, and only it",
      "may conclude that the task is done:",
      ...task.verify.map((c) => `  - ${c}`),
    ].join("\n");
    if (wantJson) return json({ id: task.id, prompt: text });
    out(text);
  },

  /** todo → doing. Refuses if another task is in progress. */
  start(id = argv[1]) {
    const { task } = mustFind(id);
    const current = flag("worker") === undefined ? currentTask() : null;
    if (current && current.id !== task.id) {
      fail(`Task ${current.id} is in progress. Run \`release\` first to drop it.`);
    }
    if (task.status === "doing") {
      if (wantJson) return json({ id: task.id, status: "doing", already: true });
      return out(`${task.id} is already in doing.`);
    }
    const slot = flag("worker");
    if (slot !== undefined) {
      // Assign to a worker: does not occupy the main worktree's slot, but is capped.
      const backlog = loadBacklog();
      const busy = [...backlog.values()].filter((t) => t.status === "doing" && isWorkerOwned(t.owner));
      if (busy.length >= config.workers) fail(`All ${config.workers} workers are busy (AGENT_QUEUE_WORKERS).`);
      const to = applyEvent(task, task.status === "todo" ? "claim" : "retry", { owner: workerOwner(Number(slot)) });
      return wantJson ? json({ id: task.id, status: to, worker: slot }) : out(`${task.id} → ${to} (worker w${slot})`);
    }
    // Owner = id of the Claude Code session issuing the command (the Bash tool has `CLAUDE_CODE_SESSION_ID`), so the
    // Stop hook of that very session closes the task. Outside Claude Code → `local-*`: unowned, any session may take it.
    // Do NOT use `sessionId` from the store: that is the session that last chained a task, possibly a different one.
    const sessionId = flag("session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? `local-${process.pid}`;
    startSession(sessionId);
    const to = applyEvent(task, task.status === "todo" ? "claim" : "retry", { owner: sessionId });
    if (wantJson) return json({ id: task.id, status: to });
    out(`${task.id} → ${to}`);
  },

  /** Run the verify commands, WITHOUT changing status. */
  async verify(id = argv[1]) {
    const { task } = mustFind(id);
    const result = await verifyTask(task, config, { manualOk: argv.includes("--manual-ok") });
    if (wantJson) json({ id: task.id, ...result });
    else {
      for (const r of result.results) {
        const mark = r.outcome === "passed" ? "✓" : r.outcome === "skipped" ? "–" : "✗";
        out(`${mark} ${r.command}  (${r.durationMs}ms)`);
        if (r.outcome === "failed") out(r.output.split("\n").map((l) => `    ${l}`).join("\n"));
      }
      out(result.ok ? "\nPassed." : `\nNot passed: ${result.reason}`);
    }
    process.exit(result.ok ? 0 : 1);
  },

  /** verify green → done. NO shortcut. */
  async done(id = argv[1]) {
    const { task } = mustFind(id);
    // `--manual-ok`: a human confirms they checked what the machine cannot.
    // Deliberately ABSENT from the automated flow — hooks never pass this flag.
    const manualOk = argv.includes("--manual-ok");
    if (manualOk && task.manual.length > 0) {
      out(`Human confirmed checking: ${task.manual.join(" · ")}`);
    }
    const result = await verifyTask(task, config, { manualOk });
    if (!result.ok) {
      recordError(task.id, result.reason ?? "unknown");
      if (wantJson) json({ id: task.id, ...result, ok: false });
      else {
        for (const r of result.results.filter((x) => x.outcome === "failed")) {
          out(`✗ ${r.command}`);
          out(r.output);
        }
        out(`Not passed: ${result.reason} — NOT marking done.`);
      }
      process.exit(1);
    }
    // `needs-human` + `--manual-ok` means the human is confirming right now — making them
    // also type `approve` adds friction, not safety.
    let current = task;
    if (current.status === "needs-human" && manualOk) {
      applyEvent(current, "approve");
      current = mustFind(current.id).task;
    }
    if (current.status === "done") {
      // An agent in a headless session with full Bash access (running with
      // --dangerously-skip-permissions) may have called this `done` itself despite
      // the prompt telling it not to mark the task done. Verify just ran green and
      // the status is already done — nothing is wrong, we're just one beat late. Do NOT
      // applyEvent a second time: the `done` state does not accept the `pass` event.
      if (wantJson) return json({ id: task.id, status: "done", ok: true, alreadyDone: true });
      return out(`${current.id} was already done before this command ran — nothing more to do.`);
    }
    if (current.status !== "doing") {
      fail(`${current.id} is in \`${current.status}\`, must \`start\` first.`);
    }
    const to = applyEvent(current, "pass", { owner: null });
    recordCompleted(current.id);

    // The "task done" boundary is the commit boundary: every commit in history is
    // a state confirmed by the verify commands.
    // Do NOT pass sessionId: the id in the session store is set by the CLI itself
    // (`local-<pid>`), not a real Claude session id. Writing it into
    // `Claude-Session:` would produce a URL that doesn't open — worse than leaving it empty.
    // Only the Stop hook has the real id, passed in by Claude Code.
    const commit = commitTask(current);

    if (wantJson) return json({ id: task.id, status: to, ok: true, commit });
    out(`${task.id} → ${to}`);
    out(commit.committed ? `  commit ${commit.sha} — ${commit.reason}` : `  no commit: ${commit.reason}`);
  },

  /** Return the task to todo. */
  release(id = argv[1]) {
    const task = id ? mustFind(id).task : currentTask();
    if (!task) return out("No task in progress.");
    const to = applyEvent(task, "release", { owner: null });
    if (wantJson) return json({ id: task.id, status: to });
    out(`${task.id} → ${to}`);
  },

  /** Move to needs-human. */
  gate(id = argv[1]) {
    const { task } = mustFind(id);
    const reason = flag("reason") ?? evaluateGate(task).reason ?? "needs a human look";
    // The task may already have moved to `done` between the previous command and this
    // gate (a headless agent ran `done` despite the prompt) — `done` does not accept the
    // `gate` event. Report the real status instead of letting applyEvent throw uncaught
    // and crash the whole headless driver.
    if (!can(task.status, "gate")) {
      if (wantJson) return json({ id: task.id, status: task.status, ok: false, reason: `cannot gate from \`${task.status}\`` });
      return out(`${task.id} is in \`${task.status}\` — no gate needed.`);
    }
    const to = applyEvent(task, "gate", { owner: null });
    recordError(task.id, reason);
    if (wantJson) return json({ id: task.id, status: to, reason });
    out(`${task.id} → ${to} (${reason})`);
  },

  /** Human approval done. */
  approve(id = argv[1]) {
    const { task } = mustFind(id);
    const to = applyEvent(task, "approve");
    if (wantJson) return json({ id: task.id, status: to });
    out(`${task.id} → ${to}`);
  },

  /** End-of-run report. */
  report() {
    const backlog = loadBacklog();
    const store = readStore();
    if (wantJson) return json({ store, text: sessionReport(backlog, store) });
    out(sessionReport(backlog, store));
  },

  /**
   * Tokens by role and by model from the event log (CLI version of the dashboard's Token panel).
   * `--since 7d|36h` (default 7d), `--json` prints `usageBy(...)` as is.
   */
  usage() {
    const since = flag("since") ?? "7d";
    const windowMs = parseSince(since);
    if (windowMs === null) fail(`--since must be <n>d or <n>h (e.g. 7d, 36h), got: ${since}`);
    const now = Date.now();
    const file = eventsFile(process.cwd());
    const events = file === null ? [] : readEvents(file);
    // Only finished agents carry usage, so `isAlive` does not affect the result.
    const agents = foldAgents(events, { isAlive: () => true, now });
    const usage = usageBy(agents, { sinceMs: now - /** @type {number} */ (windowMs), now });
    if (wantJson) return json(usage);

    const t = usage.total;
    out(`Tokens in the last ${since} — ${t.agents} finished agents`);
    out("");
    for (const l of usageTable("By role", "role", usage.byRole)) out(l);
    for (const l of usageTable("By model", "model", usage.byModel)) out(l);
    if (t.costUsd !== null) out(`Estimated cost: ~$${t.costUsd.toFixed(2)} USD equivalent (not an invoice)`);
    out(`Output: ${fmtInt(t.output)} tokens · peak context: ${t.peakContext === null ? "—" : fmtInt(t.peakContext)}`);
    out(`Total: ${fmtInt(totalTokens(t))} tokens${t.unknown > 0 ? ` (${t.unknown} agents with unknown usage)` : ""} (input ${fmtInt(t.input)} · output ${fmtInt(t.output)} · cacheRead ${fmtInt(t.cacheRead)} · cacheWrite ${fmtInt(t.cacheWrite)}) — summed over every call, not comparable to an interactive session's token count`);
  },

  /**
   * Agent quality from the event log: first-pass verify rate, verify runs per task, `failed` rate,
   * findings and bugs per task — by model, developer role, pattern. `--since 14d` (default), `--json` prints
   * `{since, tasks, ...qualityBy(...)}` as is. Use it to compare before/after changing agent prompts, models or patterns.
   */
  quality() {
    const since = flag("since") ?? "14d";
    const windowMs = parseSince(since);
    if (windowMs === null) fail(`--since must be <n>d or <n>h (e.g. 14d, 36h), got: ${since}`);
    const now = Date.now();
    const file = eventsFile(process.cwd());
    const events = file === null ? [] : readEvents(file, { sinceMs: now - /** @type {number} */ (windowMs) });
    const agents = foldAgents(events, { isAlive: () => true, now });
    /** @type {{id: string, parent: string}[]} */
    let bugs = [];
    try {
      bugs = [...loadBugs(config.tasksDir).values()].map((b) => ({ id: b.id, parent: b.parent }));
    } catch {
      // A broken bug file is `doctor`'s business; metrics still run with the `B-*` ids seen in the log.
    }
    const rows = taskQuality(events, agents, { isDeveloper: (role) => config.roles[role]?.kind === "developer", bugs });
    const q = qualityBy(rows);
    if (wantJson) return json({ since, tasks: rows, ...q });

    /** @param {number} r */
    const pct = (r) => `${Math.round(r * 100)}%`;
    /** @param {string} title @param {string} keyHeader @param {Record<string, import("./quality.mjs").QualityBucket>} groups
     *  @param {Record<string, string|null>} [labels] group key → printed label; `null` = skip group; undeclared keys print as is */
    const table = (title, keyHeader, groups, labels = {}) => {
      out(title);
      out(`  ${keyHeader.padEnd(22)} ${"task".padStart(5)} ${"first-pass".padStart(14)} ${"runs/task".padStart(10)} ${"failed".padStart(7)} ${"finding".padStart(8)} ${"bug".padStart(5)} ${"$/task".padStart(8)}`);
      for (const [key, b] of Object.entries(groups)) {
        const k = labels[key] === undefined ? key : labels[key];
        if (k === null) continue;
        out(`  ${k.padEnd(22)} ${String(b.tasks).padStart(5)} ${pct(b.firstPassRate).padStart(14)} ${b.avgVerifyRuns.toFixed(2).padStart(10)} ${pct(b.failedRate).padStart(7)} ${String(b.findings).padStart(8)} ${String(b.bugs).padStart(5)} ${(b.medianCostUsd === null ? "—" : `$${b.medianCostUsd.toFixed(2)}`).padStart(8)}${b.tasks < MIN_SAMPLES ? "  (few samples)" : ""}`);
      }
      out("");
    };

    const t = q.total;
    out(`Agent quality in the last ${since} — ${t.tasks} tasks with verify`);
    if (t.tasks === 0) {
      out("The log has no `verify.result` in this window (only the conductor emits verify events).");
      return;
    }
    out(`First-pass green: ${pct(t.firstPassRate)} (${t.firstPass}/${t.tasks}) · ${t.avgVerifyRuns.toFixed(2)} verify runs/task · failed ${pct(t.failedRate)} · ${t.findings} finding · ${t.bugs} bug`);
    out("");
    table("By model (first developer of the task)", "model", q.byModel);
    table("By developer role", "role", q.byRole);
    table("By pattern", "pattern", q.byPattern);
    table("By developer session start (first session of the task)", "session", q.bySession, { fresh: "fresh", chained: "chained from previous task" });
    table("Reruns after red verify", "rerun", q.byRetry, { none: null, resumed: "resumed session", fresh: "fresh session" });
    if (q.worst.length > 0) {
      out("Read these logs first (most verify runs / failed):");
      for (const r of q.worst) {
        out(`  ${r.taskId.padEnd(8)} ${String(r.verifyRuns).padStart(2)} runs · ${r.outcome ?? "—"} · ${r.model ?? "—"} — logs/agent-queue/${r.taskId}/`);
      }
    }
    out(`$/task is the median "equivalent" cost, not an invoice. Groups < ${MIN_SAMPLES} tasks: rates mean nothing yet.`);
  },

  /**
   * Rerun ONE reviewer on a finished task to replace a broken report (A-074). `--role <role>` is required,
   * `--dry-run` only prints the plan, `--json` prints the `ReviewResult` as is. No status change, no commit.
   * Exits 0 when the new report is well-formed (with or without findings); ≠ 0 when refused or still missing JSON after all attempts.
   */
  async review() {
    const id = argv[1];
    if (!id || id.startsWith("--")) fail(`Missing task id. Example: ${config.cliHint} review T-282 --role security`);
    const task = loadBacklog().get(id);
    const result = await runReview(
      { task, id, role: flag("role"), dryRun: argv.includes("--dry-run") },
      realReviewIo(process.cwd()),
    );
    if (wantJson) json(result);
    else for (const line of result.lines) {
      if (result.exit === 0) out(line);
      else process.stderr.write(`${line}\n`);
    }
    process.exitCode = result.exit;
  },

  /** Inspect the backlog. */
  doctor() {
    const result = doctor();
    if (wantJson) json(result);
    else {
      const summary = Object.entries(result.byStatus).map(([k, v]) => `${k}=${v}`).join(" · ");
      out(`${result.total} task · ${summary}`);
      for (const p of result.problems) out(`  ✗ ${p}`);
    }
    process.exit(result.ok ? 0 : 1);
  },

  /**
   * Orchestration pattern of one task, or of every todo/doing task. For a task in
   * `doing`, measure the real diff and also print an escalate/downgrade event if any.
   */
  pattern(id = argv[1]) {
    const backlog = loadBacklog();
    const tasks = id && !id.startsWith("--")
      ? [mustFind(id).task]
      : [...backlog.values()].filter((t) => t.status === "todo" || t.status === "doing");
    const rows = tasks.map((t) => {
      const choice = choosePattern(t);
      const shift = t.status === "doing" ? reassess(t, workingDiff()) : null;
      return { id: t.id, status: t.status, ...choice, shift };
    });
    if (wantJson) return json(rows);
    for (const r of rows) {
      const extra = r.evaluate.length > 0 ? ` +${r.evaluate.join(" +")}` : "";
      out(`${r.id.padEnd(6)} ${`${r.core}${extra}`.padEnd(30)} ${r.reason}`);
      if (r.shift) out(`${"".padEnd(6)} ⚠ ${r.shift.event}: ${r.shift.reason}`);
    }
  },

  /**
   * Machinery around the planner (docs/agent-orchestration.md §4).
   *   planner sync  harvest answers from INBOX, unblock, draft → todo/needs-decision, regenerate INBOX
   *   planner next  next work item for the planner; exits 1 when nothing is left
   */
  planner(sub = argv[1]) {
    if (sub === "sync") {
      const r = syncPlanner(config.tasksDir);
      if (wantJson) return json(r);
      for (const q of r.plan.record) out(`✓ ${q.id} answered`);
      for (const u of r.plan.unblock) out(`↺ ${u.id} unblocked${u.event ? " → draft" : ""}`);
      for (const m of r.moves) out(`${m.event === "ready" ? "→ todo " : "? ask   "} ${m.id}`);
      for (const n of r.notReady) out(`… ${n.id}: ${n.missing.join(" · ")}`);
      if (r.plan.record.length + r.plan.unblock.length + r.moves.length === 0) out("Nothing changed.");
      return;
    }
    if (sub === "next") {
      const work = nextWork(loadRequirements(config.requirementsDir), loadBacklog(), loadQuestions());
      if (wantJson) json(work);
      else if (work?.kind === "requirement") out(`requirement ${work.file}`);
      else if (work?.kind === "revise") {
        out(`revise ${work.id} — ${work.missing.join(" · ")}`);
        // Verbatim answers go into the prompt: the planner rewrites accordingly, then removes the revise-for marker.
        for (const [q, a] of Object.entries(work.answers)) out(`  ${q} answered: ${a.replace(/\n/g, " ")}`);
      }
      else out("No work left for the planner.");
      process.exit(work ? 0 : 1);
    }
    fail("Usage: planner sync | planner next");
  },

  /**
   * Worktrees for parallel tasks (A-011).
   *   worker add <id> <slot>  create `.claude/worktrees/<id>` + print the worker's env
   *   worker rm <id>          remove the worktree + branch
   */
  worker(sub = argv[1]) {
    const id = argv[2];
    if (!id) fail("Usage: worker add <id> <slot> | worker rm <id>");
    const root = process.cwd();
    if (sub === "add") {
      const slot = Number(argv[3]);
      if (!Number.isInteger(slot) || slot < 1) fail("slot must be an integer ≥ 1");
      const wt = createWorktree(root, id);
      // Dependencies symlinked from the main worktree — a new worktree has no node_modules (A-018).
      const deps = linkDependencies(root, wt.path, config.workerLinkDirs);
      // Tool directories that can't tolerate symlinks pointing outside the project (Turbopack) are copied copy-on-write (A-081).
      const cloned = cloneDependencies(root, wt.path, config.workerCloneDirs);
      const testDatabaseUrl = process.env[config.testDbEnvVar] ?? (config.testDbEnvFile ? readDotenv(config.testDbEnvFile, config.testDbEnvVar) : null);
      const env = workerEnv(slot, { testDatabaseUrl, testDbEnvVar: config.testDbEnvVar, schemaParam: config.testDbSchemaParam });
      // The full version (with the DB password) goes only to a gitignored file; the screen only shows the masked one.
      const envFile = envFilePath(root, id);
      fs.writeFileSync(envFile, renderEnv(env), { mode: 0o600 });
      const shown = maskSecrets(renderEnv(env));
      if (wantJson) return json({ ...wt, deps, cloned, envFile, env: JSON.parse(maskSecrets(JSON.stringify(env))) });
      out(`${wt.created ? "Created" : "Reusing"} ${wt.path} (${wt.branch})`);
      if (deps.linked.length > 0) out(`Dependency (symlink): ${deps.linked.join(", ")}`);
      if (cloned.cloned.length > 0) {
        out(`Dependency (copied): ${cloned.cloned.join(", ")}`);
        if (cloned.slow.length > 0) out(`  ${cloned.slow.join(", ")}: plain copy (filesystem does not support clone)`);
      }
      out(`Worker env: ${envFile} — load it with \`source\` before running an agent in the worktree.`);
      out(shown.trimEnd());
      return;
    }
    if (sub === "rm") {
      removeWorktree(root, id, config.workerLinkDirs, config.workerCloneDirs);
      fs.rmSync(envFilePath(root, id), { force: true });
      return out(`Removed worktree + branch of ${id}`);
    }
    fail("Usage: worker add <id> <slot> | worker rm <id>");
  },

  /** Integrate a worker branch: rebase → re-verify → fast-forward merge. No status change. */
  integrate(id = argv[1]) {
    if (!id) fail("Usage: integrate <id> [--slot n]");
    const slot = Number(flag("slot") ?? "0");
    const testDatabaseUrl = process.env[config.testDbEnvVar] ?? (config.testDbEnvFile ? readDotenv(config.testDbEnvFile, config.testDbEnvVar) : null);
    const env = slot > 0 ? workerEnv(slot, { testDatabaseUrl, testDbEnvVar: config.testDbEnvVar, schemaParam: config.testDbSchemaParam }) : {};
    const r = integrate(process.cwd(), id, { env });
    if (wantJson) return json(r);
    if (r.ok) return out(`✓ ${id} integrated — ${r.sha}. Worktree remains at ${worktreePath(process.cwd(), id)}.`);
    if (r.stage === "rebase") return fail(`✗ ${id} conflicts during rebase: ${r.conflicts.join(", ")}`);
    return fail(`✗ ${id} failed at stage ${r.stage}:\n${r.output}`);
  },

  /**
   * Scaffold the queue for a project (P-004). NEVER overwrites: existing files are kept,
   * existing `AGENTS.md`/`.gitignore` only get the missing parts appended. Safe to rerun.
   */
  init() {
    const root = process.cwd();
    const name = flag("name") ?? path.basename(root);
    const report = applyInit(root, planInit(root, defaultTemplatesDir(), { projectName: name }));
    if (wantJson) return json(report);
    for (const f of report.created) out(`+ ${f}`);
    for (const f of report.appended) out(`~ ${f} (appended)`);
    for (const f of report.kept) out(`= ${f} (kept)`);
    out("");
    out(report.created.length + report.appended.length === 0
      ? "Scaffold already present — nothing changed."
      : "Done. Next: declare `skills` and risk rules in .claude/agent-queue.config.json; write requirements into requirements/.");
  },

  /** Regenerate `tasks/INBOX.md` — keeps answers humans already typed. */
  inbox() {
    const { file, text } = writeInbox(config.tasksDir);
    if (wantJson) return json({ file, text });
    out(`Wrote ${file}`);
    for (const line of text.split("\n").filter((l) => /^## /.test(l))) out(`  ${line.slice(3)}`);
  },

  /** Convert legacy files to front-matter. Preview by default; `--write` actually writes. */
  migrate() {
    const write = argv.includes("--write");
    const result = migrate({ write });
    out("");
    out(`${write ? "Converted" : "Would convert"} ${result.converted.length} files · skipped ${result.skipped.length}`);
    if (!write) out("Add --write to actually write.");
  },

  help() {
    out([
      `${config.cliHint} <command>`,
      "",
      "  status [--block A]   table of the whole backlog",
      "  next [--plain]       next task (exit 1 = nothing left, 2 = hit a gate)",
      "  prompt <id>          full prompt for the agent",
      "  start <id>           todo → doing",
      "  verify <id>          run verify commands, no status change",
      "  done <id>            verify green → done (no shortcut)",
      "  done <id> --manual-ok  a human confirms checking what the machine cannot",
      "  release [id]         → todo",
      "  gate <id> --reason   → needs-human",
      "  approve <id>         needs-human → doing",
      "  report               end-of-run report",
      "  usage [--since 7d]   tokens by role / model from the event log (7d, 36h; --json prints usageBy)",
      "  quality [--since 14d]  agent quality: first-pass green, verify runs, failed, findings, bugs — by model/role/pattern",
      "  review <id> --role <role> [--dry-run]  rerun one reviewer on a done/needs-human task, replacing a broken report with a real one",
      "  doctor               check backlog invariants",
      "  init [--name X]      scaffold the project (never overwrites)",
      "  inbox                regenerate tasks/INBOX.md (questions · awaiting approval · conflicts)",
      "  planner sync         harvest INBOX answers, unblock, draft → todo once context is complete",
      "  planner next         next work item for the planner (exit 1 = nothing left)",
      "  start <id> --worker n  todo → doing, assigned to worker n (does not occupy the main worktree)",
      "  worker add <id> <n>  create a worktree + print its own env (DB schema, e2e port)",
      "  worker rm <id>       remove worktree + branch",
      "  integrate <id> [--slot n]  rebase → re-verify → ff merge; no status change",
      "  pattern [id]         orchestration pattern + reason; for doing tasks, measure the diff and report escalate/downgrade",
      "  migrate [--write]    convert legacy files to front-matter",
      "",
      "  Add --json to any command when calling from a script.",
    ].join("\n"));
  },
};

const handler = /** @type {Record<string, (id?: string) => unknown>} */ (commands)[command];
if (!handler) {
  process.stderr.write(`No command \`${command}\`.\n`);
  commands.help();
  process.exit(1);
}
try {
  await handler();
} catch (err) {
  // A wrong transition is the user's mistake, not the CLI's — one line of explanation, no stack trace.
  if (!(err instanceof InvalidTransitionError)) throw err;
  const valid = eventsFrom(err.from);
  fail(`${argv[1] ? `${argv[1]}: ` : ""}${err.message}. ${valid.length > 0
    ? `Valid events from \`${err.from}\`: ${valid.join(", ")}.`
    : `\`${err.from}\` is a terminal state — to redo it, open a new task that depends on it.`}`);
}
