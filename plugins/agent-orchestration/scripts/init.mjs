// @ts-check
/**
 * INIT — scaffolds the agent queue for a new project (P-004).
 *
 * Rule: NEVER OVERWRITE. Existing files are kept as is; an existing `AGENTS.md` or
 * `.gitignore` only gets the missing part APPENDED, once. Re-running any number of times
 * yields the same tree. No fake sample tasks — an empty backlog is correct.
 *
 * `planInit` is a PURE function of (current tree, template content); `applyInit` only
 * executes the action list. Content comes from the plugin's `templates/` — no long
 * strings embedded in code.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_MARK = "<!-- agent-orchestration:start";
const GITIGNORE_LINES = [".claude/agent-queue.json", ".claude/agent-queue.log", ".claude/worktrees/"];

/**
 * Templates directory: next to the code in the plugin (`scripts/../templates`), or in the source
 * repo (`scripts/agent-queue/../../plugins/agent-orchestration/templates`).
 * @returns {string}
 */
export function defaultTemplatesDir() {
  const candidates = [
    path.join(HERE, "..", "templates"),
    path.join(HERE, "..", "..", "plugins", "agent-orchestration", "templates"),
  ];
  const found = candidates.find((d) => fs.existsSync(path.join(d, "task.md")));
  if (!found) throw new Error(`Templates directory not found. Tried: ${candidates.join(", ")}`);
  return found;
}

/**
 * @typedef {{path: string, action: "create"|"append"|"keep", content: string}} InitAction
 */

/**
 * @param {string} root
 * @param {string} templatesDir
 * @param {{projectName?: string|null}} [answers]
 * @returns {InitAction[]}
 */
export function planInit(root, templatesDir, answers = {}) {
  const tpl = (/** @type {string} */ name) => fs.readFileSync(path.join(templatesDir, name), "utf8");
  const exists = (/** @type {string} */ rel) => fs.existsSync(path.join(root, rel));

  /** @type {[string, string][]} target → content */
  const files = [
    ["tasks/INDEX.md", tpl("INDEX.md")],
    ["tasks/_templates/task.md", tpl("task.md")],
    ["tasks/_templates/bug.md", tpl("bug.md")],
    ["tasks/_templates/question.md", tpl("question.md")],
    ["tasks/questions/.gitkeep", ""],
    ["requirements/README.md", tpl("requirements-README.md")],
    [".claude/agent-queue.config.json", configFor(tpl("agent-queue.config.json"), answers.projectName ?? null)],
    [".claude/agents/planner.md", tpl("agent-planner.md")],
    // NEUTRAL orchestration roles (A-022) — the project tailors its own prompts after init.
    [".claude/agents/developer.md", tpl("agent-developer.md")],
    [".claude/agents/qa.md", tpl("agent-qa.md")],
    [".claude/agents/security.md", tpl("agent-security.md")],
    [".claude/agents/fixer.md", tpl("agent-fixer.md")],
  ];
  /** @type {InitAction[]} */
  const actions = files.map(([rel, content]) =>
    exists(rel) ? { path: rel, action: "keep", content: "" } : { path: rel, action: "create", content });

  // AGENTS.md: create if missing; otherwise append the rules section ONCE (detected by the marker).
  const section = tpl("AGENTS-section.md");
  if (!exists("AGENTS.md")) {
    actions.push({ path: "AGENTS.md", action: "create", content: `# AGENTS.md\n\n${section}` });
  } else if (!fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(AGENTS_MARK)) {
    actions.push({ path: "AGENTS.md", action: "append", content: `\n${section}` });
  } else {
    actions.push({ path: "AGENTS.md", action: "keep", content: "" });
  }

  // .gitignore: append only missing lines — session store, log and worktrees are never committed.
  const current = exists(".gitignore") ? fs.readFileSync(path.join(root, ".gitignore"), "utf8") : "";
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) {
    actions.push({ path: ".gitignore", action: "keep", content: "" });
  } else {
    const lead = current === "" || current.endsWith("\n") ? "" : "\n";
    actions.push({
      path: ".gitignore",
      action: current === "" ? "create" : "append",
      content: `${lead}# agent-orchestration\n${missing.join("\n")}\n`,
    });
  }
  return actions;
}

/**
 * Fill `projectName` into the sample config, keeping key order and the `//…` comment keys.
 * @param {string} template @param {string|null} projectName @returns {string}
 */
export function configFor(template, projectName) {
  const data = JSON.parse(template);
  data.projectName = projectName;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * @param {string} root @param {InitAction[]} actions
 * @returns {{created: string[], appended: string[], kept: string[]}}
 */
export function applyInit(root, actions) {
  /** @type {{created: string[], appended: string[], kept: string[]}} */
  const report = { created: [], appended: [], kept: [] };
  for (const a of actions) {
    const file = path.join(root, a.path);
    if (a.action === "keep") {
      report.kept.push(a.path);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (a.action === "create") {
      // Last fence: stale plan but the file just appeared → still don't overwrite.
      if (fs.existsSync(file)) { report.kept.push(a.path); continue; }
      fs.writeFileSync(file, a.content);
      report.created.push(a.path);
    } else {
      fs.appendFileSync(file, a.content);
      report.appended.push(a.path);
    }
  }
  return report;
}
