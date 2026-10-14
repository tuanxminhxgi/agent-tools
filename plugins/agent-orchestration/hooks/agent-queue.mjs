#!/usr/bin/env node
// @ts-check
/**
 * LAYER 3 — Stop hook that chains tasks automatically.
 *
 * Runs whenever the agent ends its turn. Runs the current task's verify commands; when
 * green, marks it done and loads the next task by BLOCKING the stop
 * (`{"decision":"block","reason":...}` — Claude Code reads `reason` as a new
 * request). So the agent keeps going without anyone typing.
 *
 * This file only EXECUTES. Every decision lives in `hook-decision.mjs` as pure
 * functions with their own tests.
 *
 * Inviolable rule: **never break the session**. Every unexpected error is logged
 * and the hook exits 0, just like an `auto-commit` hook.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR ?? path.resolve(HERE, "../..");
const QUEUE = path.join(HERE, "..", "scripts");

/** @param {string} message */
function log(message) {
  try {
    const file = path.join(ROOT, ".claude", "agent-queue.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A broken log write must not break the session either.
  }
}

/** @param {string} reason */
function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw === "" ? {} : JSON.parse(raw);
}

async function main() {
  // Fully disabled → exit IMMEDIATELY: no stdin, no module loading, no backlog, no logging
  // (the conductor sets this for every child session — hundreds of lines per run nobody reads).
  if (process.env.AGENT_QUEUE_DISABLE === "1") process.exit(0);
  process.chdir(ROOT);
  // A worker session (own worktree, A-011) does not verify/commit/chain by itself: the integrator
  // re-checks after rebase and merges serially in the main worktree.
  if (process.env.AGENT_QUEUE_ROLE === "worker") {
    log(`early exit: worker session ${process.env.AGENT_QUEUE_WORKER ?? "?"} — the integrator will verify`);
    process.exit(0);
  }


  const input = /** @type {any} */ (await readStdin().catch(() => ({})));

  const [{ loadBacklog, readyQueue, criticalPath, projectDone }, { config }, decision,
         { verifyTask }, { gateBeforeStart },
         { applyEvent, readStore, startSession, bumpChain, recordCompleted, recordFailure, resetFailures },
         { commitTask }, { ciGateNow, ciClosedStopReason }] =
    await Promise.all([
      import(path.join(QUEUE, "backlog.mjs")),
      import(path.join(QUEUE, "config.mjs")),
      import(path.join(QUEUE, "hook-decision.mjs")),
      import(path.join(QUEUE, "verify.mjs")),
      import(path.join(QUEUE, "gates.mjs")),
      import(path.join(QUEUE, "store.mjs")),
      import(path.join(QUEUE, "commit.mjs")),
      import(path.join(QUEUE, "ci-status.mjs")),
    ]);

  const backlog = loadBacklog();
  // Only THIS session's task (or an unheld one). Tasks of the conductor, a worker (`worker:w<n>`,
  // verified in its own worktree) or another session are skipped — see `pickOwnTask`.
  const doing = [...backlog.values()].filter((t) => t.status === "doing");
  const { current, skipped } = decision.pickOwnTask(doing, input.session_id ?? null);
  for (const t of skipped) log(`skip ${t.id}: held by ${t.owner}, not session ${input.session_id ?? "?"}`);

  // `stop_hook_active` is NO LONGER a reason to exit (A-015): it is set on every stop
  // right after a block, so relying on it means the task just finished never gets
  // settled. The loop guard is now two capped counters — see hook-decision.mjs.
  const pre = decision.decidePre({
    disabled: config.disabled,
    currentId: current ? current.id : null,
  });
  if (pre.action === "exit") {
    log(`early exit: ${pre.reason}`);
    process.exit(0);
  }

  const task = /** @type {import("../scripts/backlog.mjs").Task} */ (current);
  // Run the verify commands even when the task has `manual:` — automated part green moves the task
  // to needs-human and the chain continues; never make the agent "fix" what only a human can do.
  const result = await verifyTask(task, config, { manualOk: true });
  const failCount = result.ok ? 0 : recordFailure(task.id);
  if (result.ok) resetFailures();

  // The next task must be computed on the state AFTER the current task is done — computed
  // before, every task depending on it is still blocked and the loop thinks it ran out of work.
  const settlesDone = result.ok && task.manual.length === 0;
  const projected = settlesDone ? projectDone(backlog, task.id) : backlog;
  const queue = readyQueue(projected, criticalPath()).filter((t) => t.id !== task.id);
  const nextTask = queue[0] ?? null;
  const store = readStore();
  // A-084: with the CI gate closed the session's task is still settled/committed (not pushed), but the next task is not loaded.
  const gate = ciGateNow(ROOT, config.ci);
  const ciClosed = gate.closed && gate.status && config.ci
    ? { reason: ciClosedStopReason(gate.status, config.ci.branch, gate.unpushed) }
    : null;

  const post = decision.decidePost({
    currentId: task.id,
    manual: task.manual,
    failCount,
    maxRetries: config.maxRetries,
    verify: {
      ok: result.ok,
      reason: result.reason,
      failures: result.results
        .filter((r) => r.outcome !== "passed")
        .map((r) => ({ command: r.command, output: r.output })),
    },
    next: nextTask
      ? { id: nextTask.id, title: nextTask.title, prompt: promptFor(nextTask) }
      : null,
    nextGate: nextTask ? gateBeforeStart(nextTask) : null,
    chained: store.chained,
    maxChain: config.maxChain,
    ciClosed,
  });

  if (post.markFailed) {
    applyEvent(task, "fail", { owner: null });
    resetFailures();
    log(`${task.id} → failed (${failCount} failures in a row)`);
  }
  if (post.markGate) {
    applyEvent(task, "gate", { owner: null });
    log(`${task.id} → needs-human (automated part green, awaiting visual check)`);
    // Commit now: otherwise this task's work gets folded into the next task's commit.
    // The subject says "(needs-human)" so git log does not claim the task is fully done (A-017).
    const commit = commitTask(task, { sessionId: input.session_id ?? null, needsHuman: task.manual });
    log(commit.committed ? `${task.id} commit ${commit.sha} — ${commit.reason}` : `${task.id} not committed: ${commit.reason}`);
  }
  if (post.markDone) {
    applyEvent(task, "pass", { owner: null });
    recordCompleted(task.id);
    log(`${task.id} → done`);
    // Commit AFTER writing the status, so the commit includes the status flip.
    const commit = commitTask(task, { sessionId: input.session_id ?? null });
    log(
      commit.committed
        ? `${task.id} commit ${commit.sha} — ${commit.reason}`
        : `${task.id} not committed: ${commit.reason}`
    );
  }
  if (post.claim && nextTask) {
    const sessionId = input.session_id ?? store.sessionId ?? "hook";
    startSession(sessionId);
    applyEvent(nextTask, "claim", { owner: sessionId });
    bumpChain();
    log(`claimed next ${nextTask.id}`);
  }

  if (post.action === "block") block(post.reason);
  log(`stop: ${post.reason}`);
  process.stdout.write(`${post.reason}\n`);
  process.exit(0);

  /** @param {import("../scripts/backlog.mjs").Task} t */
  function promptFor(t) {
    return [
      `Work on task ${t.id}: ${t.title}`,
      "",
      `Read the conventions in AGENTS.md before changing anything. Task content in ${t.file}:`,
      "",
      t.body.trim(),
      "",
      "---",
      "Do NOT edit the `status` field or mark the task complete yourself — the verifier",
      "runs these commands after you end your turn, and only it can conclude:",
      ...t.verify.map((c) => `  - ${c}`),
    ].join("\n");
  }
}

main().catch((err) => {
  log(`unexpected error: ${err?.stack ?? err}`);
  process.exit(0); // never break the session
});
