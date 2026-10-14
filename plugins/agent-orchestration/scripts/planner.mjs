// @ts-check
/**
 * PLANNER — splits requirements into tasks, asks questions WITHOUT stopping.
 * Design: docs/agent-orchestration.md §4.
 *
 * Writing tasks is the LLM's job (subagent `.claude/agents/planner.md`). This file is
 * the MACHINE around it:
 *   - picks the planner's next work (unsplit requirements, then drafts needing revision);
 *   - harvests answers typed in the INBOX into the question files, clears `blocked-on`;
 *   - decides which drafts have enough context to go to `todo` — the planner does NOT judge itself;
 *   - write-permission fence: the planner only touches `draft`/`needs-decision` tasks and only emits
 *     `ready`/`ask`/`answered`.
 *
 * The upper part is pure functions (table-tested); `syncPlanner` at the end is the file-writing layer.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBacklog, loadQuestions } from "./backlog.mjs";
import { parseFrontMatter, patchFrontMatter } from "./yaml.mjs";
import { analysisGaps } from "./doctor.mjs";
import { applyEvent } from "./store.mjs";
import { parseAnswers, writeInbox } from "./inbox.mjs";
import { config } from "./config.mjs";

/** The planner may only touch tasks in these states. From `todo` on they belong to the worker and verifier. */
export const PLANNER_STATUSES = Object.freeze(["draft", "needs-decision"]);
export const PLANNER_EVENTS = Object.freeze(["ready", "ask", "answered"]);

export class PlannerPermissionError extends Error {
  /** @param {string} id @param {string} what */
  constructor(id, what) {
    super(`Planner may not ${what} (${id}) — only draft/needs-decision tasks, events ready/ask/answered`);
    this.name = "PlannerPermissionError";
  }
}

/**
 * @param {import("./backlog.mjs").Task} task @param {string} [event]
 * @throws {PlannerPermissionError}
 */
export function assertPlannerMay(task, event) {
  if (!PLANNER_STATUSES.includes(task.status)) {
    throw new PlannerPermissionError(task.id, `edit a task in ${task.status}`);
  }
  if (event !== undefined && !PLANNER_EVENTS.includes(event)) {
    throw new PlannerPermissionError(task.id, `emit event ${event}`);
  }
}

// ─── Enough context ─────────────────────────────────────────────────────────

/**
 * Is a draft ready for a worker to take? The MACHINE decides, not the planner.
 * @param {import("./backlog.mjs").Task} task
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @returns {{ok: boolean, missing: string[]}}
 */
export function isReady(task, backlog) {
  /** @type {string[]} */
  const missing = [];
  if (task.status !== "draft") missing.push(`is ${task.status}, only draft tasks are checked`);
  if (task.verify.length === 0) missing.push("verify is empty");
  if (task.touches.length === 0) missing.push("touches is empty (and no File: line)");
  if (task.blockedOn.length > 0) missing.push(`still waiting on ${task.blockedOn.join(", ")}`);
  // A complete structure does NOT mean the content follows the answer just given (A-027).
  if (task.reviseFor.length > 0) missing.push(`awaiting rewrite per answer to ${task.reviseFor.join(", ")}`);
  const ghost = task.deps.filter((d) => !backlog.has(d));
  if (ghost.length > 0) missing.push(`nonexistent dependency: ${ghost.join(", ")}`);
  const gaps = analysisGaps(task.body);
  if (gaps === null) missing.push(`missing section ${config.headings.analysis}`);
  else if (gaps.length > 0) missing.push(`${config.headings.analysis} has blank answers to question ${gaps.join(", ")}`);
  return { ok: missing.length === 0, missing };
}

/**
 * Event the planner must emit for each draft: waiting on a question → `ask`,
 * enough context → `ready`, otherwise leave as is (the planner must keep writing).
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @returns {{id: string, event: "ready"|"ask"}[]}
 */
export function draftTransitions(backlog) {
  /** @type {{id: string, event: "ready"|"ask"}[]} */
  const out = [];
  for (const task of [...backlog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.status !== "draft") continue;
    if (task.blockedOn.length > 0) out.push({ id: task.id, event: "ask" });
    else if (isReady(task, backlog).ok) out.push({ id: task.id, event: "ready" });
  }
  return out;
}

// ─── Picking the next work ──────────────────────────────────────────────────

/**
 * @typedef {Object} Requirement
 * @property {string} file
 * @property {string} title
 * @property {"high"|"normal"|"low"} priority
 * @property {boolean} planned
 * @property {string[]} tasks
 */

const PRIORITY = ["high", "normal", "low"];

/** @param {string} file @param {string} content @returns {Requirement} */
export function parseRequirement(file, content) {
  const { data } = parseFrontMatter(content, file);
  const priority = data.priority == null ? "normal" : String(data.priority);
  if (!PRIORITY.includes(priority)) throw new Error(`${file}: invalid priority: ${priority}`);
  return {
    file,
    title: data.title == null ? path.basename(file, ".md") : String(data.title),
    priority: /** @type {Requirement["priority"]} */ (priority),
    planned: String(data.planned) === "true",
    tasks: Array.isArray(data.tasks) ? data.tasks.map(String) : [],
  };
}

/**
 * Next unsplit requirement — DETERMINISTIC: priority then file name. A requirement
 * already split but with open questions is still `planned: true`: questions block TASKS,
 * not the planner moving on to another requirement.
 * @param {Requirement[]} requirements @returns {Requirement|null}
 */
export function nextRequirement(requirements) {
  const open = requirements
    .filter((r) => !r.planned)
    .sort((a, b) =>
      PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority) || a.file.localeCompare(b.file));
  return open[0] ?? null;
}

/**
 * The planner's next work, in order:
 *   1. a draft whose question was JUST answered (`revise-for`) — the answer may change work
 *      already split, so revise before splitting more (A-027); includes the verbatim answer;
 *   2. an unsplit requirement;
 *   3. a draft lacking context that is no longer waiting on anyone.
 * @param {Requirement[]} requirements
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @param {Map<string, import("./backlog.mjs").Question>} [questions]
 * @returns {null | {kind: "requirement", file: string}
 *   | {kind: "revise", id: string, missing: string[], answers: Record<string, string>}}
 */
export function nextWork(requirements, backlog, questions = new Map()) {
  const drafts = [...backlog.values()]
    .filter((t) => t.status === "draft" && t.blockedOn.length === 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  const answered = drafts.find((t) => t.reviseFor.length > 0);
  if (answered) {
    /** @type {Record<string, string>} */
    const answers = {};
    for (const q of answered.reviseFor) answers[q] = questions.get(q)?.answer ?? "";
    return { kind: "revise", id: answered.id, missing: isReady(answered, backlog).missing, answers };
  }

  const req = nextRequirement(requirements);
  if (req) return { kind: "requirement", file: req.file };
  for (const task of drafts) {
    const r = isReady(task, backlog);
    if (!r.ok) return { kind: "revise", id: task.id, missing: r.missing, answers: {} };
  }
  return null;
}

// ─── Harvesting answers ─────────────────────────────────────────────────────

/**
 * @typedef {Object} AnswerPlan
 * @property {{id: string, answer: string}[]} record   write the answer into the question file → answered
 * @property {{id: string, blockedOn: string[], reviseFor: string[], event: "answered"|null}[]} unblock
 *           `reviseFor` = marker after merging the just-answered questions into the task's old marker (A-027)
 * @property {string[]} close   answered questions no task is still waiting on → closed
 */

/**
 * PURE FUNCTION. A question counts as answered when its file has an answer, or
 * a human just typed one in the INBOX (`inboxAnswers`). Drafts waiting on it are unblocked;
 * a `needs-decision` task with nothing left to wait on emits `answered` → back to `draft` so the
 * planner rewrites it per the answer.
 *
 * @param {Map<string, import("./backlog.mjs").Task>} backlog
 * @param {Map<string, import("./backlog.mjs").Question>} questions
 * @param {Map<string, string>} inboxAnswers
 * @returns {AnswerPlan}
 */
export function applyAnswers(backlog, questions, inboxAnswers) {
  /** @type {AnswerPlan} */
  const plan = { record: [], unblock: [], close: [] };
  /** @type {Set<string>} */
  const answered = new Set();

  for (const q of [...questions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (q.status !== "open" || q.answer !== "") {
      answered.add(q.id);
      continue;
    }
    const fresh = inboxAnswers.get(q.id);
    if (fresh) {
      plan.record.push({ id: q.id, answer: fresh });
      answered.add(q.id);
    }
  }

  /** @type {Set<string>} */
  const stillWaited = new Set();
  for (const task of [...backlog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.blockedOn.length === 0) continue;
    // Task outside the planner's permission: don't unblock — doctor will flag it (todo but still waiting).
    if (!PLANNER_STATUSES.includes(task.status)) {
      for (const q of task.blockedOn) stillWaited.add(q);
      continue;
    }
    const remaining = task.blockedOn.filter((q) => !answered.has(q));
    const justAnswered = task.blockedOn.filter((q) => answered.has(q));
    for (const q of remaining) stillWaited.add(q);
    if (remaining.length === task.blockedOn.length) continue;
    plan.unblock.push({
      id: task.id,
      blockedOn: remaining,
      reviseFor: [...new Set([...task.reviseFor, ...justAnswered])].sort(),
      event: task.status === "needs-decision" && remaining.length === 0 ? "answered" : null,
    });
  }

  for (const q of [...questions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (q.status !== "closed" && answered.has(q.id) && !stillWaited.has(q.id)) plan.close.push(q.id);
  }
  return plan;
}

// ─── File-writing layer ─────────────────────────────────────────────────────

/**
 * Replace the content of section `## <name>` (up to the next section). No section → append at end of file.
 * @param {string} content @param {string} heading @param {string} value @returns {string}
 */
export function setSection(content, heading, value) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return `${content.replace(/\n*$/, "")}\n\n## ${heading}\n${value}\n`;
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const end = endRel === -1 ? lines.length : start + 1 + endRel;
  return [...lines.slice(0, start + 1), value, "", ...lines.slice(end)].join("\n").replace(/\n+$/, "\n");
}

/** @param {string} [dir] @returns {Requirement[]} */
export function loadRequirements(dir = config.requirementsDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      return parseRequirement(file, fs.readFileSync(file, "utf8"));
    });
}

/**
 * One planner sync round: harvest answers → unblock → ask/ready → regenerate the INBOX.
 * Every task state change goes through `applyEvent` (state machine) AFTER the permission fence.
 * @param {string} [tasksDir]
 */
export function syncPlanner(tasksDir = config.tasksDir) {
  const inboxFile = path.join(tasksDir, "INBOX.md");
  const inboxAnswers = fs.existsSync(inboxFile)
    ? parseAnswers(fs.readFileSync(inboxFile, "utf8"))
    : new Map();
  let backlog = loadBacklog(tasksDir);
  const questions = loadQuestions(tasksDir);
  const plan = applyAnswers(backlog, questions, inboxAnswers);

  for (const { id, answer } of plan.record) {
    const q = /** @type {import("./backlog.mjs").Question} */ (questions.get(id));
    let text = fs.readFileSync(q.file, "utf8");
    text = setSection(text, config.headings.answer, answer);
    text = patchFrontMatter(text, { status: "answered", updated: new Date().toISOString() }, q.file);
    fs.writeFileSync(q.file, text);
  }
  for (const { id, blockedOn, reviseFor, event } of plan.unblock) {
    const task = /** @type {import("./backlog.mjs").Task} */ (backlog.get(id));
    assertPlannerMay(task, event ?? undefined);
    const text = patchFrontMatter(
      fs.readFileSync(task.file, "utf8"),
      // `revise-for` marker: the machine SETS it here; only the planner (after rewriting) or a human REMOVES it.
      { "blocked-on": `[${blockedOn.join(", ")}]`, "revise-for": `[${reviseFor.join(", ")}]` },
      task.file,
    );
    fs.writeFileSync(task.file, text);
    if (event) applyEvent({ ...task, blockedOn, reviseFor }, event);
  }
  for (const id of plan.close) {
    const q = /** @type {import("./backlog.mjs").Question} */ (questions.get(id));
    fs.writeFileSync(q.file, patchFrontMatter(fs.readFileSync(q.file, "utf8"), { status: "closed" }, q.file));
  }

  backlog = loadBacklog(tasksDir);
  const moves = draftTransitions(backlog);
  for (const { id, event } of moves) {
    const task = /** @type {import("./backlog.mjs").Task} */ (backlog.get(id));
    assertPlannerMay(task, event);
    applyEvent(task, event);
  }

  backlog = loadBacklog(tasksDir);
  const notReady = [...backlog.values()]
    .filter((t) => t.status === "draft")
    .map((t) => ({ id: t.id, missing: isReady(t, backlog).missing }));
  writeInbox(tasksDir);
  return { plan, moves, notReady };
}
