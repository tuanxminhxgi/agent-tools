// @ts-check
/**
 * LAYER 1 — backlog self-check. Runs standalone, without the CLI (A-004), and does not
 * run any task verify command (that is Layer 2's job).
 *
 * Six invariants. Breaking any of them makes the automatic loop silently wrong:
 * a dependency pointing at nothing means the task is never ready; a cycle means
 * no task can run; a task not done without verify commands gives the agent
 * no way to finish it.
 *
 * Plus the orchestration invariants (docs/agent-orchestration.md): a task about to run
 * must have the seven-question analysis, must not still wait on a question, and must not
 * declare a lower risk than the measured one; a bug must have all eight sections and
 * must not outlive its parent task.
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadBacklog, loadBugs, loadQuestions, isBlocked, inferRisk, rank, sectionOrNull, BUG_SECTIONS,
} from "./backlog.mjs";
import { config } from "./config.mjs";
import { loadFindings, loadResolutions, checkResolutionRefs, RESOLUTIONS_FILE } from "./findings.mjs";
import { CONTEXT_DIR, MAX_CONTEXT_PACK_CHARS } from "./roles.mjs";

/** Planner still drafting — verify commands and analysis may be missing. */
const IN_PLANNING = new Set(["draft", "needs-decision"]);
/** About to run or running — the analysis must exist BEFORE work starts, not be added afterwards. */
const ABOUT_TO_RUN = new Set(["todo", "doing"]);

/**
 * Which of the seven questions in the `## <config.headings.analysis>` section are missing or empty.
 * The label before `:` is free-form — only an answer after it is required. PURE FUNCTION.
 * @param {string} body @returns {number[]|null} null = section absent
 */
export function analysisGaps(body) {
  const text = sectionOrNull(body, config.headings.analysis);
  if (text === null) return null;
  const lines = text.split("\n");
  /** @type {number[]} */
  const gaps = [];
  for (let n = 1; n <= 7; n += 1) {
    const line = lines.find((l) => new RegExp(`^\\s*${n}\\.\\s`).test(l));
    const answer = line?.replace(/^\s*\d\.\s*/, "").replace(/^[^:]*:/, "").trim() ?? "";
    if (answer === "") gaps.push(n);
  }
  return gaps;
}

/**
 * Which of the eight required bug sections are missing or empty. An empty code block
 * (fences only) counts as empty — the template ships such a block. PURE FUNCTION.
 * @param {string} body @returns {string[]}
 */
export function bugGaps(body) {
  return BUG_SECTIONS.filter((name) => {
    const text = sectionOrNull(body, name);
    return text === null || text.replace(/^```.*$/gm, "").trim() === "";
  });
}

/**
 * @param {string} [tasksDir]
 * @param {string} [root] repo root containing `reports/` — defaults to the parent of `tasksDir`
 * @returns {{ok: boolean, total: number, problems: string[], warnings: string[], byStatus: Record<string, number>}}
 */
export function doctor(tasksDir = config.tasksDir, root = path.dirname(path.resolve(tasksDir))) {
  const backlog = loadBacklog(tasksDir);
  const bugs = loadBugs(tasksDir);
  const questions = loadQuestions(tasksDir);
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, number>} */
  const byStatus = {};

  for (const task of backlog.values()) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;

    for (const dep of task.deps) {
      if (!backlog.has(dep)) problems.push(`${task.id}: dependency ${dep} does not exist`);
    }
    if (task.status !== "done" && !IN_PLANNING.has(task.status) && task.verify.length === 0) {
      problems.push(`${task.id}: not done and has no verify commands`);
    }
    if (task.manual.length > 0 && task.gate === "none") {
      problems.push(`${task.id}: has manual checks but gate=none`);
    }
    if (task.manual.length === 0 && task.gate === "manual") {
      problems.push(`${task.id}: gate=manual but no manual checks`);
    }
    if (task.context !== null && task.status !== "done") {
      const file = path.join(tasksDir, CONTEXT_DIR, `${task.context}.md`);
      /** @type {string|null} */
      let pack = null;
      try {
        pack = fs.readFileSync(file, "utf8");
      } catch {
        problems.push(`${task.id}: context ${task.context} but pack ${file} is missing`);
      }
      if (pack !== null && pack.length > MAX_CONTEXT_PACK_CHARS) {
        problems.push(`${task.id}: pack ${file} is ${pack.length} chars, over the ${MAX_CONTEXT_PACK_CHARS} limit`);
      }
    }
    if (task.status === "done" && isBlocked(task, backlog)) {
      problems.push(`${task.id}: done but a dependency is not done`);
    }

    if (ABOUT_TO_RUN.has(task.status)) {
      const gaps = analysisGaps(task.body);
      if (gaps === null) {
        problems.push(`${task.id}: ${task.status} but section \`## ${config.headings.analysis}\` is missing`);
      } else if (gaps.length > 0) {
        problems.push(`${task.id}: ${config.headings.analysis} has empty question(s) ${gaps.join(", ")}`);
      }
      if (task.blockedOn.length > 0) {
        problems.push(`${task.id}: ${task.status} but still waiting on ${task.blockedOn.join(", ")}`);
      }
      if (task.reviseFor.length > 0) {
        problems.push(`${task.id}: ${task.status} but not yet rewritten for answer(s) ${task.reviseFor.join(", ")} (revise-for)`);
      }
    }
    for (const q of task.blockedOn) {
      if (!questions.has(q)) problems.push(`${task.id}: blocked-on ${q} does not exist`);
    }
    const inferred = inferRisk(task);
    if (task.riskDeclared !== null && rank(task.riskDeclared) < rank(inferred)) {
      problems.push(`${task.id}: declares risk=${task.riskDeclared}, lower than measured (${inferred}) — may only be raised`);
    }
    if (task.status === "waiting-bugs") {
      const open = [...bugs.values()].filter((b) => b.parent === task.id && b.status !== "fixed");
      if (open.length === 0) problems.push(`${task.id}: waiting-bugs but no open bugs left — must retest`);
    }
  }

  for (const bug of bugs.values()) {
    const parent = backlog.get(bug.parent);
    if (!parent) {
      problems.push(`${bug.id}: parent task ${bug.parent} does not exist`);
      continue;
    }
    if (bug.status === "fixed") continue;
    if (parent.status === "done") {
      problems.push(`${bug.id}: parent task ${bug.parent} is done but the bug is still ${bug.status} — the bug reached main`);
    }
    const missing = bugGaps(bug.body);
    if (missing.length > 0) problems.push(`${bug.id}: missing or empty section(s) ${missing.join(" · ")}`);
    if (bug.verify.length === 0) problems.push(`${bug.id}: no command to run the reproduction test`);
  }

  for (const q of questions.values()) {
    for (const id of q.blocks) {
      if (!backlog.has(id)) problems.push(`${q.id}: blocks ${id} but that task does not exist`);
    }
  }

  // Dependency cycles.
  /** @type {Map<string, string>} */
  const mark = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} id */
  const visit = (id) => {
    if (mark.get(id) === "done") return;
    if (mark.get(id) === "doing") {
      problems.push(`dependency cycle: ${[...stack, id].join(" → ")}`);
      return;
    }
    mark.set(id, "doing");
    stack.push(id);
    for (const dep of backlog.get(id)?.deps ?? []) {
      if (backlog.has(dep)) visit(dep);
    }
    stack.pop();
    mark.set(id, "done");
  };
  for (const id of backlog.keys()) visit(id);

  // Reviewer-findings resolutions ledger (A-071): bad shape / broken refs / duplicate keys are RED; orphan entries only YELLOW.
  const ledger = loadResolutions(root);
  for (const p of ledger.problems) problems.push(`${RESOLUTIONS_FILE}: ${p}`);
  for (const p of checkResolutionRefs(ledger.entries, { root, taskIds: new Set(backlog.keys()) })) {
    problems.push(`${RESOLUTIONS_FILE}: ${p}`);
  }
  /** @type {string[]} */
  const warnings = [];
  for (const o of loadFindings(root).orphanResolutions) {
    warnings.push(`${RESOLUTIONS_FILE}: orphan entry, matches no finding — ${o.task} · ${o.role} · ${o.file}${o.line === undefined ? "" : `:${o.line}`} · ${o.rule}`);
  }

  return { ok: problems.length === 0, total: backlog.size, problems, warnings, byStatus };
}

// Run directly: `node scripts/agent-queue/doctor.mjs`
if (process.argv[1] && process.argv[1].endsWith("doctor.mjs")) {
  const result = doctor();
  const summary = Object.entries(result.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  process.stdout.write(`${result.total} task · ${summary}\n`);
  for (const p of result.problems) process.stdout.write(`  ✗ ${p}\n`);
  for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  process.exit(result.ok ? 0 : 1);
}
