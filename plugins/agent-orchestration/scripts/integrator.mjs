// @ts-check
/**
 * INTEGRATOR — merges worker branches into the main branch, SERIALLY, and re-verifies
 * after merging. Design: docs/agent-orchestration.md §3 "Integration step".
 *
 *   1. rebase `agent/<id>` onto the main branch (in the task's worktree);
 *   2. re-run `verify` in the worktree — green on its own branch does NOT mean
 *      green after merging with other workers' work;
 *   3. fast-forward merge into the main branch (in the main worktree).
 *
 * Rebase conflict → abort the rebase, return the file list. NEVER resolves conflicts itself — except ONE
 * kind: a conflict confined to the handoff section (`config.headings.handoff`) of a `tasks/*.md` file
 * (bookkeeping, both sides appended lines) → keep both sides (`mergeHandoffConflict`) and continue the rebase.
 * `integrate` (sync, for `cli integrate`) and `integrateAsync` (for the conductor) share the two git steps.
 * Changing task status, committing status, cleaning up worktrees is the caller's job
 * (conductor, A-014) — here only git + verify, so it is testable with a temp repo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { branchName, worktreePath, runGit } from "./worker.mjs";
import { config } from "./config.mjs";

/**
 * @typedef {{ok: true, sha: string, skippedVerify?: true}
 *   | {ok: false, stage: "rebase", conflicts: string[]}
 *   | {ok: false, stage: "verify", output: string}
 *   | {ok: false, stage: "merge", output: string}} IntegrationResult
 */

/**
 * Merge order when several branches are green: deterministic by id. Merging is serial, so a
 * later branch always rebases onto the result of the earlier one.
 * @param {string[]} ids @returns {string[]}
 */
export function mergeOrder(ids) {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * The `cli.mjs` used to verify in worktree `cwd`. A repo that contains the harness code itself (the source
 * repo) → use the worktree's copy, since that is the code being merged. A project using the plugin → the
 * worktree has no copy, use the running one.
 * @param {string} cwd @returns {string}
 */
export function cliPathFor(cwd) {
  const own = path.join(cwd, "scripts", "agent-queue", "cli.mjs");
  return fs.existsSync(own) ? own : path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
}

/**
 * Run `cli.mjs verify <id>` in the worktree, with the worker's env.
 * @param {string} cwd @param {string} id @param {Record<string, string>} env
 * @returns {{ok: boolean, output: string}}
 */
export function verifyInWorktree(cwd, id, env) {
  const r = spawnSync(process.execPath, [cliPathFor(cwd), "verify", id], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const HANDOFF_HEADING = new RegExp(`^## ${config.headings.handoff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

/**
 * PURE FUNCTION. Resolves conflicts in a task file if EVERY conflict hunk lies under the handoff heading
 * (`## ` + `config.headings.handoff`): keep the main-branch side first, then the other side's lines not
 * already present — the log is append-only, so nothing is lost. diff3 base hunks (`|||||||`) are dropped.
 * A hunk outside that section (front-matter, task content), unbalanced markers, or no such section → null:
 * left to a human. Incident 2026-09-26/27: A-040, T-230, T-232 went `failed` only because a human and a
 * worker both wrote to the log.
 * @param {string} text @returns {string|null}
 */
export function mergeHandoffConflict(text) {
  const lines = text.split("\n");
  const heading = lines.findIndex((l) => HANDOFF_HEADING.test(l));
  if (heading === -1) return null;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      if (/^(\|{7}|={7}|>{7})( |$)/.test(lines[i])) return null;
      out.push(lines[i]);
      continue;
    }
    if (i < heading) return null;
    /** @type {string[]} */ const ours = [];
    /** @type {string[]} */ const theirs = [];
    let part = "ours";
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith(">>>>>>> "); j += 1) {
      if (lines[j].startsWith("<<<<<<< ")) return null;
      if (lines[j].startsWith("||||||| ")) { part = "base"; continue; }
      if (lines[j] === "=======") { part = "theirs"; continue; }
      if (part === "ours") ours.push(lines[j]);
      else if (part === "theirs") theirs.push(lines[j]);
    }
    if (j >= lines.length || part !== "theirs") return null;
    out.push(...ours, ...theirs.filter((l) => l.trim() === "" || !ours.includes(l)));
    i = j;
  }
  return out.join("\n");
}

/**
 * The current rebase conflict is only in `tasks/*.md` files and resolvable by `mergeHandoffConflict` → resolve,
 * `rebase --continue`, repeat for later commits. All resolved → true; any other conflict → false (caller aborts).
 * @param {string} cwd @returns {boolean}
 */
function resolveHandoffConflicts(cwd) {
  for (let round = 0; round < 50; round += 1) {
    const conflicts = runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter((f) => f !== "");
    if (conflicts.length === 0) return true;
    if (!conflicts.every((f) => f.startsWith(`${config.tasksDir}/`) && !f.slice(config.tasksDir.length + 1).includes("/") && f.endsWith(".md"))) return false;
    for (const f of conflicts) {
      const merged = mergeHandoffConflict(fs.readFileSync(path.join(cwd, f), "utf8"));
      if (merged === null) return false;
      fs.writeFileSync(path.join(cwd, f), merged);
      if (!runGit(cwd, ["add", "--", f]).ok) return false;
    }
    const next = runGit(cwd, ["-c", "core.editor=true", "rebase", "--continue"]);
    if (next.ok) return true;
  }
  return false;
}

/**
 * Step 1: rebase the task branch onto the main branch (in the task's worktree). Conflict → abort the rebase.
 * @param {string} root @param {string} id
 * @returns {IntegrationResult|null} null = rebase done, continue
 */
function rebaseStep(root, id) {
  const cwd = worktreePath(root, id);
  const main = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const rebase = runGit(cwd, ["rebase", main]);
  if (rebase.ok) return null;
  if (resolveHandoffConflicts(cwd)) return null;
  const conflicts = runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]).out
    .split("\n").filter((f) => f !== "");
  runGit(cwd, ["rebase", "--abort"]);
  return { ok: false, stage: "rebase", conflicts };
}

/** Step 3: fast-forward merge into the main branch (in the main worktree). @param {string} root @param {string} id @returns {IntegrationResult} */
function mergeStep(root, id) {
  const merged = runGit(root, ["merge", "--ff-only", branchName(id)]);
  if (!merged.ok) return { ok: false, stage: "merge", output: merged.out };
  return { ok: true, sha: runGit(root, ["rev-parse", "--short", "HEAD"]).out };
}

/**
 * @param {string} root  main worktree
 * @param {string} id
 * @param {{
 *   env?: Record<string, string>,
 *   verify?: (cwd: string, id: string, env: Record<string, string>) => {ok: boolean, output: string},
 * }} [options]
 * @returns {IntegrationResult}
 */
export function integrate(root, id, options = {}) {
  const verify = options.verify ?? verifyInWorktree;
  const failed = rebaseStep(root, id);
  if (failed) return failed;
  const checked = verify(worktreePath(root, id), id, options.env ?? {});
  if (!checked.ok) return { ok: false, stage: "verify", output: checked.output };
  return mergeStep(root, id);
}

/**
 * Like `integrate` but verifies ASYNCHRONOUSLY — the conductor (A-025) merges while other workers are still
 * running; a minute-long `spawnSync` would block the event loop and let child-process pipes fill up. Same three
 * steps, same result.
 *
 * `verifiedHead` (A-089): the branch SHA when the pre-reviewer verify went green. If after the rebase the worktree
 * HEAD is still that SHA (`main` hasn't moved, so the rebase changed nothing), a second verify is redundant →
 * ff-merge right away, result carries `skippedVerify`. Different SHA (or no `verifiedHead`) → verify again as
 * before. Only usable within a conductor run's memory — the sync `integrate` (`cli integrate`) has no such
 * parameter and always verifies.
 * @param {string} root @param {string} id
 * @param {{
 *   env?: Record<string, string>,
 *   verifiedHead?: string|null,
 *   verify: (cwd: string, id: string, env: Record<string, string>) => Promise<{ok: boolean, output: string}>,
 * }} options
 * @returns {Promise<IntegrationResult>}
 */
export async function integrateAsync(root, id, options) {
  const failed = rebaseStep(root, id);
  if (failed) return failed;
  const cwd = worktreePath(root, id);
  const head = options.verifiedHead ? runGit(cwd, ["rev-parse", "HEAD"]) : null;
  if (head?.ok && head.out === options.verifiedHead) {
    const merged = mergeStep(root, id);
    return merged.ok ? { ...merged, skippedVerify: true } : merged;
  }
  const checked = await options.verify(cwd, id, options.env ?? {});
  if (!checked.ok) return { ok: false, stage: "verify", output: checked.output };
  return mergeStep(root, id);
}
