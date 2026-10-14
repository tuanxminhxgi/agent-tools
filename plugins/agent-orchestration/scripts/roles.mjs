// @ts-check
/**
 * ROLE-BASED AGENTS + EVALUATOR → OPTIMIZER (A-012). Design: docs/agent-orchestration.md §5.
 *
 * A role is only called when `choosePattern` asks for it — there is no fixed chain for every task. The verdict
 * of an evaluating role (QA, security) goes through the VERIFIER via `report-ok.mjs` in `verify:` — no role
 * declares itself done, no role writes `status`.
 *
 * Pure functions: take the `choosePattern` result + task, return the role chain / prompt / next-round decision.
 * A-020 moved the role table (model, tools, write scope) into config; this is the base layer.
 */

import { config } from "./config.mjs";
import { COMPACT_MAX_CHARS, COMPACT_SECTIONS } from "./compact.mjs";
import { anyOverlap, matchAny } from "./glob.mjs";
import { inferLocks } from "./schedule.mjs";
import { rank } from "./backlog.mjs";

/** @typedef {import("./project-config.mjs").RoleRule} RoleRule */
/** @typedef {{role: string, model: string, kind: string, reason: string}} ChainStep */

/**
 * Roles governed by `choosePattern` (Evaluator overlay): they join the chain only when `choice.evaluate` names
 * them — so that `reassess`'s `skip-security` still has an effect. Other evaluating roles follow `when`.
 */
const PATTERN_EVALUATORS = Object.freeze(["qa", "security"]);

/** Evaluator/reviewer roles: read the task + diff, NOT the developer's reasoning log. */
const READ_ONLY_KINDS = Object.freeze(["evaluator", "reviewer"]);

/**
 * Does a role's `when` condition match the task — keys are OR-ed. PURE FUNCTION.
 * @param {RoleRule["when"]} when
 * @param {import("./backlog.mjs").Task} task
 * @param {{openBugs?: boolean}} ctx
 * @returns {string|null} reason for the match, or null
 */
export function matchWhen(when, task, ctx = {}) {
  const hitDomain = (when.domains ?? []).find((d) => task.domains.includes(d));
  if (hitDomain) return `domain ${hitDomain}`;
  if (when.riskAtLeast && rank(task.risk) >= rank(when.riskAtLeast)) return `risk ${task.risk} ≥ ${when.riskAtLeast}`;
  if ((when.touches ?? []).length > 0 && anyOverlap(task.touches, /** @type {string[]} */ (when.touches))) {
    return "touches match the role's scope";
  }
  const hitLock = (when.locks ?? []).find((l) => inferLocks(task).includes(l));
  if (hitLock) return `lock ${hitLock}`;
  if (when.openBugs && ctx.openBugs) return "task has open bugs";
  return null;
}

/** @typedef {{path: string, added: string[]}} DiffFile  one file of the diff and its added lines (without the `+`) */

/**
 * `when.diff` (A-090) — is this diff worth opening a session for the reviewer role. Evaluated right BEFORE the role is
 * called (not when the chain is built): `matchWhen` already put the role in the chain, this is an EXTRA condition. PURE FUNCTION.
 * Matches when ≥ 1 file matches `paths` AND (no `added` declared OR an added line of those files matches one regex).
 * `reason` only states the reason, it does NOT quote diff lines. A broken regex (config already rejects it; this is a second net) → treated as a match.
 * @param {import("./project-config.mjs").WhenDiff} whenDiff @param {DiffFile[]} files
 * @returns {{run: boolean, reason: string}}
 */
export function diffGate(whenDiff, files) {
  if (files.length === 0) return { run: false, reason: "empty diff" };
  const mine = files.filter((f) => matchAny(whenDiff.paths, f.path));
  if (mine.length === 0) return { run: false, reason: "diff touches none of the role's files" };
  const patterns = whenDiff.added ?? [];
  if (patterns.length === 0) return { run: true, reason: "diff touches the role's files" };
  /** @type {RegExp[]} */
  const regexes = [];
  for (const p of patterns) {
    try {
      regexes.push(new RegExp(p));
    } catch {
      return { run: true, reason: "the added condition has an invalid regex — review to be safe" };
    }
  }
  const hit = mine.some((f) => f.added.some((line) => regexes.some((re) => re.test(line))));
  return hit ? { run: true, reason: "diff has a matching added line" } : { run: false, reason: "diff has no matching added line" };
}

/**
 * Diff gate of ONE reviewer role: no `when.diff` declared → always runs. PURE FUNCTION.
 * @param {RoleRule|undefined} rule @param {DiffFile[]} files @returns {{run: boolean, reason: string}}
 */
export function reviewerGate(rule, files) {
  if (!rule || rule.kind !== "reviewer" || !rule.when.diff) return { run: true, reason: "" };
  return diffGate(rule.when.diff, files);
}

/** Strip quotes (and the `a/` `b/` prefix when `prefixed`) from a path in a diff. @param {string} raw @param {boolean} [prefixed] @returns {string} */
function diffPath(raw, prefixed = true) {
  let p = raw.replace(/\t.*$/, "").trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  return prefixed ? p.replace(/^[ab]\//, "") : p;
}

/**
 * `git diff -U0` → each file with its ADDED lines. PURE FUNCTION. Binary / renamed / mode-only / deleted files: listed
 * with an empty `added`. A renamed file's path is the NEW path.
 * @param {string} diffText @returns {DiffFile[]}
 */
export function parseDiffFiles(diffText) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile|null} */
  let cur = null;
  let inHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      // `a/P b/P` (paths may contain spaces): split exactly in the middle; if they differ (rename), `rename to` / `+++` decides.
      const mid = (rest.length - 1) / 2;
      const same = Number.isInteger(mid) && rest[mid] === " " && rest.slice(0, mid).replace(/^"?a\//, "") === rest.slice(mid + 1).replace(/^"?b\//, "");
      const m = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest);
      cur = { path: same ? diffPath(rest.slice(mid + 1)) : m ? m[2] : diffPath(rest), added: [] };
      files.push(cur);
      inHunk = false;
    } else if (cur === null) {
      continue;
    } else if (!inHunk && line.startsWith("rename to ")) {
      cur.path = diffPath(line.slice("rename to ".length), false);
    } else if (!inHunk && line.startsWith("--- ")) {
      if (line !== "--- /dev/null") cur.path = diffPath(line.slice(4));
    } else if (!inHunk && line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") cur.path = diffPath(line.slice(4));
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      cur.added.push(line.slice(1));
    }
  }
  return files;
}

/**
 * A role's model at round `round` (A-026): the largest `modelByRound` step with `from ≤ round` wins;
 * no step matches → the role's `model`. A role without `modelByRound` → same model every round.
 * PURE FUNCTION — role/model names live in config, not in code.
 * @param {RoleRule} rule @param {number} [round] @returns {string}
 */
export function modelFor(rule, round = 1) {
  const hit = (rule.modelByRound ?? [])
    .filter((m) => m.from <= round)
    .sort((a, b) => b.from - a.from)[0];
  return hit ? hit.model : rule.model;
}

/**
 * Role chain for a task — EVALUATES the config's `roles` table (A-020), no hard-coded role names.
 * Order: developer → evaluator → reviewer (by name) → fixer. `planner` never joins a task's
 * chain. PURE FUNCTION, deterministic.
 *
 * - developer: roles whose own `when` matches (e.g. domain); none matches → the role with `when.always`.
 * - `qa`/`security`: only when `choice.evaluate` names them (respects `choosePattern` + `reassess`).
 * - other evaluators/reviewers: by `when`. fixer: only when `ctx.openBugs`.
 *
 * @param {import("./pattern.mjs").PatternChoice} choice
 * @param {import("./backlog.mjs").Task} task
 * @param {Record<string, RoleRule>} [roles]
 * @param {{openBugs?: boolean, round?: number}} [ctx]  `round`: the BUG's fixer round (≥ 1, A-026)
 * @returns {ChainStep[]}
 */
export function roleChain(choice, task, roles = config.roles, ctx = {}) {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b));
  /** @param {string} role @param {RoleRule} r @param {string} reason @returns {ChainStep} */
  const step = (role, r, reason) => ({ role, model: modelFor(r, ctx.round ?? 1), kind: r.kind, reason });

  const devs = entries.filter(([, r]) => r.kind === "developer");
  /** @type {ChainStep[]} */
  let chain = devs
    .map(([name, r]) => [name, r, matchWhen({ ...r.when, always: undefined }, task, ctx)])
    .filter(([, , why]) => why !== null)
    .map(([name, r, why]) => step(/** @type {string} */ (name), /** @type {RoleRule} */ (r), /** @type {string} */ (why)));
  if (chain.length === 0) {
    const fallback = devs.find(([, r]) => r.when.always);
    if (fallback) chain = [step(fallback[0], fallback[1], "no specific developer role matched — generic role")];
  }

  for (const kind of ["evaluator", "reviewer"]) {
    for (const [name, r] of entries.filter(([, x]) => x.kind === kind)) {
      if (PATTERN_EVALUATORS.includes(name)) {
        if (choice.evaluate.includes(/** @type {"qa"|"security"} */ (name))) {
          chain.push(step(name, r, `choosePattern: risk ${task.risk} → +${name}`));
        }
        continue;
      }
      const why = matchWhen(r.when, task, ctx);
      if (why) chain.push(step(name, r, why));
    }
  }
  for (const [name, r] of entries.filter(([, x]) => x.kind === "fixer")) {
    const why = matchWhen(r.when, task, ctx);
    if (why) chain.push(step(name, r, why));
  }
  return chain;
}

/** A group's context pack (A-051) lives at `<tasksDir>/_context/<group>.md`. */
export const CONTEXT_DIR = "_context";
/** Pack length limit — beyond it `doctor` goes red and the prompt only gets the head. */
export const MAX_CONTEXT_PACK_CHARS = 20_000;

/**
 * Path of the task's context pack, relative to the repo root; task without `context:` → null. PURE FUNCTION.
 * @param {import("./backlog.mjs").Task} task @param {string} [tasksDir]
 * @returns {string|null}
 */
export function contextPackFile(task, tasksDir = config.tasksDir) {
  return task.context ? `${tasksDir}/${CONTEXT_DIR}/${task.context}.md` : null;
}

/**
 * Prompt for a role. There is NO transcript parameter — no way for a previous session's history
 * to leak in. The developer reads the handoff log; evaluating roles do NOT (a checker should not be
 * persuaded in advance by the implementer's reasoning).
 *
 * @param {string} role
 * @param {import("./backlog.mjs").Task} task
 * @param {string} diff       diff of the task branch against its fork point
 * @param {string} handoff    the current `## <headings.handoff>` section
 * @param {string|null} [pack] content of the group's context pack (A-051) — only the developer gets it; evaluating
 *                             roles do NOT (a checker reads the code itself, not the planner's summary)
 * @returns {string}
 */
export function rolePrompt(role, task, diff, handoff, pack = null) {
  const kind = config.roles[role]?.kind ?? "developer";
  const evaluator = READ_ONLY_KINDS.includes(kind);
  const body = evaluator ? stripHandoff(task.body) : task.body;
  const lines = [
    `You are **${role}** for task ${task.id}: ${task.title}.`,
    `Read .claude/agents/${role}.md and follow its rules exactly. Repo conventions: AGENTS.md.`,
  ];
  const packText = pack?.trim() ?? "";
  if (!evaluator && task.context && packText !== "") {
    const cut = packText.length > MAX_CONTEXT_PACK_CHARS;
    lines.push(
      "",
      `## Shared context of group \`${task.context}\` (${contextPackFile(task)})`,
      "The planner explored this code area once for the whole group. Treat what follows as KNOWN: don't reopen files just",
      "to find it; only read a file when you need to change it or need detail the pack lacks. The pack was written at",
      "planning time — earlier tasks in the group may have changed the code: the handoff log and diff below win over it.",
      "",
      cut ? `${packText.slice(0, MAX_CONTEXT_PACK_CHARS)}\n\n(… pack truncated at ${MAX_CONTEXT_PACK_CHARS} characters)` : packText,
    );
  }
  lines.push(
    "",
    `## Task (${task.file})`,
    body.trim(),
  );
  if (!evaluator && handoff.trim() !== "") lines.push("", `## ${config.headings.handoff} from previous roles`, handoff.trim());
  lines.push("", "## Current diff", diff.trim() === "" ? "(no changes yet)" : "```diff\n" + diff.trim() + "\n```");
  if (kind === "reviewer") {
    // Reviewers do NOT write files: the conductor extracts the last JSON block of the output → reports/ → INBOX (A-021).
    lines.push(
      "",
      "You are READ-ONLY — do not edit or write any file. End with ONE final ```json block:",
      `{"role": "${role}", "task": "${task.id}", "ok": boolean, "checked": string[],`,
      ' "findings": [{"severity": "critical|high|medium|low", "rule": string, "file": string, "line": number, "detail": string}]}',
      "`ok: true` ONLY when `findings` is empty. `detail` keeps the evidence verbatim, no summarising.",
      "Findings go to tasks/INBOX.md for a human to review — they do NOT block merging.",
      "",
      `Do NOT write \`## ${config.headings.handoff}\` and do not edit the task file.`,
      "Do NOT ask questions or for permission — nobody answers inside `claude -p`; just review and conclude.",
      "The FINAL message must contain the ```json block, even with no findings (`\"ok\": true, \"findings\": []`). "
        + "Without it the whole review is treated as failed.",
    );
    return lines.join("\n");
  } else if (evaluator) {
    const suffix = reportSuffix(role);
    lines.push(
      "",
      `Write your verdict to \`reports/${task.id}.${suffix}.json\`: {"ok": boolean, "checked": string[], "bugs": string[]}.`,
      "`ok: true` ONLY when `bugs` is empty. File a bug per tasks/_templates/bug.md for any reproducible defect.",
    );
  }
  lines.push(
    "",
    `When done, write 3–5 lines under \`## ${config.headings.handoff}\` in the task file: what you did · what you decided and why · what is left.`,
    "Do NOT edit the `status` field — the verifier decides.",
  );
  return lines.join("\n");
}

/**
 * Prompt for the COMPACT turn at a task boundary (A-055): resumes the previous task's developer session (cache still
 * warm, so cheap) and asks for ONLY a summary in the seven-section template — the conductor writes it to a file and
 * hands it to the next task's fresh session.
 * @param {string} fromTaskId task of the session being summarised @param {import("./backlog.mjs").Task} next next task
 * @returns {string}
 */
export function compactPrompt(fromTaskId, next) {
  return [
    `This session is about to close because it has grown too large. The next task is ${next.id}: ${next.title} — it will run in a NEW session`,
    `that only receives the summary you write now about your work on ${fromTaskId}.`,
    "",
    "Do NOT use any tool, do NOT edit files. Reply with ONLY the summary, using exactly these seven level-2 headings in order:",
    ...COMPACT_SECTIONS.map((s) => `## ${s}`),
    "",
    `At most ${COMPACT_MAX_CHARS} characters. Only what helps the next task: files with lines, function/endpoint signatures, decisions and rationale,`,
    "open errors verbatim. Do NOT copy i18n display strings or quote migration SQL; no secrets, no `.env` values.",
  ].join("\n");
}

/**
 * Prompt for the developer when RESUMING the previous developer session into the next task (A-052). The session has
 * already loaded the role rules, AGENTS.md and the previous task's code area — no re-reading; only the new task +
 * handoff log + diff (+ group pack, if any) are sent.
 * @param {string} role @param {import("./backlog.mjs").Task} task @param {string} diff @param {string} handoff
 * @param {string|null} pack @param {string} fromTaskId task of the previous session
 * @returns {string}
 */
export function continuePrompt(role, task, diff, handoff, pack, fromTaskId) {
  const packText = pack?.trim() ?? "";
  const lines = [
    `Continue in this SAME session (${fromTaskId === task.id ? `next role of task ${task.id}` : `after ${fromTaskId}`}): you are now **${role}** for task ${task.id}: ${task.title}.`,
    "The role rules, AGENTS.md and code you already read in this session still apply — do NOT re-read them just to recall.",
    `If your role differs from the previous one in this session, read \`.claude/agents/${role}.md\`.`,
  ];
  if (fromTaskId !== task.id) lines.push(`${fromTaskId} is done and verify is green — don't keep changing it unless this task requires it.`);
  if (task.context && packText !== "") {
    lines.push("", `## Shared context of group \`${task.context}\` (${contextPackFile(task)})`,
      packText.length > MAX_CONTEXT_PACK_CHARS ? `${packText.slice(0, MAX_CONTEXT_PACK_CHARS)}\n\n(… pack truncated at ${MAX_CONTEXT_PACK_CHARS} characters)` : packText);
  }
  lines.push("", `## Task (${task.file})`, task.body.trim());
  if (handoff.trim() !== "") lines.push("", `## ${config.headings.handoff} from previous roles`, handoff.trim());
  lines.push(
    "", "## Current diff", diff.trim() === "" ? "(no changes yet)" : "```diff\n" + diff.trim() + "\n```",
    "", `When done, write 3–5 lines under \`## ${config.headings.handoff}\` in the task file: what you did · what you decided and why · what is left.`,
    "Do NOT edit the `status` field — the verifier decides.",
  );
  return lines.join("\n");
}

/** Remove the `## <headings.handoff>` section from the task body (for evaluating roles). @param {string} body */
function stripHandoff(body) {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim() === `## ${config.headings.handoff}`);
  if (at === -1) return body;
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((l) => /^##\s/.test(l));
  return [...lines.slice(0, at), ...(next === -1 ? [] : rest.slice(next))].join("\n");
}

/**
 * After an evaluation pass: proceed, return to the developer, or stop for a human. Return rounds ≤ `maxRounds`.
 * PURE FUNCTION.
 * @param {{role: "qa"|"security", ok: boolean, bugs: string[]}[]} reports
 * @param {number} round       return rounds used so far (0 = never returned)
 * @param {number} [maxRounds]
 * @returns {{action: "pass"} | {action: "return", round: number, findings: string[]} | {action: "needs-human", reason: string}}
 */
export function afterEvaluation(reports, round, maxRounds = 2) {
  const findings = reports.filter((r) => !r.ok).flatMap((r) => r.bugs.map((b) => `[${r.role}] ${b}`));
  if (findings.length === 0) return { action: "pass" };
  if (round >= maxRounds) {
    return { action: "needs-human", reason: `returned to the developer ${round} times and evaluators are still red — needs a human` };
  }
  return { action: "return", round: round + 1, findings };
}

/** Report file suffix: `security` → `sec` (as in `report-ok … sec`), other roles keep their name. @param {string} role */
export function reportSuffix(role) {
  return role === "security" ? "sec" : role;
}
