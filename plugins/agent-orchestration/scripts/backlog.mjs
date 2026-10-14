// @ts-check
/**
 * LAYER 1 — read task state from disk. READ-ONLY, pure, runs no commands.
 *
 * The source of truth is the front-matter of each `tasks/<ID>-<slug>.md` file.
 * `- [ ]` boxes in the body are human notes, NOT state.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter, FrontMatterError } from "./yaml.mjs";
import { matchAny } from "./glob.mjs";
import { rootRegExp } from "./project-config.mjs";
import {
  config, STATUSES, GATES, COMPLEXITIES, RISKS, PATTERNS,
  BUG_STATUSES, SEVERITIES, BUG_FINDERS, QUESTION_STATUSES,
} from "./config.mjs";

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string[]} deps
 * @property {string} gate
 * @property {string[]} verify
 * @property {string[]} manual
 * @property {string|null} owner
 * @property {string|null} updated
 * @property {string} file      relative path
 * @property {string} body      markdown body
 * @property {string[]} scope   paths in the body's `File:` line
 *
 * Orchestration analysis (docs/agent-orchestration.md §1). Older files that don't
 * declare these get defaults — finished tasks need not be edited.
 * @property {string} complexity       S | M | L | XL — default M
 * @property {string[]} domains        default: inferred from scope
 * @property {string} risk             EFFECTIVE = max(declared, inferred)
 * @property {string|null} riskDeclared  declared value, null if not declared
 * @property {string[]} touches        default = `scope`
 * @property {string[]} locks
 * @property {string[]} blockedOn      unanswered Q-xxx
 * @property {string[]} reviseFor      Q-xxx JUST answered — the planner must rewrite the task per
 *                                     the answer and remove the marker; until then it cannot go to todo (A-027)
 * @property {string} pattern          auto | single | pipeline | router | planner-executor | hierarchical
 * @property {string[]} steps          Workflow pipeline only
 * @property {string|null} context     context group (A-051): the developer gets `tasks/_context/<group>.md`
 *                                     in its prompt instead of re-exploring the code; null = no group
 */

const REQUIRED = ["id", "title", "status", "deps", "gate", "verify", "manual"];

/** Context group name = file name `tasks/_context/<group>.md` — no `/` or `..` to escape the directory. */
export const CONTEXT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** @param {unknown} v @returns {string[]} */
function asStringArray(v) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) return [String(v)];
  return v.map((x) => String(x));
}

/**
 * @param {string} file
 * @param {string} content
 * @returns {Task}
 */
export function parseTask(file, content) {
  const { data, body } = parseFrontMatter(content, file);

  for (const key of REQUIRED) {
    if (!(key in data)) {
      throw new FrontMatterError(`missing required field \`${key}\``, file, 1);
    }
  }
  const status = String(data.status);
  if (!STATUSES.includes(/** @type {never} */ (status))) {
    throw new FrontMatterError(`invalid status: ${status}`, file, 1);
  }
  const gate = String(data.gate);
  if (!GATES.includes(/** @type {never} */ (gate))) {
    throw new FrontMatterError(`invalid gate: ${gate}`, file, 1);
  }

  const scopeLine = body.split("\n").find((l) => l.startsWith("File:")) ?? "";
  const scope = [...scopeLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  const complexity = data.complexity == null ? "M" : String(data.complexity);
  if (!COMPLEXITIES.includes(/** @type {never} */ (complexity))) {
    throw new FrontMatterError(`invalid complexity: ${complexity}`, file, 1);
  }
  const riskDeclared = data.risk == null ? null : String(data.risk);
  if (riskDeclared !== null && !RISKS.includes(/** @type {never} */ (riskDeclared))) {
    throw new FrontMatterError(`invalid risk: ${riskDeclared}`, file, 1);
  }
  const pattern = data.pattern == null ? "auto" : String(data.pattern);
  if (!PATTERNS.includes(/** @type {never} */ (pattern))) {
    throw new FrontMatterError(`invalid pattern: ${pattern}`, file, 1);
  }

  const context = data.context == null || String(data.context).trim() === "" ? null : String(data.context).trim();
  if (context !== null && !CONTEXT_NAME.test(context)) {
    throw new FrontMatterError(`context must be kebab-case (a-z, 0-9, "-"): ${context}`, file, 1);
  }

  const title = String(data.title);
  const verify = asStringArray(data.verify);
  const declaredTouches = asStringArray(data.touches);
  // `touches: []` in the template is a blank to fill in, not "touches nothing".
  const touches = declaredTouches.length > 0 ? declaredTouches : scope;
  const declaredDomains = asStringArray(data.domains);
  const inferred = inferRisk({ gate, title, touches });

  return {
    id: String(data.id),
    title,
    status,
    deps: asStringArray(data.deps),
    gate,
    verify,
    manual: asStringArray(data.manual),
    owner: data.owner === null || data.owner === undefined ? null : String(data.owner),
    updated: data.updated === null || data.updated === undefined ? null : String(data.updated),
    file,
    body,
    scope,
    complexity,
    domains: declaredDomains.length > 0 ? declaredDomains : domainsFor({ scope: touches, verify }),
    risk: riskDeclared !== null && rank(riskDeclared) > rank(inferred) ? riskDeclared : inferred,
    riskDeclared,
    touches,
    locks: asStringArray(data.locks),
    blockedOn: asStringArray(data["blocked-on"]),
    reviseFor: asStringArray(data["revise-for"]),
    pattern,
    steps: asStringArray(data.steps),
    context,
  };
}

/** @param {string} risk @returns {number} */
export function rank(risk) {
  return RISKS.indexOf(/** @type {never} */ (risk));
}

/**
 * Risk INFERRED from measurable facts, not from what is declared. PURE FUNCTION.
 *
 * Does not use `evaluateGate()`: that can be switched off with `AGENT_QUEUE_GATES=off`,
 * whereas the risk of a change does not depend on an environment variable.
 *
 * @param {{gate: string, title: string, touches: string[]}} t
 * @returns {"low"|"medium"|"high"}
 */
export function inferRisk({ gate, title, touches }) {
  // `money`/`migration` are real risk. `manual` only says "a human must look" — it
  // makes the change neither safer nor riskier, so it does not pull in security.
  if (gate === "money" || gate === "migration") return "high";
  const paths = touches.join("\n");
  if (config.migrationPaths.some((p) => paths.includes(p))) return "high";
  const haystack = `${paths} ${title}`.toLowerCase();
  if (config.moneyKeywords.some((k) => haystack.includes(k.trim().toLowerCase()))) return "high";
  // Auth · routes · uploads · permissions: a mistake here leaks data, not just breaks a feature.
  // The pattern lists live in the project config (`risk.highPatterns`, `risk.mediumPatterns`).
  if (config.highRiskPatterns.some((re) => new RegExp(re, "i").test(paths))) return "high";
  if (config.mediumRiskPatterns.some((re) => new RegExp(re, "i").test(paths))) return "medium";
  return "low";
}

/**
 * Domains inferred from scope — used when a task doesn't declare `domains`. PURE FUNCTION.
 * @param {{scope: string[], verify: string[]}} t
 * @returns {string[]}
 */
export function domainsFor(t) {
  const skills = skillsFor(/** @type {Task} */ (/** @type {unknown} */ (t)));
  /** @type {string[]} */
  const out = config.skills.filter((r) => skills.includes(r.skill)).map((r) => r.domain);
  for (const { domain, globs } of config.domains) {
    if (!out.includes(domain) && t.scope.some((p) => matchAny(globs, p))) out.push(domain);
  }
  return out;
}

/**
 * @param {string} [tasksDir]
 * @returns {Map<string, Task>}
 */
export function loadBacklog(tasksDir = config.tasksDir) {
  /** @type {Map<string, Task>} */
  const backlog = new Map();
  const files = fs
    .readdirSync(tasksDir)
    .filter((/** @type {string} */ f) => /^[A-Z]-\d{3}-.*\.md$/.test(f))
    .sort();

  for (const name of files) {
    const file = path.join(tasksDir, name);
    const task = parseTask(file, fs.readFileSync(file, "utf8"));
    if (backlog.has(task.id)) {
      throw new Error(`Duplicate id ${task.id}: ${backlog.get(task.id)?.file} and ${file}`);
    }
    backlog.set(task.id, task);
  }
  return backlog;
}

/**
 * `blocked` is INFERRED, not stored: a task with a dependency not yet `done` cannot be picked.
 * @param {Task} task @param {Map<string, Task>} backlog
 */
export function isBlocked(task, backlog) {
  return task.deps.some((id) => backlog.get(id)?.status !== "done");
}

/** @param {Task} task @param {Map<string, Task>} backlog @returns {string[]} */
export function missingDeps(task, backlog) {
  return task.deps.filter((id) => backlog.get(id)?.status !== "done");
}

/**
 * Critical path declared in INDEX.md — used for prioritising, optional.
 * @param {string} [indexFile]
 * @returns {string[]}
 */
export function criticalPath(indexFile = config.indexFile) {
  if (!fs.existsSync(indexFile)) return [];
  /** @type {string[]} */
  const ids = [];
  for (const line of fs.readFileSync(indexFile, "utf8").split("\n")) {
    if (!line.toLowerCase().includes(config.headings.criticalPath.toLowerCase())) continue;
    for (const m of line.matchAll(/\b([A-Z]-\d{3})\b/g)) ids.push(m[1]);
  }
  return ids;
}

/**
 * Next task. DETERMINISTIC order — two runs give the same result:
 *   1. on the critical path
 *   2. blocks more other tasks (counting DIRECT dependants)
 *   3. smaller id
 * @param {Map<string, Task>} backlog
 * @param {string[]} [critical]
 * @returns {Task|null}
 */
export function nextTask(backlog, critical = []) {
  const ready = readyTasks(backlog);
  return ready.length > 0 ? ready[0] : null;

  /** @param {Map<string, Task>} bl */
  function readyTasks(bl) {
    /** @type {Map<string, number>} */
    const blocks = new Map();
    for (const task of bl.values()) {
      for (const dep of task.deps) blocks.set(dep, (blocks.get(dep) ?? 0) + 1);
    }
    return [...bl.values()]
      .filter((t) => t.status === "todo" && !isBlocked(t, bl))
      .sort((a, b) => {
        const ca = critical.indexOf(a.id);
        const cb = critical.indexOf(b.id);
        const oa = ca === -1 ? Number.MAX_SAFE_INTEGER : ca;
        const ob = cb === -1 ? Number.MAX_SAFE_INTEGER : cb;
        if (oa !== ob) return oa - ob;
        const ba = blocks.get(a.id) ?? 0;
        const bb = blocks.get(b.id) ?? 0;
        if (ba !== bb) return bb - ba;
        return a.id.localeCompare(b.id);
      });
  }
}

/**
 * Copy of the backlog with one task treated as `done`.
 *
 * Needed because the next task must be computed on the state AFTER the current one
 * finishes: computed before, every task depending on it is still blocked and the
 * loop thinks there is no work left. (A real bug, hit on the very first chained run.)
 *
 * @param {Map<string, Task>} backlog @param {string} id @returns {Map<string, Task>}
 */
export function projectDone(backlog, id) {
  const copy = new Map(backlog);
  const task = copy.get(id);
  if (task) copy.set(id, { ...task, status: "done" });
  return copy;
}

/** @param {Map<string, Task>} backlog @returns {Task[]} */
export function readyQueue(backlog, /** @type {string[]} */ critical = []) {
  /** @type {Task[]} */
  const out = [];
  const copy = new Map(backlog);
  // Calling `nextTask` repeatedly returns the same task; build the sorted list instead of looping.
  const blocks = new Map();
  for (const task of copy.values()) {
    for (const dep of task.deps) blocks.set(dep, (blocks.get(dep) ?? 0) + 1);
  }
  for (const task of copy.values()) {
    if (task.status === "todo" && !isBlocked(task, copy)) out.push(task);
  }
  return out.sort((a, b) => {
    const oa = critical.indexOf(a.id) === -1 ? Number.MAX_SAFE_INTEGER : critical.indexOf(a.id);
    const ob = critical.indexOf(b.id) === -1 ? Number.MAX_SAFE_INTEGER : critical.indexOf(b.id);
    if (oa !== ob) return oa - ob;
    const ba = blocks.get(a.id) ?? 0;
    const bb = blocks.get(b.id) ?? 0;
    if (ba !== bb) return bb - ba;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Which skills apply to a task, inferred from its scope. PURE FUNCTION.
 *
 * Signal sources in order of trust: the body's `File:` line (`task.scope`,
 * declared by the task author) then the commands in `verify:`. Both say which
 * part of the code tree the task touches.
 *
 * The skill table lives in the project config (`skills`) and is SHARED with the hook
 * `.claude/hooks/skill-reminder.mjs`: the hook fires when **editing each file** (by `globs`),
 * this function fires when **assigning a task** (by `globs` or `roots`). One source, no twins.
 *
 * @param {Task} task
 * @returns {string[]} skill names, deduplicated, deterministic order
 */
export function skillsFor(task) {
  const items = [...task.scope, ...task.verify]
    // Drop lines that only BORROW a tool from an app's `node_modules` without
    // touching that app's code — e.g. A-001 runs `packages/api/node_modules/.bin/tsc`
    // to check code in `scripts/`. Without this filter every tooling task would be
    // wrongly assigned that app's skill.
    .filter((s) => !s.includes("node_modules"));
  // `roots` match as a path segment anywhere in the line: `verify` reads like
  // `cd packages/api && npm test …`, while the `File:` line reads like `packages/api/src/…`.
  return config.skills
    .filter((r) => items.some((i) => matchAny(r.globs, i) || r.roots.some((root) => rootRegExp(root).test(i))))
    .map((r) => r.skill);
}

// ─── Bugs · docs/agent-orchestration.md §6 ──────────────────────────────────

/** Required sections in a bug body — if any is missing the conductor won't assign it. */
export const BUG_SECTIONS = /** @type {readonly string[]} */ (config.headings.bugSections);

/** `B-T046-1-double-charge.md` — doesn't match the task file name pattern, so it never mixes into the backlog. */
const BUG_FILE = /^B-[A-Z]\d{3}-\d+-.*\.md$/;

/**
 * @typedef {Object} Bug
 * @property {string} id
 * @property {string} parent     parent task id
 * @property {string} title
 * @property {string} severity   critical | high | medium | low
 * @property {string} status     open | fixing | fixed | needs-human
 * @property {string} foundBy    qa | security | integrator
 * @property {string[]} verify   commands running the reproduction test
 * @property {string[]} touches
 * @property {number} rounds     fixer rounds tried so far (A-013) — capped at 2
 * @property {string|null} owner
 * @property {string|null} updated
 * @property {string} file
 * @property {string} body
 */

/**
 * @param {string} file @param {string} content @returns {Bug}
 */
export function parseBug(file, content) {
  const { data, body } = parseFrontMatter(content, file);
  for (const key of ["id", "parent", "title", "severity", "status", "found_by", "verify"]) {
    if (!(key in data)) throw new FrontMatterError(`missing required field \`${key}\``, file, 1);
  }
  /** @type {[string, readonly string[]][]} */
  const enums = [
    ["severity", SEVERITIES], ["status", BUG_STATUSES], ["found_by", BUG_FINDERS],
  ];
  for (const [key, allowed] of enums) {
    if (!allowed.includes(String(data[key]))) {
      throw new FrontMatterError(`invalid ${key}: ${String(data[key])}`, file, 1);
    }
  }
  return {
    id: String(data.id),
    parent: String(data.parent),
    title: String(data.title),
    severity: String(data.severity),
    status: String(data.status),
    foundBy: String(data.found_by),
    verify: asStringArray(data.verify),
    touches: asStringArray(data.touches),
    rounds: typeof data.rounds === "number" ? data.rounds : 0,
    owner: data.owner == null ? null : String(data.owner),
    updated: data.updated == null ? null : String(data.updated),
    file,
    body,
  };
}

/**
 * A directory with no bugs yet is normal — returns an empty Map.
 * @param {string} [tasksDir] @returns {Map<string, Bug>}
 */
export function loadBugs(tasksDir = config.tasksDir) {
  /** @type {Map<string, Bug>} */
  const bugs = new Map();
  if (!fs.existsSync(tasksDir)) return bugs;
  for (const name of fs.readdirSync(tasksDir).filter((f) => BUG_FILE.test(f)).sort()) {
    const file = path.join(tasksDir, name);
    const bug = parseBug(file, fs.readFileSync(file, "utf8"));
    if (bugs.has(bug.id)) throw new Error(`Duplicate id ${bug.id}: ${bugs.get(bug.id)?.file} and ${file}`);
    bugs.set(bug.id, bug);
  }
  return bugs;
}

// ─── Planner questions · §4 ─────────────────────────────────────────────────

/**
 * Questions live in `tasks/questions/Q-xxx-<slug>.md`, NOT in the INBOX:
 * the INBOX is regenerated every round, so it is a view, not the source of truth.
 * A human answers in the INBOX → the planner harvests the answer (`parseAnswers`) back here.
 *
 * @typedef {Object} Question
 * @property {string} id
 * @property {string} title
 * @property {string} status     open | answered | closed
 * @property {string[]} blocks   tasks waiting on this question
 * @property {string|null} updated
 * @property {string} answer     content of the answer section (`config.headings.answer`), "" if none yet
 * @property {string} file
 * @property {string} body
 */

/** @param {string} file @param {string} content @returns {Question} */
export function parseQuestion(file, content) {
  const { data, body } = parseFrontMatter(content, file);
  for (const key of ["id", "title", "status"]) {
    if (!(key in data)) throw new FrontMatterError(`missing required field \`${key}\``, file, 1);
  }
  const status = String(data.status);
  if (!QUESTION_STATUSES.includes(/** @type {never} */ (status))) {
    throw new FrontMatterError(`invalid status: ${status}`, file, 1);
  }
  return {
    id: String(data.id),
    title: String(data.title),
    status,
    blocks: asStringArray(data.blocks),
    updated: data.updated == null ? null : String(data.updated),
    answer: section(body, config.headings.answer),
    file,
    body,
  };
}

/** @param {string} [tasksDir] @returns {Map<string, Question>} */
export function loadQuestions(tasksDir = config.tasksDir) {
  const dir = path.join(tasksDir, "questions");
  /** @type {Map<string, Question>} */
  const questions = new Map();
  if (!fs.existsSync(dir)) return questions;
  for (const name of fs.readdirSync(dir).filter((f) => /^Q-\d{3}-.*\.md$/.test(f)).sort()) {
    const file = path.join(dir, name);
    const q = parseQuestion(file, fs.readFileSync(file, "utf8"));
    if (questions.has(q.id)) throw new Error(`Duplicate id ${q.id}: ${questions.get(q.id)?.file} and ${file}`);
    questions.set(q.id, q);
  }
  return questions;
}

/**
 * Content of a `## <name>` section up to the next `## ` heading, with HTML comments
 * and surrounding whitespace removed. No section → `null`; empty section → "".
 * @param {string} body @param {string} heading @returns {string}
 */
export function section(body, heading) {
  return sectionOrNull(body, heading) ?? "";
}

/** @param {string} body @param {string} heading @returns {string|null} */
export function sectionOrNull(body, heading) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end))
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}
