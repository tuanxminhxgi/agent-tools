// @ts-check
/**
 * COMPACT SUMMARY FILES (A-055) — one place that names and writes `logs/agent-queue/<id>/compact-<n>.md`, shared
 * by the conductor (compact at a task boundary in a session chain) and the `PostCompact` hook (Claude Code
 * auto-compacting mid-task). `<id>` is the task id, or `session-<session id>` when the session belongs to no task.
 *
 * Rule: writing a summary file NEVER breaks the caller — a disk error returns null. Secrets are masked before writing.
 */
import fs from "node:fs";
import path from "node:path";
import { maskSecrets } from "./worker.mjs";

/** Length cap of a task-boundary summary — enough to carry on, not a second transcript. */
export const COMPACT_MAX_CHARS = 8000;

/** The seven sections of the summary template, in order (tasks/A-055…md, Contract). */
export const COMPACT_SECTIONS = [
  "Goal", "Done", "Decisions and rationale", "Files changed", "Open errors (verbatim)", "Next steps",
  "Known — don't re-explore",
];

/** Safe directory name: only letters, digits, `-`, `_`, `.` — cannot escape `logs/agent-queue/`. @param {string} id */
export function safeLogId(id) {
  const clean = String(id).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return clean === "" ? "unknown" : clean;
}

/**
 * PURE FUNCTION. Next sequence number from the directory's file names (`compact-3.md` → 4).
 * @param {string[]} names @returns {number}
 */
export function nextCompactIndex(names) {
  let max = 0;
  for (const n of names) {
    const m = /^compact-(\d+)\.md$/.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Write one summary. Returns the path relative to the repo root, or null when it could not be written.
 * @param {string} root repo root @param {string} id task id or `session-<…>` @param {string} text
 * @returns {string|null}
 */
export function writeCompactFile(root, id, text) {
  try {
    const dir = path.join(root, "logs", "agent-queue", safeLogId(id));
    fs.mkdirSync(dir, { recursive: true });
    const name = `compact-${nextCompactIndex(fs.readdirSync(dir))}.md`;
    fs.writeFileSync(path.join(dir, name), `${maskSecrets(text).trimEnd()}\n`, { flag: "wx" });
    return path.relative(root, path.join(dir, name)).split(path.sep).join("/");
  } catch {
    return null;
  }
}
