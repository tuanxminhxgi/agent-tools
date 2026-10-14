// @ts-check
/**
 * PostCompact hook (A-055) — whenever Claude Code compacts a session (automatically at the
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` limit, or a manual `/compact`), writes the summary (`compact_summary`) to
 * `logs/agent-queue/<task>/compact-<n>.md` and emits `agent.compact` to the event log. `<task>` comes from
 * AGENT_QUEUE_TASK_ID (`runClaude` sets it for conductor child sessions); a session belonging to no task writes to
 * `logs/agent-queue/session-<session id>/`.
 *
 * Three rules (as in `subagent-events.mjs`):
 *   - NEVER break the session: always exit 0. Bad payload, full disk → at most one stderr line.
 *   - STDOUT ALWAYS EMPTY.
 *   - NO SECRETS: content goes through `maskSecrets` before writing; the log only accepts declared fields.
 *
 * Does NOT read AGENT_QUEUE_DISABLE: conductor child sessions must leave a compact trace too.
 * AGENT_QUEUE_EVENTS=0 only disables the event log — the summary file is still written.
 */

import path from "node:path";
import { emitEvent } from "../scripts/events.mjs";
import { writeCompactFile } from "../scripts/compact.mjs";

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === "string" ? v.trim() : "");
/** @param {unknown} v @returns {number|null} */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * PURE FUNCTION. PostCompact payload → what to write, or null (not PostCompact / bad payload).
 * An empty `compact_summary` is still written — the "compacted at" trace is valuable even without content.
 * @param {unknown} payload @param {NodeJS.ProcessEnv} env @param {Date} now
 * @returns {{logId: string, taskId: string|null, sessionId: string, trigger: string, before: number|null, text: string}|null}
 */
export function toCompact(payload, env, now) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  if (str(p.hook_event_name) !== "PostCompact") return null;
  const sessionId = str(p.session_id);
  const taskId = str(env.AGENT_QUEUE_TASK_ID) || null;
  const trigger = str(p.trigger) || "auto";
  const before = num(p.pre_tokens) ?? num(p.tokens_before) ?? null;
  const summary = str(p.compact_summary);
  const header = `<!-- compact · ${trigger} · session ${sessionId || "?"}${before === null ? "" : ` · context ${before}`} · ${now.toISOString()} -->`;
  return {
    logId: taskId ?? `session-${sessionId || "unknown"}`,
    taskId, sessionId, trigger, before,
    text: `${header}\n${summary === "" ? "(Claude Code sent no summary content)" : summary}`,
  };
}

/**
 * @param {string} raw stdin @param {NodeJS.ProcessEnv} env
 * @param {{now?: () => Date, warn?: (m: string) => void}} [deps]
 * @returns {Promise<number>} always 0
 */
export async function main(raw, env, deps = {}) {
  const warn = deps.warn ?? ((m) => process.stderr.write(`[compact-log] ${m}\n`));
  try {
    /** @type {unknown} */
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return 0;
    }
    const c = toCompact(payload, env, (deps.now ?? (() => new Date()))());
    if (c === null) return 0;
    const root = env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = writeCompactFile(root, c.logId, c.text);
    if (file === null) warn(`could not write the summary to logs/agent-queue/${c.logId}/`);
    emitEvent(root, "agent.compact", {
      agentId: env.AGENT_QUEUE_AGENT_ID || `session-${c.sessionId || "unknown"}`,
      taskId: c.taskId, trigger: c.trigger, before: c.before, file,
    }, env);
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
