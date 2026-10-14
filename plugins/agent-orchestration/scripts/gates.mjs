// @ts-check
/**
 * LAYER 2 — stop gates. Running agents continuously is good, but they must NOT
 * walk past a money task, a migration task, or a task a machine cannot check on
 * a human's behalf.
 *
 * Four rules; matching any one stops. `AGENT_QUEUE_GATES=off` disables rules 1 and 2,
 * NOT rule 3 — there is no way for a machine to conclude "it matches to the last cent".
 */
import { config } from "./config.mjs";

/**
 * @param {import("./backlog.mjs").Task} task
 * @param {typeof config} [cfg]
 * @returns {{gated: boolean, reason: string|null}}
 */
export function evaluateGate(task, cfg = config) {
  // Rule 3 — strongest, cannot be disabled.
  if (task.manual.length > 0) {
    return { gated: true, reason: `needs a visual check: ${task.manual[0]}` };
  }
  // A task with no command-based check cannot finish on its own either.
  if (task.verify.length === 0) {
    return { gated: true, reason: "no verify command — cannot finish on its own" };
  }

  if (!cfg.gatesEnabled) return { gated: false, reason: null };

  // Rule 4 — declared by hand in the front-matter.
  if (task.gate === "manual") {
    return { gated: true, reason: "declared `gate: manual`" };
  }
  // Rule 1 — migrations are hard to undo.
  const migration = cfg.migrationPaths.find((p) => task.scope.some((s) => s.includes(p)));
  if (migration || task.gate === "migration") {
    return { gated: true, reason: `has a migration (${migration ?? "declared"})` };
  }
  // Rule 2 — a mistake here is a money mistake.
  const haystack = `${task.scope.join(" ")} ${task.title}`.toLowerCase();
  const money = cfg.moneyKeywords.find((k) => haystack.includes(k.trim().toLowerCase()));
  if (money || task.gate === "money") {
    return { gated: true, reason: `touches money (${money ?? "declared"})` };
  }

  return { gated: false, reason: null };
}

/**
 * Must we stop BEFORE starting the task? Unlike `evaluateGate`: visual checks
 * (`manual:`, `gate: manual`) happen AFTER — the automatable part still runs; when
 * green the task moves to `needs-human` and the chain continues. Only migrations and
 * money need human approval before an agent touches them (A-015).
 *
 * @param {import("./backlog.mjs").Task} task
 * @param {typeof config} [cfg]
 * @returns {{gated: boolean, reason: string|null}}
 */
export function gateBeforeStart(task, cfg = config) {
  return evaluateGate({ ...task, manual: [], gate: task.gate === "manual" ? "none" : task.gate }, cfg);
}
