// @ts-check
/**
 * PreToolUse hook — reminds the matching skill whenever Claude is about to create or edit a file
 * within a declared scope.
 *
 * Why a hook rather than just leaving skills in `.claude/skills/`: skills are loaded at the
 * model's discretion based on their `description`. For rules like "applies to EVERY UI file"
 * and "EVERY backend task", discretion is not enough — only a hook runs deterministically
 * every time.
 *
 * This hook **blocks nothing**: it always exits 0 and only injects context
 * (`additionalContext`). Bad payload, missing `file_path`, a path outside the project
 * tree, or a broken config file all exit 0 silently.
 */

import path from "node:path";
import { loadProjectConfig } from "../scripts/project-config.mjs";
import { matchAny } from "../scripts/glob.mjs";

/**
 * The scope table NO LONGER lives here. It is the `skills` key in the project's
 * `.claude/agent-queue.config.json`, and the agent queue's `skillsFor()` reads the SAME
 * table (P-001) — previously two twin tables had to be kept in sync by a cross-check
 * test. New skill = one more entry in the config file.
 *
 * @typedef {{skill: string, reminder: string}} Scope
 */

/**
 * The skill matching a path, or null. PURE FUNCTION when `skills` is passed.
 * @param {string} filePath
 * @param {string} projectDir
 * @param {import("../scripts/project-config.mjs").SkillRule[]} [skills]
 * @returns {Scope|null}
 */
export function matchScope(filePath, projectDir, skills = loadProjectConfig(projectDir).skills) {
  if (!filePath) return null;
  const rel = path
    .relative(projectDir, path.resolve(projectDir, filePath))
    .split(path.sep)
    .join("/");
  if (rel.startsWith("..")) return null; // outside the project tree
  const rule = skills.find((s) => matchAny(s.globs, rel));
  return rule ? { skill: rule.skill, reminder: rule.reminder.join("\n") } : null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  /** @type {any} */
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // never block a file edit
  }

  /** @type {Scope|null} */
  let scope = null;
  try {
    scope = matchScope(
      payload?.tool_input?.file_path ?? "",
      process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    );
  } catch {
    process.exit(0); // a broken config must not block file edits — doctor reports it
  }
  if (!scope) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: scope.reminder,
      },
      suppressOutput: true,
    })
  );
  process.exit(0);
}

// Run when executed directly; not when imported by tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main();
}
