// @ts-check
/**
 * `task review <id> --role <role>` (A-074) — rerun ONE reviewer on a finished task to resubmit a broken report.
 *
 * Why: an error report `{role, task, error}` in `reports/` (the reviewer failed to submit JSON) only leaves the INBOX
 * when a real report overwrites it. The conductor never touches a `done` task again; this command is the human's only way.
 *
 * Rules:
 *   - only `done` / `needs-human` tasks, only `kind: reviewer` roles — either wrong: error, NOTHING written;
 *   - diff = every commit of the task on the current branch (subject contains `: <id> · `), old → new; no commits
 *     at all is an error and NOTHING is written — the old report is not overwritten by a review of an empty diff;
 *   - same prompt, model and allow-list as the conductor (`rolePrompt`, the `roles` table, `claudeArgs`) and the same
 *     "retry once" mechanism of A-073 (`findings.mjs`); goes through `runClaude`, so the event ledger and `AGENT_QUEUE_CLAUDE_BIN` apply;
 *   - does NOT change `status`, no commit, no push, no worktree, no INBOX regeneration;
 *   - the report is overwritten only with valid JSON. Out of calls and still no JSON → exit ≠ 0 and the old report is left INTACT
 *     (unlike the conductor: there no report exists yet to lose; here we might overwrite a good one).
 *
 * The findings resolutions ledger (A-071) matches on `[task, role, file, line, rule]`, so it can close findings, not
 * error reports. A new report that no longer contains a finding the ledger closed → that entry becomes orphan (`doctor` yellow, not red).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.mjs";
import { modelFor, rolePrompt } from "./roles.mjs";
import { MAX_REVIEWER_CALLS, parseFindings, recordFindings, reviewerRetryTail, shouldRetryReviewer } from "./findings.mjs";
import { claudeArgs, readAgentTools, agentKind, withPermissionNote } from "./conductor-exec.mjs";
import { runClaude } from "./claude-run.mjs";
import { newId } from "./events.mjs";

/** Task statuses that can be re-reviewed. */
export const REVIEWABLE_STATUSES = ["done", "needs-human"];

/**
 * @typedef {{hash: string, subject: string}} Commit
 * @typedef {{id: string, title: string, status: string, file: string, body: string, context?: string|null}} ReviewTask
 * @typedef {{
 *   gitLog: () => string,
 *   gitShow: (hash: string) => string,
 *   spawn: (job: {role: string, model: string, prompt: string, taskId: string, reason?: string}) => Promise<{code: number, output: string}>,
 *   writeReport: (taskId: string, role: string, output: string) => {file: string, ok: boolean},
 *   appendLog: (taskId: string, role: string, text: string) => void,
 * }} ReviewIo
 */

/**
 * The task's commits in `git log --format=%H%x09%s` output (new → old, git's default), returned OLD → NEW.
 * Matches the `commitMessage` pattern (`<type>: <id> · <title>`): `: T-28 · ` does not match `: T-282 · `. PURE FUNCTION.
 * @param {string} logText @param {string} id @returns {Commit[]}
 */
export function findTaskCommits(logText, id) {
  const marker = `: ${id} · `;
  /** @type {Commit[]} */
  const found = [];
  for (const line of logText.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const subject = line.slice(tab + 1);
    if (subject.includes(marker)) found.push({ hash: line.slice(0, tab), subject });
  }
  return found.reverse();
}

/**
 * Validate input. PURE FUNCTION. Returns the rejection reason or null.
 * @param {ReviewTask|undefined} task @param {string} id @param {string|undefined} role
 * @param {Record<string, {kind: string}>} roles @returns {string|null}
 */
export function rejectReason(task, id, role, roles) {
  if (!task) return `No task ${id}`;
  if (!REVIEWABLE_STATUSES.includes(task.status)) {
    return `${id} is \`${task.status}\` — only ${REVIEWABLE_STATUSES.join(" / ")} tasks can be re-reviewed`;
  }
  if (!role) return "Missing --role <role>";
  const rule = roles[role];
  if (!rule) return `Role "${role}" is not in the roles table`;
  if (rule.kind !== "reviewer") return `Role "${role}" is ${rule.kind}, not reviewer`;
  return null;
}

/**
 * @typedef {{
 *   exit: number, lines: string[], commits: Commit[], model: string|null, promptLength: number|null,
 *   file: string|null, calls: number,
 * }} ReviewResult
 */

/**
 * Run (or preview) one re-review. Does not print or exit the process: returns a `ReviewResult` for the CLI.
 * @param {{task: ReviewTask|undefined, id: string, role: string|undefined, dryRun?: boolean,
 *          roles?: Record<string, import("./roles.mjs").RoleRule>}} opts
 * @param {ReviewIo} io
 * @returns {Promise<ReviewResult>}
 */
export async function runReview(opts, io) {
  const roles = opts.roles ?? config.roles;
  /** @type {ReviewResult} */
  const result = { exit: 1, lines: [], commits: [], model: null, promptLength: null, file: null, calls: 0 };
  const reason = rejectReason(opts.task, opts.id, opts.role, roles);
  if (reason !== null) {
    result.lines.push(reason);
    return result;
  }
  const task = /** @type {ReviewTask} */ (opts.task);
  const role = /** @type {string} */ (opts.role);

  const commits = findTaskCommits(io.gitLog(), task.id);
  result.commits = commits;
  if (commits.length === 0) {
    result.lines.push(`No commits of ${task.id} on the current branch (subject containing "${`: ${task.id} · `}") — no diff to review, nothing written.`);
    return result;
  }
  const diff = commits.map((c) => io.gitShow(c.hash)).join("\n");
  const prompt = rolePrompt(role, /** @type {never} */ (task), diff, "");
  const model = modelFor(roles[role]);
  result.model = model;
  result.promptLength = prompt.length;

  result.lines.push(`Task ${task.id} (${task.status}) · role ${role} · model ${model}`);
  result.lines.push(`${commits.length} commit(s) (old → new):`);
  for (const c of commits) result.lines.push(`  ${c.hash.slice(0, 9)} ${c.subject}`);
  result.lines.push(`Prompt ${prompt.length} chars (diff ${diff.length})`);
  if (opts.dryRun) {
    result.exit = 0;
    result.lines.push("--dry-run: claude not called, no files written.");
    return result;
  }

  io.appendLog(task.id, role, `\n===== ${role} (${model}) — manual rerun (task review), ${commits.length} commit(s) =====\n`);
  // Same A-073 mechanism as the conductor: exit 0 without JSON → retry exactly once with the error tail.
  let r = await io.spawn({ role, model, prompt, taskId: task.id });
  result.calls = 1;
  if (r.code !== 0) result.lines.push(`${role} exited with code ${r.code}`);
  const parsedFirst = parseFindings(r.output);
  if (r.code === 0 && shouldRetryReviewer(parsedFirst, 1)) {
    const error = parsedFirst.ok ? "" : parsedFirst.error;
    result.lines.push(`${role} failed to submit a JSON block (${error}) — retrying once`);
    r = await io.spawn({
      role, model, prompt: prompt + reviewerRetryTail(error), taskId: task.id,
      reason: `retry 2/${MAX_REVIEWER_CALLS}: previous turn had no valid JSON block (${error})`,
    });
    result.calls = 2;
    if (r.code !== 0) result.lines.push(`${role} (retry) exited with code ${r.code}`);
  }

  const parsed = parseFindings(r.output);
  if (r.code !== 0 || !parsed.ok) {
    result.lines.push(`No valid report: ${r.code !== 0 ? `claude exited with code ${r.code}` : /** @type {{error: string}} */ (parsed).error}. The old report (if any) is kept.`);
    return result;
  }
  const rec = io.writeReport(task.id, role, r.output);
  result.file = rec.file;
  result.exit = rec.ok ? 0 : 1;
  const n = parsed.report.findings.length;
  result.lines.push(`Wrote ${rec.file} — ${n === 0 ? "no findings" : `${n} finding(s)`}.`);
  return result;
}

/**
 * Real `io`: git of the current repo, `claude` via `runClaude` (event ledger + `AGENT_QUEUE_CLAUDE_BIN`).
 * @param {string} root repo root @returns {ReviewIo}
 */
export function realReviewIo(root) {
  /** @param {string[]} args */
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const runId = newId("run");
  /** @param {string} taskId @param {string} role */
  const logPath = (taskId, role) => path.join(root, "logs", "agent-queue", taskId, `${role}.log`);
  return {
    gitLog: () => git(["log", "--format=%H%x09%s"]),
    gitShow: (hash) => git(["show", "--format=", hash]),
    spawn: async ({ role, model, prompt, taskId }) => {
      const rule = { ...config.roles[role], model, modelByRound: undefined, tools: readAgentTools(root, role) };
      const mode = process.env.AGENT_QUEUE_SKIP_PERMISSIONS === "1" ? "skip" : "allowlist";
      const args = claudeArgs(role, { id: taskId }, rule, mode);
      fs.mkdirSync(path.dirname(logPath(taskId, role)), { recursive: true });
      const r = await runClaude({
        args, prompt: withPermissionNote(prompt, mode), stdinPrompt: true, cwd: root, env: { ...process.env, AGENT_QUEUE_DISABLE: "1" },
        logFile: logPath(taskId, role),
        meta: { kind: agentKind(role), role, model, taskId, slot: null, worktree: null, runId },
      });
      return { code: r.code, output: r.output };
    },
    writeReport: (taskId, role, output) => recordFindings(root, taskId, role, output),
    appendLog: (taskId, role, text) => {
      fs.mkdirSync(path.dirname(logPath(taskId, role)), { recursive: true });
      fs.appendFileSync(logPath(taskId, role), text);
    },
  };
}
