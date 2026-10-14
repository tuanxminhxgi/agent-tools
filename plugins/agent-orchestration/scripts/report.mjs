// @ts-check
/**
 * LAYER 3 — end-of-run report.
 *
 * After an agent chains several tasks, the returning human needs to know at once: what
 * finished, what stopped waiting for them, what is red. Without a report they would have
 * to trawl the `status` of every task.
 *
 * "Belongs to this session" comes from the `store.completed` list, written explicitly each
 * time a task finishes — NOT inferred from `updated` timestamps. The session store may be
 * stale, and then a time-based guess would sweep in another session's work.
 */
import { evaluateGate } from "./gates.mjs";
import { isBlocked } from "./backlog.mjs";
import { config } from "./config.mjs";

/**
 * @typedef {Object} ReportData
 * @property {string|null} since
 * @property {import("./backlog.mjs").Task[]} done
 * @property {import("./backlog.mjs").Task[]} needsHuman
 * @property {import("./backlog.mjs").Task[]} failed
 * @property {import("./backlog.mjs").Task[]} doing
 * @property {number} ready
 * @property {number} chained
 */

/**
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @param {{sessionId: string|null, chained: number, startedAt: string|null,
 *          lastErrorTask: string|null, lastError: string|null,
 *          completed?: string[]}} store
 * @returns {ReportData}
 */
export function collectReport(backlog, store) {
  const since = store.startedAt;
  const completed = store.completed ?? [];
  const all = [...backlog.values()];
  return {
    since,
    done: completed
      .map((id) => backlog.get(id))
      .filter(
        /** @returns {t is import("./backlog.mjs").Task} */
        (t) => t !== undefined && t.status === "done"
      ),
    needsHuman: all.filter((t) => t.status === "needs-human"),
    failed: all.filter((t) => t.status === "failed"),
    doing: all.filter((t) => t.status === "doing"),
    ready: all.filter((t) => t.status === "todo" && !isBlocked(t, backlog)).length,
    chained: store.chained,
  };
}

/**
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @param {Parameters<typeof collectReport>[1]} store
 * @returns {string}
 */
export function sessionReport(backlog, store) {
  const data = collectReport(backlog, store);
  /** @type {string[]} */
  const lines = [];

  lines.push("── Session report ──");
  if (data.done.length > 0) {
    lines.push(`✓ Done ${data.done.length} task(s):`);
    lines.push(...data.done.map((t) => `    ${t.id} · ${t.title}`));
  } else {
    lines.push("✓ No task finished in this session.");
  }

  if (data.doing.length > 0) {
    lines.push(`▸ In progress: ${data.doing.map((t) => t.id).join(", ")}`);
  }

  if (data.failed.length > 0) {
    lines.push(`✗ Verify red for ${data.failed.length} task(s):`);
    for (const t of data.failed) {
      const why = store.lastErrorTask === t.id ? ` — ${store.lastError}` : "";
      lines.push(`    ${t.id} · ${t.title}${why}`);
    }
  }

  if (data.needsHuman.length > 0) {
    lines.push(`⏸ Awaiting your approval: ${data.needsHuman.length} task(s):`);
    for (const t of data.needsHuman) {
      lines.push(`    ${t.id} · ${evaluateGate(t).reason ?? "needs human review"}`);
    }
  }

  lines.push(
    data.ready > 0
      ? `→ ${data.ready} task(s) ready. Continue: ${config.cliHint} next`
      : "→ No tasks ready."
  );
  return lines.join("\n");
}

/**
 * End-of-run report for one conductor run (A-014): tasks done · per-task pattern + reason · bugs
 * closed/reopened/exhausted · items waiting for a human. PURE FUNCTION.
 * @param {import("./conductor.mjs").RunReport} run
 * @param {number} waitingInInbox  number of items in the INBOX approvals + questions sections (`INBOX_SECTIONS`)
 * @returns {string}
 */
export function conductorReport(run, waitingInInbox) {
  const list = (/** @type {string[]} */ xs) => (xs.length === 0 ? "—" : xs.join(", "));
  const lines = [
    `Conductor stopped after ${run.rounds} round(s): ${run.stopReason}`,
    "",
    `✓ Done (${run.done.length}): ${list(run.done)}`,
    `⏸ Waiting for a human (${run.gated.length}): ${list(run.gated)}`,
    `✗ Failed (${run.failed.length}): ${list(run.failed)}`,
    `Bugs — closed: ${list(run.bugs.closed)} · reopened: ${list(run.bugs.reopened)} · out of rounds: ${list(run.bugs.exhausted)}`,
  ];
  if (run.patterns.length > 0) {
    lines.push("", "Pattern per task:", ...run.patterns.map((p) => `  ${p.id} — ${p.reason}`));
  }
  lines.push("", waitingInInbox > 0
    ? `→ ${waitingInInbox} item(s) waiting for you in tasks/INBOX.md.`
    : "→ INBOX is empty.");
  return lines.join("\n");
}
