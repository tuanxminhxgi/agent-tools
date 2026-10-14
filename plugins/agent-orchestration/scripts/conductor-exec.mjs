// @ts-check
/**
 * CONDUCTOR EXECUTION LAYER (A-025) — turns the `Action[]` of `tick`/`recover` into real processes.
 * Design: docs/agent-orchestration.md, section "Conductor execution".
 *
 * `tick` decides (pure function, A-023); this layer only DOES, and every side effect goes through `ExecIo`
 * (injectable: real or fake spawn/git) — tests need neither `claude` nor a real git.
 *
 * Each parallel task is a background pipeline on its own worktree:
 *   `start --worker n` → `worker add` (with dependencies linked, A-018) → `claude -p` per role (cwd worktree, worker
 *   env, the role's `--model`) → the next roles of `roleChain` (tick calls one role at a time) → commit the work
 *   INSIDE the worktree → serial `integrate` (rebase → verify → ff-merge) → the verifier writes `done` →
 *   `commitTask` WITH push → `worker rm`. The serial lane runs the same pipeline but on the main worktree
 *   and needs no merge. The planner has its own lane: `run-planner.sh`, the `roles` table's planner model.
 *
 * Hard rules:
 *   - only the verifier writes `done`; only the integrator merges into `main`; workers (agents) never commit/push —
 *     blocked by machine via `--disallowedTools`, by variable via `AGENT_QUEUE_COMMIT=0`;
 *   - never run more than `workers` workers; never resolve rebase conflicts automatically;
 *   - secrets (e.g. DB passwords) travel through the child process ENV, never on the command line or in logs (`redact`).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { compactPrompt, contextPackFile, continuePrompt, modelFor, parseDiffFiles, reviewerGate, rolePrompt } from "./roles.mjs";
import { COMPACT_MAX_CHARS } from "./compact.mjs";
import { choosePattern } from "./pattern.mjs";
import { fixerPrompt, fixVerdict } from "./bugs.mjs";
import { sectionOrNull } from "./backlog.mjs";
import { parseFindings, shouldRetryReviewer, reviewerRetryTail, MAX_REVIEWER_CALLS } from "./findings.mjs";
import { maskSecrets, worktreePath, envFilePath } from "./worker.mjs";

export const CONDUCTOR_OWNER = "conductor";

/** `Running.verifiedHead` on the serial lane (A-089): no branch/SHA to compare, just a "verified green before reviewers" marker. */
export const SERIAL_VERIFIED = "(serial lane)";

/** @typedef {import("./backlog.mjs").Task} Task */
/** @typedef {import("./backlog.mjs").Bug} Bug */
/** @typedef {import("./project-config.mjs").RoleRule} RoleRule */
/** @typedef {import("./conductor.mjs").Action} Action */
/** @typedef {import("./conductor.mjs").Running} Running */
/** @typedef {import("./integrator.mjs").IntegrationResult} IntegrationResult */
/** @typedef {"allowlist"|"skip"} PermissionMode */
/** @typedef {{code: number, stdout: string, stderr: string, sessionId?: string|null, agentId?: string|null, budgetExceeded?: boolean}} SpawnResult
 *   `sessionId`: Claude Code session id when the role runs through `io.claude` (A-050) — can be `--resume`d (A-053).
 *   `agentId`: the turn's id in the event ledger (A-083) — a later resumed turn records it in `resumedFrom`.
 *   `budgetExceeded` (A-087): the session stopped because it hit `--max-budget-usd`. */
/**
 * @typedef {(cmd: string, args: string[], opts: {cwd: string, env?: Record<string, string>, input?: string,
 *            signal?: AbortSignal, timeoutMs?: number}) => Promise<SpawnResult>} SpawnFn
 *   `env` is ADDED to `process.env`. Aborting `signal` = the conductor's `kill`.
 * @typedef {(cwd: string, args: string[]) => {ok: boolean, out: string}} GitFn
 * @typedef {(job: {args: string[], prompt: string, cwd: string, env: Record<string, string>, taskId: string, role: string,
 *            model: string, slot: number|null, signal?: AbortSignal, timeoutMs?: number, redact?: (text: string) => string,
 *            resumedFrom?: string|null, resumeKind?: import("./events.mjs").ResumeKind|null})
 *            => Promise<{code: number, output: string, usage: import("./events.mjs").Usage, agentId: string,
 *                        sessionId?: string|null, budgetExceeded?: boolean}>} ClaudeFn
 *   `env` is ADDED to `process.env`; the prompt goes via stdin. Log at `logs/agent-queue/<taskId>/<role>.log`.
 */

// ─── `claude -p` command line per role (Q-001 = C) ─────────────────────────────

/** Every role: NO commit/push/recursive delete — "workers never commit/push" is a machine guard, not just an env variable. */
export const DENIED_TOOLS = Object.freeze(["Bash(git push:*)", "Bash(git commit:*)", "Bash(rm -rf:*)"]);

/** Every role: read git state. */
export const BASE_BASH = Object.freeze(["Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"]);

/** Write tools — reviewers NEVER get them, even if the agent file declares them. */
const WRITE_TOOLS = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Role without `tools` in `.claude/agents/<role>.md` (or with no file) → default by `kind`. */
const DEFAULT_TOOLS = Object.freeze({
  reviewer: ["Read", "Glob", "Grep", "Bash", "LSP"],
  other: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "LSP"],
});

/** The CLI's built-in tool set — `--tools` only accepts names from it (A-087). Other names (e.g. `LSP`) only go in `--allowedTools`. */
const CLI_BUILTIN_TOOLS = Object.freeze(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]);

/**
 * `--tools` value for a role (A-087): names from the agent file's `tools:` that belong to the CLI's built-in tool set, in file
 * order; reviewers never get write tools. Role without an agent file → default by `kind`. PURE FUNCTION.
 * @param {RoleRule & {tools?: string[]}} rule @returns {string[]}
 */
export function childTools(rule) {
  const base = rule.tools ?? (rule.kind === "reviewer" ? DEFAULT_TOOLS.reviewer : DEFAULT_TOOLS.other);
  return [...new Set(base.filter((t) => CLI_BUILTIN_TOOLS.includes(t) && !(rule.kind === "reviewer" && WRITE_TOOLS.includes(t))))];
}

/** `AGENT_QUEUE_CHILD_FULL=1`: escape hatch — child sessions load everything as before A-087 (the budget cap stays). @param {NodeJS.ProcessEnv} [env] */
export const childFull = (env = process.env) => env.AGENT_QUEUE_CHILD_FULL === "1";

/**
 * The `tools:` field in the front-matter of `.claude/agents/<role>.md`. PURE FUNCTION.
 * @param {string} text @returns {string[]|undefined} undefined if the field is absent
 */
export function parseAgentTools(text) {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const line = head.split("\n").find((l) => /^tools:/.test(l));
  if (line === undefined) return undefined;
  return line.slice("tools:".length).split(",").map((t) => t.trim()).filter((t) => t !== "");
}

/**
 * `--allowedTools` list for a role: the agent file's `tools` (Bash replaced by NARROW patterns), plus
 * the role's Bash patterns from the `roles` table, plus read-only git. Reviewers get no write tools.
 * @param {RoleRule & {tools?: string[]}} rule @returns {string[]}
 */
export function allowedTools(rule) {
  const base = rule.tools ?? (rule.kind === "reviewer" ? DEFAULT_TOOLS.reviewer : DEFAULT_TOOLS.other);
  const kept = base.filter((t) => t !== "Bash" && !(rule.kind === "reviewer" && WRITE_TOOLS.includes(t)));
  const bash = base.includes("Bash") ? [...BASE_BASH, ...(rule.bash ?? [])] : [];
  return [...new Set([...kept, ...bash])];
}

/**
 * Commands an agent may NEVER call, however broad the allow-list: finalising status is the verifier's job
 * (`done`/`approve` by an agent = declaring itself finished). Derived from the project's `cliHint`.
 * @returns {string[]}
 */
export function gateDenied() {
  const hints = [config.cliHint, "node scripts/agent-queue/cli.mjs"];
  return [...new Set(hints)].flatMap((h) => [`Bash(${h} done:*)`, `Bash(${h} approve:*)`]);
}

/**
 * The `claude` command line for ONE role — PURE FUNCTION, testable. NO prompt and NO secrets: the prompt goes
 * via stdin (`--allowedTools` takes a list, a prompt placed after it would be swallowed), env goes via `env`.
 *
 * - `allowlist` (default, Q-001 = C): `--allowedTools` per role;
 * - `skip` (`AGENT_QUEUE_SKIP_PERMISSIONS=1`): `--dangerously-skip-permissions` instead of the allow-list;
 * - both: `--disallowedTools` blocks push/commit/rm -rf/done/approve.
 * `task.round` (a bug's fixer round, A-026) picks the model per `modelByRound` — e.g. a stronger model from round 2.
 * - A-087, AFTER `--disallowedTools` in exactly this order: `--strict-mcp-config` · `--disable-slash-commands` · `--no-chrome` ·
 *   `--tools <the role's tools>` (each flag per `childSession`) · `--max-budget-usd <rule.maxBudgetUsd>`. `skip` mode gets them too
 *   (slimming is unrelated to permissions). `AGENT_QUEUE_CHILD_FULL=1` drops the four slimming flags, keeps the cap.
 * @param {string} role
 * @param {{id: string, round?: number}} task
 * @param {(RoleRule & {tools?: string[]})|undefined} roleRule  omitted → the config's `roles` table
 * @param {PermissionMode} [permissionMode]
 * @param {{env?: NodeJS.ProcessEnv, childSession?: import("./project-config.mjs").ChildSession}} [opts]  injected by tests
 * @returns {string[]}
 */
export function claudeArgs(role, task, roleRule, permissionMode = "allowlist", opts = {}) {
  const rule = roleRule ?? config.roles[role];
  if (!rule) throw new Error(`${task.id}: role "${role}" is not in the roles table`);
  const args = ["-p", "--model", modelFor(rule, task.round ?? 1)];
  if (permissionMode === "skip") args.push("--dangerously-skip-permissions");
  else args.push("--allowedTools", allowedTools(rule).join(","));
  args.push("--disallowedTools", [...DENIED_TOOLS, ...gateDenied()].join(","));
  if (!childFull(opts.env)) {
    const cs = opts.childSession ?? config.childSession;
    if (cs.strictMcp) args.push("--strict-mcp-config");
    if (!cs.skills) args.push("--disable-slash-commands");
    if (!cs.chrome) args.push("--no-chrome");
    const tools = cs.toolsFromRole ? childTools(rule) : [];
    if (tools.length > 0) args.push("--tools", tools.join(","));
  }
  if (typeof rule.maxBudgetUsd === "number" && rule.maxBudgetUsd > 0) args.push("--max-budget-usd", String(rule.maxBudgetUsd));
  return args;
}

/**
 * Remind the role of its permission boundary — in a headless session "denied" is just a small error line.
 * @param {string} prompt @param {PermissionMode} mode @returns {string}
 */
export function withPermissionNote(prompt, mode) {
  if (mode === "skip") return prompt;
  return `${prompt}\n\nPermissions (headless session): you can only use the tools in your role's allow-list. If a command is denied, ` +
    `do NOT look for a workaround and do not ask for a wider list — write the exact denied command into \`## ${config.headings.handoff}\` and stop.\n` +
    // Incident 2026-09-26: A-042 stopped at its first command (a heredoc generating a fixture was blocked as "brace with quote character"),
    // A-039 was denied `python3`. Both were jobs Write could do directly.
    "Create and edit files with the Write/Edit tools — NOT with Bash (heredoc `<<EOF`, `python3 -`, `cat >`, `echo >`): " +
    "Claude Code blocks Bash commands with braces plus quotes, and `python3` is not in the allow-list. JSON/JSONL fixtures " +
    "are written directly with Write too. Files under `.claude/` are sensitive and writes will be denied — if one needs a change, note it in the handoff log and stop.";
}

/**
 * Parse a worker env file (`export K="v"`, values are JSON strings). PURE FUNCTION.
 * @param {string} text @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of text.split("\n")) {
    const m = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    try {
      env[m[1]] = String(JSON.parse(m[2]));
    } catch {
      env[m[1]] = m[2];
    }
  }
  return env;
}

/**
 * Redact secrets in text bound for logs/screen: `user:pass@` URLs (maskSecrets) AND every standalone occurrence of the
 * password (e.g. `PGPASSWORD=…` in a command's output).
 * @param {string} text @param {Record<string, string>} [env] @returns {string}
 */
export function redact(text, env = {}) {
  let out = maskSecrets(text);
  for (const value of Object.values(env)) {
    const pass = /\/\/[^:/@\s]+:([^@\s]+)@/.exec(value)?.[1];
    if (pass && pass.length >= 4) out = out.split(pass).join("***");
  }
  return out;
}

// ─── Event ledger (A-037) ─────────────────────────────────────────────────────

/**
 * Agent `kind` in the ledger: a developer role is "worker" (the process doing the task), planner is "planner", every
 * other role (qa, reviewer, fixer…) is "role". Unknown role → "role".
 * @param {string} role @returns {"worker"|"role"|"planner"}
 */
export function agentKind(role) {
  const kind = config.roles[role]?.kind;
  return kind === "developer" ? "worker" : kind === "planner" ? "planner" : "role";
}

/**
 * Fields of `pattern.chosen` for a freshly dispatched task. PURE FUNCTION — only RE-READS `choosePattern` (deterministic),
 * never changes `tick`'s decision. `reason` is the dispatch action's reason (core + Evaluator layer + lane).
 * @param {Task} task @param {string} reason @param {{slot?: number|null, role?: string, model?: string}} [extra]
 * @returns {Record<string, unknown>}
 */
export function patternFields(task, reason, extra = {}) {
  const choice = choosePattern(task);
  return {
    taskId: task.id, pattern: choice.core, evaluate: choice.evaluate.length > 0 ? choice.evaluate.join(",") : false,
    reason, slot: extra.slot ?? null, role: extra.role, model: extra.model,
  };
}

/**
 * The work diff in `cwd` as `DiffFile[]` for the reviewer `when.diff` gate (A-090): `git diff -U0` against the
 * fork point from the main branch (worktree) or against HEAD (main tree, plus NEW untracked files — without them a
 * file just created on the serial lane would count as "nothing to review"). Git error → null: the caller treats it as
 * `run: true` (better to review too much than miss something). Never throws.
 * @param {GitFn} git @param {(file: string) => string} readText @param {string} root @param {string} cwd
 * @returns {import("./roles.mjs").DiffFile[]|null}
 */
export function readGateFiles(git, readText, root, cwd) {
  try {
    const here = path.resolve(cwd) === path.resolve(root);
    let diff;
    if (here) {
      diff = git(cwd, ["diff", "-U0", "HEAD"]);
    } else {
      const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const mb = branch.ok ? git(cwd, ["merge-base", branch.out, "HEAD"]) : branch;
      if (!mb.ok) return null;
      git(cwd, ["add", "-A"]); // new untracked files must show up in the diff too
      diff = git(cwd, ["diff", "-U0", "--cached", mb.out]);
    }
    if (!diff.ok) return null;
    const files = parseDiffFiles(diff.out);
    if (here) {
      const fresh = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
      if (!fresh.ok) return null;
      for (const f of fresh.out.split("\n").filter((x) => x !== "")) {
        files.push({ path: f, added: readText(path.join(cwd, f)).split("\n") });
      }
    }
    return files;
  } catch {
    return null;
  }
}

// ─── ExecIo ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExecIo  every side effect of the execution layer — replaceable in tests
 * @property {string} root                   main worktree
 * @property {string} cli                    path to `cli.mjs`
 * @property {string} plannerScript          path to `run-planner.sh`
 * @property {SpawnFn} spawn
 * @property {ClaudeFn} [claude]    open a `claude -p` session via `runClaude` (A-037): records `agent.start/end` + usage,
 *           text log to `logs/agent-queue/<id>/<role>.log`. Absent (fake io) → `execRole` uses `spawn` as before
 * @property {(type: string, fields: Record<string, unknown>) => void} [emit]  emit an event into the ledger; never throws
 * @property {GitFn} git
 * @property {() => Date} now
 * @property {() => PermissionMode} permission
 * @property {(id: string) => Task|undefined} task
 * @property {() => Bug[]} bugs
 * @property {(id: string) => Record<string, string>} readEnv   worker env (`.claude/worktrees/<id>.env`)
 * @property {(file: string) => string} readText                "" if the file does not exist
 * @property {(id: string, text: string) => string|null} [writeCompact]  write `logs/agent-queue/<id>/compact-<n>.md`
 *           (A-055), returns the repo-relative path; null = could not write
 * @property {(role: string) => string[]|undefined} agentTools  the `tools` field of `.claude/agents/<role>.md`
 * @property {(cwd: string) => string[]} syncBugs               move NEW bug files from the worktree to the main tree
 * @property {(id: string, name: string, text: string) => void} writeLog   `logs/agent-queue/<id>/<name>.log`
 * @property {(taskId: string, role: string, output: string) => void} recordFindings
 * @property {(task: Task, event: string, patch?: {owner?: string|null}) => void} apply
 * @property {(file: string, patch: Record<string, string|number|null>) => void} patchFile
 * @property {(task: Task, opts?: {phase?: "pre-review"|"integrate"}) => Promise<{ok: boolean, reason: string|null}>} verify
 *           verify in the main worktree (serial lane); `opts.phase` (A-089) is tagged onto `verify.result`
 * @property {(a: {taskId: string, ok: boolean, report: import("./conductor.mjs").VerifyReport, reason: string|null, env: Record<string, string>,
 *           phase: "pre-review"|"integrate"}) => void} [recordVerify]  record ONE verify run executed in this layer
 *           (parallel lane, before reviewers — A-089): `verify.result` + a block in `verifier.log`. Absent (old fake io) → not recorded
 * @property {(id: string, slot: number, env: Record<string, string>, signal?: AbortSignal,
 *           opts?: {verifiedHead?: string|null}) => Promise<IntegrationResult>} integrate
 *           `opts.verifiedHead` (A-089): SHA verified green before reviewers — if the branch is still at that SHA after rebase, the verify is skipped
 * @property {(task: Task, needsHuman: string[], scope: "all"|"task") => {committed: boolean, sha: string|null, pushed: boolean, reason: string}} commit
 *           `scope: "task"` stages only the task's files — a worker-branch merge never sweeps the serial lane's unfinished work
 * @property {() => void} syncPlanner
 * @property {(taskId: string) => void} [holdSerialLeftover]  A-086: a serial-lane task fell back to `todo` (execution error) — record
 *           its unfinished work on the main tree; absent (old fake io) → skipped
 * @property {(line: string) => void} log
 * @property {(cwd: string) => string[]|null} [changedPaths]  work paths the task changed in `cwd` (including new untracked
 *           files; null = unreadable). When present, `integrate` blocks a task that left no change outside the bookkeeping dirs (see `substantivePaths`);
 *           absent (old fake io) → guard skipped
 */

/**
 * @typedef {Object} ExecReport
 * @property {string[]} done
 * @property {string[]} gated
 * @property {string[]} failed
 * @property {string[]} released
 * @property {{id: string, reason: string}[]} patterns
 * @property {{closed: string[], reopened: string[], exhausted: string[]}} bugs
 */

/** Name of the planner lane in the "who hit the usage limit" list (`limitHit().ids`) — the planner has no task id. */
export const PLANNER_LIMIT_ID = "planner";

/** What Claude Code prints when a usage limit is hit (session / weekly / organisation) or it is rate limited. */
const USAGE_LIMIT = /hit your (?:session |usage |weekly |daily |org(?:anization)? )?limit|usage limit (?:reached|exceeded)|claude ai usage limit|rate_limit_error/i;

/**
 * PURE FUNCTION. Whether a `claude -p` session's output means "usage limit hit"; if so, with the reset time when
 * Claude Code states it ("· resets 12:30am (Asia/Saigon)"). A usage limit is NOT a dead worker: retrying just burns
 * turns within seconds (incident 2026-09-26: T-230…T-234 all `failed`, each turn exiting with code 1 after 4 seconds).
 * @param {string} text @returns {{resetsAt: string|null}|null}
 */
export function usageLimit(text) {
  if (typeof text !== "string" || !USAGE_LIMIT.test(text)) return null;
  const m = /resets?\s+(?:at\s+)?([^\n·|]+?)\s*(?:[·|]|$)/im.exec(text);
  return { resetsAt: m ? m[1].trim() : null };
}

/**
 * PURE FUNCTION. The LAST block of `verifier.log` if it is RED: strips ANSI colour codes and `at …` stack lines, keeps the last
 * `maxLines` lines. Last block green / empty log → null. A retrying role needs to see the real error: without it, T-234's
 * developer re-ran three times without knowing where the spec was red (2026-09-27).
 * @param {string} logText @param {number} [maxLines] @returns {string|null}
 */
export function lastRedVerify(logText, maxLines = 40) {
  if (typeof logText !== "string") return null;
  const starts = [...logText.matchAll(/^===== verify [^\n]*=====$/gm)];
  const last = starts.at(-1);
  if (!last || last.index === undefined || !/· red =====$/.test(last[0])) return null;
  const lines = logText.slice(last.index).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n")
    .filter((l) => !/^\s+at\s/.test(l)).map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const body = lines.slice(1);
  const kept = body.length > maxLines ? ["…", ...body.slice(-maxLines)] : body;
  return [lines[0], ...kept].join("\n");
}

/**
 * PURE FUNCTION. Split `verifier.log` into `===== verify … =====` blocks, in write order.
 * @param {string} logText @returns {{red: boolean, text: string}[]}
 */
export function verifyBlocks(logText) {
  if (typeof logText !== "string") return [];
  const starts = [...logText.matchAll(/^===== verify [^\n]*=====$/gm)];
  return starts.map((m, i) => {
    const from = m.index ?? 0;
    const to = starts[i + 1]?.index ?? logText.length;
    return { red: /· red =====$/.test(m[0]), text: logText.slice(from, to) };
  });
}

/**
 * PURE FUNCTION (A-053). "Fingerprint" of a red verify block: the red command lines (`✗ …`) + the first error line
 * (`Error:` / `AssertionError` / `FAIL` / `error TS…`), with whatever changes between runs without changing the nature of the
 * error stripped: ANSI colour codes, durations `(33467ms)`, ISO timestamps, temp paths, line:column numbers. Neither a red
 * command nor an error line → null (cannot conclude "same failure").
 * @param {string} block @returns {string|null}
 */
export function failureFingerprint(block) {
  if (typeof block !== "string") return null;
  const norm = (/** @type {string} */ l) => l
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\(\d+(?:\.\d+)?\s?m?s\)/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/\S+/g, "<tmp>")
    .replace(/:\d+:\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const lines = block.split("\n").map(norm);
  const red = lines.filter((l) => l.startsWith("✗ "));
  const err = lines.find((l) => /(?:^|\s)(?:\w*Error:|AssertionError|FAIL\b|error TS\d+)/.test(l)) ?? null;
  if (red.length === 0 && err === null) return null;
  return [...red, ...(err === null ? [] : [err])].join(" | ");
}

/**
 * PURE FUNCTION (A-053). The LAST two verify blocks of `verifier.log` are both red with the same fingerprint → return that
 * fingerprint; otherwise null. The last re-run did not fix the error — running again just burns tokens (T-234: three turns, one error).
 * @param {string} logText @returns {string|null}
 */
export function sameFailure(logText) {
  const blocks = verifyBlocks(logText);
  if (blocks.length < 2) return null;
  const [prev, last] = blocks.slice(-2);
  if (!prev.red || !last.red) return null;
  const a = failureFingerprint(prev.text);
  return a !== null && a === failureFingerprint(last.text) ? a : null;
}

/**
 * Prompt for RESUMING a developer session after a red verify (A-053): the session already has the task, the conventions and
 * what it just did — send only the error. Does not re-insert the task body, context pack or diff.
 * @param {string} id @param {string} role @param {string} red the red verify block (secrets redacted)
 * @returns {string}
 */
export function resumePrompt(id, role, red) {
  return [
    `Continue the ${role} session of task ${id}. The verify just ran RED (real verifier run):`,
    "```",
    red,
    "```",
    `Fix exactly this error — re-running without changes will be red again. Full log: \`logs/agent-queue/${id}/verifier.log\`.`,
    "Another role may have made changes after your previous turn: check `git diff` before editing.",
    `When done, add 1–2 lines to \`## ${config.headings.handoff}\` in the task file (what you fixed). Do NOT edit the \`status\` field.`,
  ].join("\n");
}

/** Directories holding only queue bookkeeping — editing them is not "doing the task". */
const BOOKKEEPING_DIRS = ["tasks/", "requirements/"];

/**
 * PURE FUNCTION. Paths that are real work (not `tasks/`, `requirements/` bookkeeping).
 * Empty = the role left nothing but the handoff log — usually because the agent stopped midway (a denied command)
 * yet exited 0; a `verify:` running only existing tests is still green (incident A-042: `done` without a single line of code).
 * @param {string[]} paths repo-relative paths, `/` separators
 * @returns {string[]}
 */
export function substantivePaths(paths) {
  return paths.filter((p) => p !== "" && !BOOKKEEPING_DIRS.some((d) => p.startsWith(d)));
}

/** @returns {ExecReport} */
export function newExecReport() {
  return { done: [], gated: [], failed: [], released: [], patterns: [], bugs: { closed: [], reopened: [], exhausted: [] } };
}

/**
 * @typedef {Object} Executor
 * @property {(actions: Action[]) => void} start   start background jobs for the executable actions (does not wait)
 * @property {(run: ExecReport) => void} attach    write results into the run's report (`runConductor`'s `RunReport`)
 * @property {() => Running[]} running             tasks currently held — fed into `tick`'s `State.running`
 * @property {(id: string) => boolean} has         the task has a Running entry (its worktree is held by this layer)
 * @property {() => string|null} plannerWork
 * @property {() => {id: string, startedAt: number}[]} alive     for `recover` (`Observed.alive`)
 * @property {() => {id: string, code: number}[]} exited         for `recover` (`Observed.exited`)
 * @property {(id: string) => void} kill           stop the task's process (worktree untouched)
 * @property {(id: string) => void} forget         forget the Running entry (after `release`)
 * @property {(task: Task, slot: number, chain: import("./roles.mjs").ChainStep[]) => void} adopt  re-adopt a worker from a previous run
 * @property {(id: string, event: string) => void} taskEvent
 * @property {() => boolean} busy
 * @property {() => Promise<void>} idle            resolves when ONE background job finishes (immediately if there are none)
 * @property {() => Promise<void>} settled         resolves when ALL background jobs finish
 * @property {() => {ids: string[], resetsAt: string|null}|null} limitHit  which sessions reported hitting the Claude usage limit
 * @property {(id: string) => boolean} wasLimited   this task stopped on the usage limit (not counted as a dead worker)
 */

/**
 * @param {ExecIo} io
 * @param {{run?: ExecReport, maxRetries?: number, workers?: number}} [options]
 * @returns {Executor}
 */
export function createExecutor(io, options = {}) {
  let run = options.run ?? newExecReport();
  const maxRetries = options.maxRetries ?? config.maxRetries;
  const workers = options.workers ?? config.workers;

  /** @type {Map<string, Running>} */
  const registry = new Map();
  /** Tasks with a background job (at any step) — `recover` treats them as "process alive". @type {Map<string, {startedAt: number, abort: AbortController}>} */
  const active = new Map();
  /** @type {Map<string, number>} */
  const exitedCodes = new Map();
  /** Consecutive red/broken runs of a task — guard against infinite loops. @type {Map<string, number>} */
  const fails = new Map();
  /**
   * Latest developer session per `<task>:<role>` (A-053): after a red verify the re-run RESUMES this session instead of
   * opening a fresh one that re-reads everything. Remembered only within one conductor process — a restart opens fresh sessions as before.
   * `agentId` (A-083): the resumed turn records it in `agent.start`'s `resumedFrom` so `task quality` links two turns of one session.
   * @type {Map<string, {sessionId: string, agentId: string|null, cwd: string}>}
   */
  const sessions = new Map();
  /** @param {string} id */
  const forgetSessions = (id) => { for (const k of [...sessions.keys()]) if (k.startsWith(`${id}:`)) sessions.delete(k); };
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();
  /** Deferral reasons already reported — `tick` regenerates actions every round, do not log repeatedly. @type {Set<string>} */
  const told = new Set();
  /** @type {{work: string}|null} */
  let planner = null;

  /** @param {string} key @param {string} line */
  const tellOnce = (key, line) => {
    if (told.has(key)) return;
    told.add(key);
    io.log(line);
  };
  /** @param {string} id */
  const drop = (id) => { registry.delete(id); exitedCodes.delete(id); };
  /** Tasks whose `claude -p` session exited on the usage limit → reset time (null if unknown). Kept until the run ends. @type {Map<string, string|null>} */
  const limited = new Map();

  /**
   * Run one background job for task `id`. Any error → `crash`: log it, return the task to `todo` (or `failed` if
   * repeated beyond `maxRetries`) — never crashes the conductor loop.
   * @param {string} id @param {(signal: AbortSignal) => Promise<void>} fn @returns {boolean} false if the task already has a job
   */
  function job(id, fn) {
    if (active.has(id)) return false;
    const ctl = new AbortController();
    active.set(id, { startedAt: io.now().getTime(), abort: ctl });
    const mine = registry.get(id);
    /** @type {Promise<void>} */
    const p = (async () => {
      try {
        await fn(ctl.signal);
      } catch (err) {
        crash(id, mine, /** @type {Error} */ (err));
      } finally {
        if (active.get(id)?.abort === ctl) active.delete(id);
      }
    })().finally(() => { inflight.delete(p); });
    inflight.add(p);
    return true;
  }

  /** @param {string} id @param {Running|undefined} r @param {Error} err */
  function crash(id, r, err) {
    const line = `${id}: execution layer error — ${redact(err.message)}`;
    io.log(line);
    safely(() => io.writeLog(id, "worker", `${io.now().toISOString()} ${line}\n`));
    if (r === undefined || registry.get(id) !== r) return;
    drop(id);
    const task = io.task(id);
    if (!task || task.status !== "doing") return;
    const n = (fails.get(id) ?? 0) + 1;
    fails.set(id, n);
    const event = n > maxRetries ? "fail" : "release";
    safely(() => io.apply(task, event, { owner: null }));
    // A-086: a serial-lane task falling back to `todo` leaves unfinished files on the main tree — record it so the next round pins it to the serial lane.
    if (event === "release" && r.slot === null) safely(() => io.holdSerialLeftover?.(id));
    (event === "fail" ? run.failed : run.released).push(id);
    io.log(`${id} → ${event === "fail" ? "failed" : "todo"} (execution error #${n})`);
  }

  /** @param {() => void} fn */
  function safely(fn) {
    try { fn(); } catch (err) { io.log(`secondary error: ${redact(/** @type {Error} */ (err).message)}`); }
  }

  /** `node cli.mjs …` in the main worktree; code ≠ 0 → throws with the redacted output. @param {string[]} args @param {AbortSignal} [signal] */
  async function cli(args, signal) {
    const r = await io.spawn(process.execPath, [io.cli, ...args], { cwd: io.root, signal });
    if (r.code !== 0) throw new Error(`\`cli ${args.join(" ")}\` exited with code ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  }

  /** @param {Running} r @returns {string} */
  const cwdOf = (r) => (r.slot === null ? io.root : worktreePath(io.root, r.id));

  /** Work diff in `cwd` against the fork point from the main branch. @param {string} cwd */
  function diffOf(cwd) {
    if (cwd === io.root) return io.git(cwd, ["diff", "HEAD"]).out;
    const base = io.git(io.root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
    const mb = io.git(cwd, ["merge-base", base, "HEAD"]).out;
    io.git(cwd, ["add", "-A"]); // new untracked files must show up in the reviewer's diff too
    return io.git(cwd, ["diff", "--cached", mb]).out;
  }

  /**
   * Commit in-progress work INSIDE the worker's worktree (branch `agent/<id>`). Agents do not commit; the conductor
   * commits so `integrate` has something to rebase, and so the fixer's diff contains only what the fixer changed.
   * @param {string} cwd @param {string} id @param {string} why
   */
  function commitWorktree(cwd, id, why) {
    io.git(cwd, ["add", "-A"]);
    const staged = io.git(cwd, ["diff", "--cached", "--name-only"]).out;
    if (staged === "") return;
    const c = io.git(cwd, ["-c", "user.name=conductor", "-c", "user.email=conductor@localhost", "commit", "-q", "-m", `wip(${id}): ${why}`]);
    if (!c.ok) throw new Error(`commit in worktree ${id} failed: ${redact(c.out)}`);
  }

  /**
   * Run `claude -p` for ONE role, logging to `logs/agent-queue/<id>/<role>.log`. Does not change the task's status.
   * `resume`: session id to `--resume` (A-052/A-053) — null/absent = fresh session; `resumedFrom`: that session's agentId;
   * `resumeKind` (A-083): `chain` resumes the previous task's session · `retry` resumes this task's own session after a red verify.
   * @param {{id: string, cwd: string, env: Record<string, string>, role: string, round?: number, slot: number|null,
   *          prompt: string, reason: string, signal: AbortSignal, resume?: string|null, resumedFrom?: string|null,
   *          resumeKind?: import("./events.mjs").ResumeKind|null}} a
   * @returns {Promise<SpawnResult>}
   */
  async function execRole(a) {
    const mode = io.permission();
    const rule = config.roles[a.role];
    if (!rule) throw new Error(`role "${a.role}" is not in the roles table`);
    const args = claudeArgs(a.role, { id: a.id, round: a.round }, { ...rule, tools: io.agentTools(a.role) }, mode);
    if (a.resume) args.push("--resume", a.resume);
    const model = args[2];
    // A-055: in-task safety net — Claude Code auto-compacts when the context reaches this window (minus the summary buffer),
    // and the PostCompact hook writes the summary to a file. The window is its own key `compactWindow` (A-075), NOT
    // `sessionChain.maxContext` — the resume threshold and how large a session may grow are two different numbers.
    // `a.env` may override it (a boundary compact turn needs a window larger than the session it summarises).
    const env = {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.compactWindow),
      ...a.env, AGENT_QUEUE_DISABLE: "1", AGENT_QUEUE_COMMIT: "0", AGENT_QUEUE_PUSH: "0",
    };
    const where = path.relative(io.root, a.cwd) || "main worktree";
    const head = [
      `\n===== ${io.now().toISOString()} · ${a.role} (${model}) · ${a.id} · ${where}`,
      `why: ${a.reason}`,
      `command: claude ${args.join(" ")}   (prompt via stdin)`,
      `extra env: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).sort().join(" ")}`,
    ];
    if (mode === "skip") {
      head.push("WARNING: AGENT_QUEUE_SKIP_PERMISSIONS=1 — running with --dangerously-skip-permissions, NO per-role allow-list.");
      io.log(`${a.id}: WARNING ${a.role} runs with --dangerously-skip-permissions (AGENT_QUEUE_SKIP_PERMISSIONS=1)`);
    }
    if (childFull()) {
      head.push("WARNING: AGENT_QUEUE_CHILD_FULL=1 — the child session loads all of the machine's MCP servers/skills/tools (no slimming flags); the budget cap stays.");
      io.log(`${a.id}: WARNING ${a.role} runs without slimming flags (AGENT_QUEUE_CHILD_FULL=1)`);
    }
    io.writeLog(a.id, a.role, `${redact(head.join("\n"), a.env)}\n`);
    io.log(`${a.id}: ▶ ${a.role} (${model}) — ${a.reason}`);
    const t0 = io.now().getTime();
    const timeoutMs = config.workerTimeoutMin * 60_000;
    const prompt = withPermissionNote(a.prompt, mode);
    /** @type {SpawnResult} */
    let res;
    if (io.claude) {
      // Via `runClaude`: the session's text already went to the log WHILE running (secrets redacted); only the closing line is left here.
      const r = await io.claude({
        args, prompt, cwd: a.cwd, env, taskId: a.id, role: a.role, model, slot: a.slot, signal: a.signal, timeoutMs,
        redact: (text) => redact(text, a.env), resumedFrom: a.resumedFrom ?? null, resumeKind: a.resumeKind ?? null,
      });
      res = { code: r.code, stdout: r.output, stderr: "", sessionId: r.sessionId ?? null, agentId: r.agentId, budgetExceeded: r.budgetExceeded === true };
    } else {
      res = await io.spawn("claude", args, { cwd: a.cwd, env, input: prompt, signal: a.signal, timeoutMs });
      io.writeLog(a.id, a.role, `${redact(`${res.stdout}${res.stderr}`, a.env)}\n`);
    }
    const secs = Math.round((io.now().getTime() - t0) / 1000);
    if (res.budgetExceeded) {
      // A-087: hitting the cap = one failed session exit (counts towards MAX_RETRIES). Never raise the cap, never re-run with a larger one.
      const cap = args[args.indexOf("--max-budget-usd") + 1];
      const line = `${a.id}: ${a.role} stopped on the ${cap} USD budget cap`;
      io.writeLog(a.id, a.role, `${line}\n`);
      io.log(line);
      if (res.code === 0) res = { ...res, code: 1 };
    }
    io.writeLog(a.id, a.role, `----- exited with code ${res.code} after ${secs}s\n`);
    io.log(`${a.id}: ■ ${a.role} exited with code ${res.code} (${secs}s) — log: logs/agent-queue/${a.id}/${a.role}.log`);
    return res;
  }

  /**
   * Run the `verify:` commands in `cwd` with the worker env. Stops at the first red command (later ones are recorded `skipped`).
   * `results` has the same shape as `cli verify --json`'s report so `recordVerify` writes a `verifier.log` block like any other run.
   * @param {string} cwd @param {Record<string, string>} env @param {string[]} commands @param {AbortSignal} signal
   * @returns {Promise<{ok: boolean, reason: string|null, results: import("./verify.mjs").CheckResult[]}>}
   */
  async function verifyIn(cwd, env, commands, signal) {
    /** @type {import("./verify.mjs").CheckResult[]} */
    const results = [];
    /** @type {string|null} */
    let reason = null;
    for (const command of commands) {
      if (reason !== null) {
        results.push({ command, outcome: "skipped", exitCode: null, output: "", durationMs: 0 });
        continue;
      }
      const t0 = io.now().getTime();
      const r = await io.spawn("sh", ["-c", command], { cwd, env, signal, timeoutMs: config.verifyTimeoutMs });
      const durationMs = Math.max(0, io.now().getTime() - t0);
      if (r.code === 0) {
        results.push({ command, outcome: "passed", exitCode: 0, output: "", durationMs });
        continue;
      }
      const output = redact(`${r.stdout}${r.stderr}`, env).trim();
      reason = `\`${command}\` exited with code ${r.code}: ${output.split("\n").slice(-6).join(" | ")}`;
      results.push({ command, outcome: "failed", exitCode: r.code, output, durationMs });
    }
    return { ok: reason === null, reason, results };
  }

  /**
   * A role of the task finished in `r`: record it, or leave it to `recover` if it exited ≠ 0.
   * @param {string} id @param {Running} r @param {string} role @param {string} kind @param {SpawnResult} res @param {string} cwd
   */
  function roleFinished(id, r, role, kind, res, cwd) {
    if (registry.get(id) !== r) return;
    if (kind === "reviewer") io.recordFindings(id, role, res.stdout); // does NOT block merging (A-021)
    if (r.slot !== null) {
      const moved = io.syncBugs(cwd);
      if (moved.length > 0) io.log(`${id}: ${role} filed ${moved.length} bug(s) (${moved.join(", ")}) — moved to the main tree`);
    }
    if (res.code !== 0) {
      const hit = usageLimit(res.stdout);
      if (hit) {
        limited.set(id, hit.resetsAt);
        io.log(`${id}: ${role} stopped on the Claude usage limit${hit.resetsAt ? ` (resets ${hit.resetsAt})` : ""} — no new work handed out`);
      }
      exitedCodes.set(id, res.code); // phase unchanged → `recover` returns the task to todo, worktree kept
      return;
    }
    exitedCodes.delete(id);
    r.rolesDone.push(role);
    r.activeRole = null;
    r.phase = "reviewing";
    // Developer/QA may have changed files since the last verify → the "verified green" marker is moot. Reviewers are read-only, so it stays.
    if (kind !== "reviewer") r.verifiedHead = null;
  }

  // ─── spawn-worker ─────────────────────────────────────────────────────────

  /** `pattern.chosen` when a `spawn-worker` is executed. A ledger error never affects task dispatch.
   * @param {Extract<Action, {type: "spawn-worker"}>} a */
  function emitPattern(a) {
    if (!io.emit) return;
    safely(() => {
      const task = io.task(a.id);
      if (task) io.emit?.("pattern.chosen", patternFields(task, a.reason, { slot: a.slot, role: a.role, model: a.model }));
    });
  }

  /** @param {Extract<Action, {type: "spawn-worker"}>} a */
  function startWorker(a) {
    if (registry.has(a.id) || active.has(a.id)) return;
    if (a.lane === "parallel") {
      const used = [...registry.values()].filter((r) => r.lane === "parallel");
      if (used.length >= workers) return tellOnce(`cap:${a.id}`, `${a.id}: all ${workers} worker(s) busy (AGENT_QUEUE_WORKERS) — deferred to next round`);
      if (a.slot === null || used.some((r) => r.slot === a.slot)) return tellOnce(`slot:${a.id}:${a.slot}`, `${a.id}: slot ${a.slot} is busy — deferred to next round`);
    }
    /** @type {Running} */
    const r = { id: a.id, lane: a.lane, slot: a.slot, phase: "developing", rolesDone: [], activeRole: null };
    registry.set(a.id, r);
    exitedCodes.delete(a.id);
    run.patterns.push({ id: a.id, reason: a.reason });
    io.log(`${a.id}: ${a.chain.map((s) => `${s.role}(${s.model})`).join(" → ")} — ${a.reason}`);
    emitPattern(a);
    const kind = a.chain[0]?.kind ?? "developer";

    job(a.id, async (signal) => {
      const task = /** @type {Task} */ (io.task(a.id));
      if (a.lane === "serial") {
        if (task.status === "todo") io.apply(task, "claim", { owner: CONDUCTOR_OWNER });
      } else {
        const slot = /** @type {number} */ (a.slot);
        if (task.status === "todo") await cli(["start", a.id, "--worker", String(slot)], signal);
        if (!a.reuseWorktree) await cli(["worker", "add", a.id, String(slot)], signal);
      }
      const summary = a.compactSummary ? await compactBoundary(a.id, a.compactSummary, signal) : null;
      await runChainStep(a.id, r, { role: a.role, kind, reason: a.reason, resume: a.resume ?? null, summary }, signal);
    });
  }

  /** Extra headroom for the boundary compact turn: enough for the summary prompt + an answer of ≤ 8,000 characters. */
  const COMPACT_HEADROOM = 50_000;

  /**
   * A-055: compact turn at a task boundary — `--resume` the previous task's oversized developer session (cache still warm), ask for
   * a templated summary, write it to `logs/agent-queue/<previous task>/compact-<n>.md`, emit `agent.compact`. Returns the content
   * to put into the next task's FRESH session; a broken/empty summary turn → null (the next task still runs, just without a summary).
   * @param {string} id next task @param {import("./conductor.mjs").CompactFrom} from @param {AbortSignal} signal
   * @returns {Promise<{text: string, file: string|null, fromTaskId: string}|null>}
   */
  async function compactBoundary(id, from, signal) {
    const next = /** @type {Task} */ (io.task(id));
    // This session is ALREADY larger than `maxContext` and may exceed `compactWindow` too: with a window smaller than the session,
    // Claude Code would auto-compact on resume — summarising twice. So window = max(default, session context + headroom), never below the default.
    const window = Math.max(config.compactWindow, from.before + COMPACT_HEADROOM);
    const res = await execRole({
      id, cwd: io.root, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) }, role: from.role,
      slot: null, prompt: compactPrompt(from.fromTaskId, next),
      reason: `compact session ${from.sessionId} of ${from.fromTaskId} (context ${from.before}) before opening a fresh session for ${id}`,
      signal, resume: from.sessionId, resumedFrom: from.fromAgentId, resumeKind: "chain",
    });
    const text = res.stdout.trim().slice(0, COMPACT_MAX_CHARS);
    if (res.code !== 0 || text === "") {
      io.log(`${id}: compact turn for session ${from.sessionId} failed (code ${res.code}) — opening a fresh session without a summary`);
      return null;
    }
    const header = `<!-- compact · boundary · session ${from.sessionId} (${from.fromTaskId}) · context ${from.before} · ${io.now().toISOString()} -->\n`;
    const file = io.writeCompact?.(from.fromTaskId, `${header}${text}`) ?? null;
    safely(() => io.emit?.("agent.compact", {
      agentId: from.fromAgentId, taskId: from.fromTaskId, trigger: "boundary", before: from.before, file,
    }));
    io.log(`${id}: compacted session ${from.sessionId} → ${file ?? "(could not write file)"}`);
    return { text, file, fromTaskId: from.fromTaskId };
  }

  /**
   * A-090 — the reviewer `when.diff` gate, right before opening the session. Role without `when.diff` → false (runs as before).
   * Diff does not match → NO session, NO report/`finding`; writes a `skipped:` block to the role log, the conductor log, a
   * `role.skipped` event, and marks the role done (the next round does not call it again). The reason quotes no diff lines. Diff read error → run.
   * @param {string} id @param {Running} r @param {string} role @param {string} cwd @returns {boolean} true = skipped
   */
  function skipReviewer(id, r, role, cwd) {
    const rule = config.roles[role];
    if (!rule?.when.diff) return false;
    const files = readGateFiles(io.git, io.readText, io.root, cwd);
    if (files === null) return false;
    const gate = reviewerGate(rule, files);
    if (gate.run) return false;
    io.writeLog(id, role, `\n===== ${io.now().toISOString()} · ${role} · ${id}\nskipped: ${gate.reason}\n`);
    io.log(`${id}: skipping ${role} — ${gate.reason}`);
    safely(() => io.emit?.("role.skipped", { taskId: id, role, reason: gate.reason }));
    if (registry.get(id) === r) {
      exitedCodes.delete(id);
      r.rolesDone.push(role);
      r.activeRole = null;
      r.phase = "reviewing";
    }
    return true;
  }

  /**
   * Run one role of the chain (developer or a later role) and record the result. `step.resume`: `tick` decided to resume the
   * previous developer session (A-052) — applied only when there is NO red verify (otherwise A-053's resume-with-error path wins).
   * @param {string} id @param {Running} r
   * @param {{role: string, kind: string, reason: string, resume?: import("./conductor.mjs").Resume|null,
   *          summary?: {text: string, file: string|null, fromTaskId: string}|null}} step
   * @param {AbortSignal} signal
   */
  async function runChainStep(id, r, step, signal) {
    const task = /** @type {Task} */ (io.task(id));
    const cwd = cwdOf(r);
    const env = r.slot === null ? {} : io.readEnv(id);
    if (step.kind === "reviewer" && skipReviewer(id, r, step.role, cwd)) return;
    const own = cwd === io.root ? "" : io.readText(path.join(cwd, task.file));
    const handoff = sectionOrNull(own === "" ? task.body : own, config.headings.handoff) ?? "";
    const red = step.kind === "developer" || step.kind === "fixer"
      ? lastRedVerify(io.readText(path.join(io.root, "logs", "agent-queue", id, "verifier.log")))
      : null;
    const feedback = red === null ? "" : "\n\n## Previous verify was RED — real verifier run, read before working\n```\n"
      + `${redact(red, env)}\n\`\`\`\nFull log: \`logs/agent-queue/${id}/verifier.log\`. Fix exactly this error — re-running without changes `
      + "will be red again.";
    // A-053: red verify + this same role still has a developer session in the same directory → RESUME it, send only the error.
    const key = `${id}:${step.role}`;
    const prev = step.kind === "developer" ? sessions.get(key) : undefined;
    const retryResume = red !== null && prev !== undefined && prev.cwd === cwd ? prev.sessionId : null;
    const chained = red === null && step.kind === "developer" && step.resume ? step.resume : null;
    const resume = retryResume ?? chained?.sessionId ?? null;
    /** @type {string} */
    let prompt;
    if (retryResume !== null) {
      prompt = resumePrompt(id, step.role, redact(/** @type {string} */ (red), env));
    } else if (chained !== null) {
      const packFile = contextPackFile(task);
      const pack = packFile === null ? null : io.readText(path.join(io.root, packFile));
      prompt = continuePrompt(step.role, task, diffOf(cwd), handoff, pack, chained.fromTaskId);
    } else {
      // The context pack is read from the repo root (the planner writes it on main) — the worktree may predate the pack (A-051).
      const packFile = contextPackFile(task);
      const pack = packFile === null ? null : io.readText(path.join(io.root, packFile));
      const summary = step.summary
        ? `\n\n## Summary of the previous developer session (${step.summary.fromTaskId}, compacted${step.summary.file ? ` — ${step.summary.file}` : ""})\n`
          + `The previous session was closed for being too large; this is what it left. ${config.headings.handoff} and the diff win over the summary when they disagree.\n\n`
          + step.summary.text
        : "";
      prompt = `${rolePrompt(step.role, task, diffOf(cwd), handoff, pack)}${summary}${feedback}`;
    }
    const reason = retryResume !== null ? `${step.reason} · resume session ${retryResume} (verify red)` : step.reason;
    /** @type {import("./events.mjs").ResumeKind|null} */
    const resumeKind = retryResume !== null ? "retry" : chained !== null ? "chain" : null;
    let res = await execRole({
      id, cwd, env, role: step.role, slot: r.slot, prompt, reason, signal, resume, resumeKind,
      resumedFrom: retryResume !== null ? prev?.agentId ?? null : chained?.fromAgentId ?? null,
    });
    if (step.kind === "reviewer" && res.code === 0) {
      // A-073: exit 0 without a valid JSON block → call again EXACTLY ONCE, fresh session (no `--resume`), same model +
      // allow-list + prompt, plus an error tail. The first attempt leaves no error report or `error`-level `finding`: `roleFinished`
      // only records the FINAL output. Exit ≠ 0 follows the existing recovery path.
      const parsed = parseFindings(res.stdout);
      if (shouldRetryReviewer(parsed, 1)) {
        const error = parsed.ok ? "" : parsed.error;
        res = await execRole({
          id, cwd, env, role: step.role, slot: r.slot, prompt: prompt + reviewerRetryTail(error), signal,
          reason: `call 2/${MAX_REVIEWER_CALLS}: previous turn had no valid JSON block (${error})`,
        });
      }
    }
    if (step.kind === "developer") {
      // Resume failed (session deleted, `--resume` error…) → forget it: next time open a fresh session, don't repeat the same error.
      if (res.code === 0 && res.sessionId) sessions.set(key, { sessionId: res.sessionId, agentId: res.agentId ?? null, cwd });
      else if (resume !== null) sessions.delete(key);
    }
    roleFinished(id, r, step.role, step.kind, res, cwd);
  }

  /** @param {Extract<Action, {type: "spawn-role"}>} a */
  function startRole(a) {
    const r = registry.get(a.id);
    if (!r || active.has(a.id)) return;
    const kind = config.roles[a.role]?.kind ?? "developer";
    const first = { role: a.role, kind, reason: a.reason, resume: a.resume ?? null };
    const group = kind === "reviewer"
      ? (a.parallelWith ?? []).filter((s) => s.role !== a.role && !r.rolesDone.includes(s.role) && config.roles[s.role]?.kind === "reviewer")
      : [];
    if (group.length === 0) {
      r.activeRole = a.role;
      job(a.id, (signal) => runChainStep(a.id, r, first, signal));
      return;
    }
    // Concurrent reviewers: ONE job for the whole group (the "one job per task" invariant holds — kill, timeout, recovery still go by
    // task id), one session per role. `roleFinished` of the first role to finish sets `activeRole = null`; reset it right away so `tick`
    // does not consider the task idle while another role is still running.
    const steps = [first, ...group.map((s) => ({ role: s.role, kind: "reviewer", reason: s.reason, resume: null }))];
    const left = new Set(steps.map((s) => s.role));
    r.activeRole = [...left].join(" + ");
    job(a.id, async (signal) => {
      await Promise.all(steps.map(async (step) => {
        await runChainStep(a.id, r, step, signal);
        left.delete(step.role);
        if (registry.get(a.id) === r && left.size > 0) r.activeRole = [...left].join(" + ");
      }));
      // One role exiting ≠ 0 and another exiting 0 afterwards clears the `exitedCodes` mark (roleFinished) — set it again so `recover`
      // handles it exactly as if that role had run alone.
      if (registry.get(a.id) === r && steps.some((s) => !r.rolesDone.includes(s.role)) && !exitedCodes.has(a.id)) {
        exitedCodes.set(a.id, 1);
      }
    });
  }

  // ─── verify-task (A-089) ──────────────────────────────────────────────────

  /**
   * Verify BEFORE reviewers. Serial lane: `io.verify` in the main worktree. Parallel lane: commit in-progress work to branch
   * `agent/<id>` (for a fixed SHA, including QA's tests) then run the `verify:` commands right in the worktree with the worker
   * env (`verifyIn`), recording `verifier.log` + `verify.result` (phase `pre-review`).
   * Red → exactly the merge step's "red verify" path: `settleRed` (count reds, same failure twice → failed, otherwise `release`),
   * registry dropped → next round the developer re-runs (resume with the error, A-053); no reviewer has been opened.
   * Green → record `verifiedHead`, back to phase `reviewing` so `tick` calls the reviewers.
   * @param {Extract<Action, {type: "verify-task"}>} a
   */
  function startVerify(a) {
    const r = registry.get(a.id);
    if (!r || active.has(a.id)) return;
    r.phase = "verifying";
    const parallel = r.slot !== null;

    job(a.id, async (signal) => {
      const fresh = /** @type {Task} */ (io.task(a.id));
      const task = { ...fresh, status: /** @type {Task["status"]} */ ("doing") };
      const cwd = cwdOf(r);
      const changed = io.changedPaths?.(cwd);
      if (changed && substantivePaths(changed).length === 0) {
        // Nothing to verify: let `startIntegrate` block it via `settleEmpty` as before (behaviour unchanged).
        r.verifiedHead = SERIAL_VERIFIED;
        r.phase = "reviewing";
        return;
      }
      /** @type {{ok: boolean, reason: string|null}} */
      let result;
      /** @type {string} */
      let head = SERIAL_VERIFIED;
      if (!parallel) {
        result = await io.verify(task, { phase: "pre-review" });
      } else {
        commitWorktree(cwd, a.id, "worker's work");
        head = io.git(cwd, ["rev-parse", "HEAD"]).out;
        const env = io.readEnv(a.id);
        const v = await verifyIn(cwd, env, task.verify, signal);
        safely(() => io.recordVerify?.({
          taskId: a.id, ok: v.ok, report: { ok: v.ok, results: v.results, reason: v.reason }, reason: v.reason, env, phase: "pre-review",
        }));
        result = v;
      }
      if (registry.get(a.id) !== r) return;
      if (!result.ok) {
        drop(a.id);
        settleRed(task, result.reason, parallel);
        return;
      }
      r.verifiedHead = head;
      r.phase = "reviewing";
      io.log(`${a.id}: verify green before reviewers${parallel ? ` (${head.slice(0, 7)})` : ""} — calling reviewers`);
    });
  }

  // ─── spawn-fixer ──────────────────────────────────────────────────────────

  /** @param {Extract<Action, {type: "spawn-fixer"}>} a */
  function startFixer(a) {
    const r = registry.get(a.parentId);
    if (!r) return; // parent not held by this layer → the conductor uses the serial path
    if (active.has(a.parentId)) return tellOnce(`fixer:${a.bugId}`, `fixer ${a.bugId}: deferred — ${a.parentId} still has a role running on the same worktree`);
    const bug = io.bugs().find((b) => b.id === a.bugId);
    if (!bug) return;
    r.activeRole = "fixer";
    job(a.parentId, async (signal) => {
      try {
        await fixOnce(a, bug, r, signal);
      } catch (err) {
        // No `crash`: the parent task stays `waiting-bugs` and keeps its worktree; only this bug goes back to `open` (costs one round).
        io.log(`fixer ${bug.id}: execution error — ${redact(/** @type {Error} */ (err).message)}`);
        safely(() => io.patchFile(bug.file, { status: "open", rounds: bug.rounds + 1 }));
        run.bugs.reopened.push(bug.id);
      } finally {
        r.activeRole = null;
      }
    });
  }

  /**
   * One fixer round on the parent task's worktree: fix → reproduction test + parent verify → verdict.
   * @param {Extract<Action, {type: "spawn-fixer"}>} a @param {Bug} bug @param {Running} r @param {AbortSignal} signal
   */
  async function fixOnce(a, bug, r, signal) {
    const parent = /** @type {Task} */ (io.task(a.parentId));
    const cwd = cwdOf(r);
    const env = r.slot === null ? {} : io.readEnv(a.parentId);
    io.patchFile(bug.file, { status: "fixing" });
    // Seal the dev/QA work into a commit: afterwards `git diff HEAD` holds only the fixer's changes.
    if (r.slot !== null) commitWorktree(cwd, a.parentId, `before fixer ${bug.id}`);
    const round = bug.rounds + 1;
    const res = await execRole({
      id: a.parentId, cwd, env, role: "fixer", round, slot: r.slot, prompt: fixerPrompt(bug, parent, diffOf(cwd)),
      reason: `${a.reason} · round ${round}`, signal,
    });
    if (registry.get(a.parentId) !== r) return;
    const changed = io.git(cwd, ["diff", "--name-only", "HEAD"]).out.split("\n").filter((f) => f !== "");
    const repro = await verifyIn(cwd, env, bug.verify, signal);
    const parentVerify = repro.ok ? await verifyIn(cwd, env, parent.verify, signal) : { ok: false };
    const verdict = fixVerdict(bug, { repro: repro.ok, parentVerify: parentVerify.ok, changed });
    const status = verdict.event === "pass" ? "fixed" : verdict.event === "fail" ? "open" : "needs-human";
    io.patchFile(bug.file, verdict.event === "pass" ? { status } : { status, rounds: bug.rounds + 1 });
    (verdict.event === "pass" ? run.bugs.closed : verdict.event === "fail" ? run.bugs.reopened : run.bugs.exhausted).push(bug.id);
    io.log(`${bug.id} → ${status}: ${verdict.reason} (fixer exited with code ${res.code})`);
  }

  // ─── integrate ────────────────────────────────────────────────────────────

  /**
   * Green verify → the verifier writes `done` (or `needs-human` when `manual` remains) → commit → push.
   * @param {Task} task @param {"all"|"task"} scope
   * @returns {boolean} true once finalised green
   */
  function settleGreen(task, scope) {
    fails.delete(task.id);
    forgetSessions(task.id);
    const gated = task.manual.length > 0;
    io.apply(task, gated ? "gate" : "pass", { owner: null });
    const c = io.commit(task, gated ? task.manual : [], scope);
    (gated ? run.gated : run.done).push(task.id);
    io.log(`${task.id} → ${gated ? "needs-human (machine part green)" : "done"} · ${c.committed ? `commit ${c.sha}` : "no commit"}: ${c.reason}${c.committed && !c.pushed ? " — NOT pushed" : ""}`);
    return true;
  }

  /**
   * Red verify: count consecutive reds; beyond `maxRetries` → failed. Otherwise: parallel lane `release`s (worktree
   * kept, reused next round); serial lane stays `doing` (tick retries it on the serial lane).
   * @param {Task} task @param {string|null} reason @param {boolean} parallel
   */
  function settleRed(task, reason, parallel) {
    const n = (fails.get(task.id) ?? 0) + 1;
    fails.set(task.id, n);
    // A-053: two consecutive red verifies with the SAME failure → stop now, don't wait for `maxRetries`.
    const same = sameFailure(io.readText(path.join(io.root, "logs", "agent-queue", task.id, "verifier.log")));
    if (same !== null) {
      io.apply(task, "fail", { owner: null });
      run.failed.push(task.id);
      forgetSessions(task.id);
      const line = `${task.id} → failed: same verify failure twice: ${redact(same)}`;
      io.log(line);
      safely(() => io.writeLog(task.id, "worker", `${io.now().toISOString()} ${line}\n`));
      return;
    }
    if (n > maxRetries) {
      forgetSessions(task.id);
      io.apply(task, "fail", { owner: null });
      run.failed.push(task.id);
      io.log(`${task.id} → failed (red ${n} times in a row): ${reason ?? ""}`);
      return;
    }
    io.log(`${task.id} red ${n}/${maxRetries + 1}: ${reason ?? ""}`);
    if (parallel) {
      io.apply(task, "release", { owner: null });
      run.released.push(task.id);
    }
  }

  /**
   * Role exited 0 but left no change outside `tasks/`/`requirements/` → `needs-human`, NO verify,
   * NO retry: an agent that stopped because it was blocked gets blocked the same way next time (A-038: three turns, the same
   * command denied three times). Commit the task file to keep the handoff log — the stop reason is there. Worktree (parallel lane) kept.
   * @param {Task} task @param {boolean} parallel
   */
  function settleEmpty(task, parallel) {
    fails.delete(task.id);
    const why = `role left no change outside tasks/ — the agent stopped midway or did nothing; see ${config.headings.handoff}`;
    io.apply(task, "gate", { owner: null });
    const c = io.commit(task, [why], "task");
    run.gated.push(task.id);
    io.log(`${task.id} → needs-human: ${why}${parallel ? ` · worktree kept at .claude/worktrees/${task.id}` : ""} · ${c.committed ? `commit ${c.sha}` : "no commit"}`);
  }

  /** @param {Extract<Action, {type: "integrate"}>} a */
  function startIntegrate(a) {
    const r = registry.get(a.id);
    if (!r || active.has(a.id)) return;
    r.phase = "integrating";
    const parallel = r.slot !== null;

    job(a.id, async (signal) => {
      const fresh = /** @type {Task} */ (io.task(a.id));
      // After ff-merge the task file on the main tree carries the fork point's status (todo) — the state machine needs `doing`.
      const task = { ...fresh, status: /** @type {Task["status"]} */ ("doing") };
      const changed = io.changedPaths?.(cwdOf(r));
      if (changed && substantivePaths(changed).length === 0) {
        drop(a.id);
        settleEmpty(task, parallel);
        return;
      }
      if (!parallel) {
        // A-089: already verified green before reviewers and reviewers write no files → no second verify.
        const v = r.verifiedHead ? { ok: true, reason: null } : await io.verify(task, { phase: "integrate" });
        if (r.verifiedHead) io.log(`${a.id}: verify already green on this exact commit (before reviewers) — skipping the second verify`);
        drop(a.id);
        if (v.ok) settleGreen(task, "all");
        else settleRed(task, v.reason, false);
        return;
      }
      const slot = /** @type {number} */ (r.slot);
      const cwd = cwdOf(r);
      commitWorktree(cwd, a.id, "worker's work");
      // The (uncommitted) `owner: worker:wN` marker on the main tree would block ff-merge if the branch also edits the task file.
      io.git(io.root, ["checkout", "--", fresh.file]);
      const verifiedHead = r.verifiedHead && r.verifiedHead !== SERIAL_VERIFIED ? r.verifiedHead : null;
      const res = await io.integrate(a.id, slot, io.readEnv(a.id), signal, { verifiedHead });
      if (registry.get(a.id) !== r) return;
      if (!res.ok) {
        drop(a.id);
        if (res.stage === "rebase") {
          io.apply(task, "fail", { owner: null });
          run.failed.push(a.id);
          io.log(`${a.id} → failed: rebase conflict in ${res.conflicts.join(", ") || "(unknown file)"} — NOT auto-resolved; worktree kept at .claude/worktrees/${a.id}`);
        } else if (res.stage === "merge") {
          io.apply(task, "fail", { owner: null });
          run.failed.push(a.id);
          io.log(`${a.id} → failed: ff-merge failed — ${redact(res.output)}; worktree kept`);
        } else {
          settleRed(task, redact(res.output).trim().split("\n").slice(-6).join(" | "), true);
        }
        return;
      }
      if (res.skippedVerify) io.log(`${a.id}: verify already green on this exact commit (before reviewers; rebase changed nothing) — skipping the merge-step verify`);
      io.log(`${a.id}: merged into the main branch (${res.sha})`);
      settleGreen(task, "task");
      drop(a.id);
      await cli(["worker", "rm", a.id]);
      io.log(`${a.id}: cleaned up worktree + branch`);
    });
  }

  // ─── planner ──────────────────────────────────────────────────────────────

  /** @param {Extract<Action, {type: "spawn-planner"}>} a */
  function startPlanner(a) {
    if (planner) return;
    planner = { work: a.work };
    io.log(`planner (${a.model}): ${a.work} — ${a.reason}`);
    /** @type {Promise<void>} */
    const p = (async () => {
      try {
        const res = await io.spawn("bash", [io.plannerScript], {
          cwd: io.root, env: { AGENT_QUEUE_PLANNER_MODEL: a.model, AGENT_QUEUE_DISABLE: "1" },
        });
        io.writeLog("planner", "run", `${redact(`${res.stdout}${res.stderr}`)}\n----- exited with code ${res.code}\n`);
        io.log(`planner exited with code ${res.code} — log: logs/agent-queue/planner/`);
        // A usage limit on the planner lane is still a usage limit: without this mark `tick` sees the planner work still pending and
        // reopens the planner every round up to the round cap (run-planner.sh prints the failed session's log tail to stdout).
        const hit = usageLimit(`${res.stdout}${res.stderr}`);
        if (hit) {
          limited.set(PLANNER_LIMIT_ID, hit.resetsAt);
          io.log(`planner stopped on the Claude usage limit${hit.resetsAt ? ` (resets ${hit.resetsAt})` : ""} — no new work handed out`);
        }
        io.syncPlanner();
      } catch (err) {
        io.log(`error in planner: ${redact(/** @type {Error} */ (err).message)}`);
      } finally {
        planner = null;
      }
    })().finally(() => { inflight.delete(p); });
    inflight.add(p);
  }

  return {
    start(actions) {
      for (const a of actions) {
        try {
          if (a.type === "spawn-worker") startWorker(a);
          else if (a.type === "spawn-role") startRole(a);
          else if (a.type === "verify-task") startVerify(a);
          else if (a.type === "spawn-fixer") startFixer(a);
          else if (a.type === "integrate") startIntegrate(a);
          else if (a.type === "spawn-planner") startPlanner(a);
        } catch (err) {
          io.log(`error in ${a.type}: ${redact(/** @type {Error} */ (err).message)}`);
        }
      }
    },
    attach: (report) => { run = report; },
    running: () => [...registry.values()].map((r) => ({ ...r, rolesDone: [...r.rolesDone] })),
    has: (id) => registry.has(id),
    plannerWork: () => planner?.work ?? null,
    alive: () => [...active].map(([id, a]) => ({ id, startedAt: a.startedAt })),
    exited: () => [...exitedCodes].map(([id, code]) => ({ id, code })),
    limitHit: () => (limited.size === 0 ? null
      : { ids: [...limited.keys()], resetsAt: [...limited.values()].find((v) => v !== null) ?? null }),
    wasLimited: (id) => limited.has(id),
    kill: (id) => { active.get(id)?.abort.abort(); },
    forget: drop,
    adopt(task, slot, chain) {
      const first = chain[0];
      if (!first || registry.has(task.id)) return;
      startWorker({
        type: "spawn-worker", id: task.id, lane: "parallel", slot, role: first.role, model: first.model, chain,
        retry: true, reuseWorktree: true, reason: `re-adopted from a previous run (owner ${task.owner}) — re-running the first role in the existing worktree`,
      });
    },
    taskEvent(id, event) {
      const r = registry.get(id);
      if (!r) return;
      if (event === "gate") drop(id);
      // Bugs cleared → QA re-runs EVERYTHING: only developer roles stay "done".
      else if (event === "retest") {
        r.rolesDone = r.rolesDone.filter((role) => config.roles[role]?.kind === "developer");
        r.verifiedHead = null; // the fixer changed code after the old verify → verify again before calling reviewers
      }
    },
    busy: () => inflight.size > 0,
    idle: () => (inflight.size === 0 ? Promise.resolve() : Promise.race([...inflight])),
    settled: async () => { while (inflight.size > 0) await Promise.all([...inflight]); },
  };
}

/**
 * Execute `actions` via `io` and wait for every background job to finish. For running a single batch of actions
 * (tests, one-off tools); the conductor loop uses `createExecutor` to interleave `tick` between jobs.
 * @param {Action[]} actions @param {ExecIo} io
 * @param {{run?: ExecReport, maxRetries?: number, workers?: number}} [options]
 * @returns {Promise<ExecReport>}
 */
export async function execute(actions, io, options = {}) {
  const run = options.run ?? newExecReport();
  const ex = createExecutor(io, { ...options, run });
  ex.start(actions);
  await ex.settled();
  return run;
}

// ─── Real io ────────────────────────────────────────────────────────────────

/** @type {SpawnFn} */
export function realSpawn(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"], signal: opts.signal,
    });
    const CAP = 4_000_000;
    let stdout = "";
    let stderr = "";
    let done = false;
    /** @param {number} code */
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = opts.timeoutMs ? setTimeout(() => { stderr += `\n(over ${Math.round(/** @type {number} */ (opts.timeoutMs) / 60000)} min — killed)`; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d) => { stdout = (stdout + d).slice(-CAP); });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-CAP); });
    child.on("error", (err) => {
      stderr += `${err.message}\n`;
      finish(err.name === "AbortError" ? 143 : 127); // 127: command not found (e.g. `claude` not installed)
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/**
 * Read an agent's `tools` field from disk. @param {string} root @param {string} role @returns {string[]|undefined}
 */
export function readAgentTools(root, role) {
  try {
    return parseAgentTools(fs.readFileSync(path.join(root, ".claude", "agents", `${role}.md`), "utf8"));
  } catch {
    return undefined;
  }
}

/** Path of a code file next to this module (works from the plugin too). @param {string} name */
export const siblingPath = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), name);

/** `worker rm` deletes the env file too; read the worker env from disk, missing file → {}. @param {string} root @param {string} id */
export function readWorkerEnv(root, id) {
  try {
    return parseEnvFile(fs.readFileSync(envFilePath(root, id), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Move NEW bug files (`tasks/B-*.md`) from the worktree to the main tree. QA/reviewers file bugs inside the worktree,
 * but the conductor reads bugs from the main tree; left in place, `tick` would never see them.
 * @param {string} root @param {string} cwd @returns {string[]} ids of the moved files
 */
export function moveNewBugs(root, cwd) {
  const from = path.join(cwd, "tasks");
  if (!fs.existsSync(from)) return [];
  /** @type {string[]} */
  const moved = [];
  for (const name of fs.readdirSync(from).filter((n) => /^B-.+\.md$/.test(n)).sort()) {
    const dst = path.join(root, "tasks", name);
    // NEW bugs only. Bugs already on the main tree are also in the branch (committed) — deleting them from the worktree would delete history.
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(from, name), dst);
    fs.rmSync(path.join(from, name));
    moved.push(name.replace(/\.md$/, ""));
  }
  return moved;
}

// Run directly for run-planner.sh: `node conductor-exec.mjs claude-args <role>` (one argument per line)
// · `node conductor-exec.mjs model <role>`. The planner's model and permissions come from the `roles` table, not hard-coded in shell.
if (process.argv[1] && process.argv[1].endsWith("conductor-exec.mjs")) {
  const [, , sub, role] = process.argv;
  const { projectRoot } = await import("./project-config.mjs");
  const root = projectRoot();
  if (!role || (sub !== "claude-args" && sub !== "model")) {
    process.stderr.write("Usage: conductor-exec.mjs claude-args <role> | model <role>\n");
    process.exit(2);
  }
  const rule = config.roles[role];
  if (!rule) {
    process.stderr.write(`Role "${role}" is not in the roles table\n`);
    process.exit(1);
  }
  if (sub === "model") process.stdout.write(`${modelFor(rule)}\n`);
  else {
    const mode = process.env.AGENT_QUEUE_SKIP_PERMISSIONS === "1" ? "skip" : "allowlist";
    if (childFull()) process.stderr.write(`WARNING: AGENT_QUEUE_CHILD_FULL=1 — ${role} runs without slimming flags (the budget cap stays).\n`);
    process.stdout.write(`${claudeArgs(role, { id: role }, { ...rule, tools: readAgentTools(root, role) }, mode).join("\n")}\n`);
  }
}
