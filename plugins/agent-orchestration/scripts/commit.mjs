// @ts-check
/**
 * LAYER 3 (side effects) — every finished task is one commit.
 *
 * Lives here rather than in a hook because both loop mechanisms (Stop hook and
 * the headless driver) need it, and so does a manual `npm run task -- done`.
 * "Task done" is the most natural commit boundary: verify commands have already
 * confirmed it, so every commit in history is a runnable state.
 *
 * Same principle as `auto-commit.py`: **never break the main flow**. Every
 * branch that cannot commit returns a reason instead of throwing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.mjs";
import { ciGate, readCiStatus } from "./ci-status.mjs";

/** @param {string[]} args @returns {{ok: boolean, out: string}} */
function git(args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

/**
 * Infer the conventional-commit prefix from the task title + scope: `commit.typeKeywords` of the project
 * config, in key order, first match wins.
 */

/** @param {import("./backlog.mjs").Task} task @returns {string} */
export function commitType(task) {
  const text = `${task.title} ${task.scope.join(" ")}`.toLowerCase();
  for (const [prefix, keywords] of Object.entries(config.commit.typeKeywords)) {
    if (keywords.some((k) => text.includes(k.toLowerCase()))) return prefix;
  }
  return "chore";
}

const SUBJECT_MAX = 72;

/** Subject suffix when only the automated part is done — follows the `T-229 · … (needs-human: …)` precedent. */
const NEEDS_HUMAN = " (needs-human)";

/**
 * @param {import("./backlog.mjs").Task} task
 * @param {string|null} [sessionId]
 * @param {{needsHuman?: string[]}} [options]  items still awaiting a human → commit made when
 *        the task moves to `needs-human` (A-017): subject gets a suffix, body lists the pending items.
 * @returns {string}
 */
export function commitMessage(task, sessionId = null, options = {}) {
  const waiting = options.needsHuman ?? [];
  const prefix = `${commitType(task)}: ${task.id} · `;
  const suffix = waiting.length > 0 ? NEEDS_HUMAN : "";
  let title = task.title.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  // Truncate the task TITLE, never the suffix — losing "(needs-human)" makes git log lie.
  const budget = SUBJECT_MAX - prefix.length - suffix.length;
  if (title.length > budget) title = `${title.slice(0, budget - 1).trimEnd()}…`;

  const lines = [prefix + title + suffix, ""];
  lines.push(`Task: ${task.file}`);
  if (waiting.length > 0) {
    lines.push("", "Awaiting a human (automated part is green, task is needs-human):");
    lines.push(...waiting.map((m) => `  - ${m}`));
  }
  if (task.verify.length > 0) {
    lines.push("", "Verify commands passed:");
    lines.push(...task.verify.map((c) => `  ${c}`));
  }
  if (config.commit.trailers.length > 0) lines.push("", ...config.commit.trailers);
  if (sessionId) lines.push(`Claude-Session: https://claude.ai/code/session_${sessionId}`);
  return `${lines.join("\n")}\n`;
}

/**
 * @typedef {Object} CommitResult
 * @property {boolean} committed
 * @property {string|null} sha
 * @property {boolean} pushed
 * @property {string} reason  why it committed / why not
 */

/**
 * Commit all changes once a task is confirmed done.
 *
 * @param {import("./backlog.mjs").Task} task
 * @param {{sessionId?: string|null, push?: boolean, enabled?: boolean,
 *           protectedBranches?: string[], needsHuman?: string[], paths?: string[],
 *           ciCfg?: import("./project-config.mjs").CiWatch|null, ciStatus?: import("./ci-status.mjs").CiStatus}} [options]
 *        `paths`: stage only these paths (A-025 — when the conductor merges a worker branch it must not
 *        sweep up in-progress work of a serial-lane task editing the main tree); absent → `git add -A`.
 *        `ciCfg`/`ciStatus` (A-084): inject the `ci` key and CI status for tests; default `config.ci` + `readCiStatus`.
 * @returns {CommitResult}
 */
export function commitTask(task, options = {}) {
  const enabled = options.enabled ?? config.commitEnabled;
  const push = options.push ?? config.pushEnabled;
  const protectedBranches = options.protectedBranches ?? config.protectedBranches;

  /** @param {string} reason @returns {CommitResult} */
  const skip = (reason) => ({ committed: false, sha: null, pushed: false, reason });

  if (!enabled) return skip("disabled by AGENT_QUEUE_COMMIT=0");
  if (!fs.existsSync(".git")) return skip("this directory is not a git repo");

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return skip("cannot read the current branch");
  if (branch.out === "HEAD") return skip("on a detached HEAD");
  if (protectedBranches.includes(branch.out)) {
    return skip(`branch \`${branch.out}\` is protected (AGENT_QUEUE_PROTECTED_BRANCHES)`);
  }

  // Do not interfere with an in-progress merge/rebase.
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (fs.existsSync(`.git/${marker}`)) return skip(`${marker} in progress, not committing`);
  }
  if (fs.existsSync(".git/rebase-merge") || fs.existsSync(".git/rebase-apply")) {
    return skip("rebase in progress, not committing");
  }

  const staged = git(options.paths && options.paths.length > 0 ? ["add", "-A", "--", ...options.paths] : ["add", "-A"]);
  if (!staged.ok) return skip(`git add failed: ${staged.out}`);

  const pending = git(["diff", "--cached", "--name-only"]);
  if (pending.out === "") return skip("no changes to commit");

  const message = commitMessage(task, options.sessionId ?? null, { needsHuman: options.needsHuman });
  const done = git(["commit", "-q", "-m", message]);
  if (!done.ok) return skip(`git commit failed: ${done.out}`);

  const sha = git(["rev-parse", "--short", "HEAD"]).out;
  const files = pending.out.split("\n").length;

  if (!push) {
    return { committed: true, sha, pushed: false, reason: `${files} file(s) (not pushed)` };
  }

  // Push only when the branch has an upstream — never create a new remote branch.
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) {
    return { committed: true, sha, pushed: false, reason: `${files} file(s) (branch has no upstream)` };
  }
  // A-084: CI gate. Every push the harness makes goes through here. Still committed; just not pushed — the
  // next task's normal push (once CI is green again, or a run bypasses the gate) carries the pending commits.
  const ciCfg = options.ciCfg === undefined ? config.ci : options.ciCfg;
  if (ciCfg) {
    const status = options.ciStatus ?? readCiStatus(process.cwd(), ciCfg);
    const gate = ciGate(status, ciCfg, branch.out);
    if (gate.closed) return { committed: true, sha, pushed: false, reason: `${files} file(s) — NOT pushed: ${gate.reason}` };
  }
  const pushed = git(["push"]);
  return {
    committed: true,
    sha,
    pushed: pushed.ok,
    reason: pushed.ok ? `${files} file(s), pushed` : `${files} file(s), push failed: ${pushed.out}`,
  };
}
