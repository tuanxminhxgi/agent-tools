#!/usr/bin/env node
// @ts-check
/**
 * Gate for evaluator roles inside `verify:` (A-012):
 *
 *   node scripts/agent-queue/report-ok.mjs <id> qa|sec
 *
 * Exits 0 ONLY when `reports/<id>.<role>.json` exists, is JSON of shape
 * `{ok: boolean, checked: string[], bugs: string[]}`, `ok === true` and `bugs` is empty.
 * This keeps the verifier the ONLY place that decides `done` — QA/security just write reports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { validateFindings } from "./findings.mjs";

/**
 * @param {unknown} data
 * @returns {{ok: boolean, reason: string}}
 */
export function checkReport(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "report is not a JSON object" };
  }
  const r = /** @type {Record<string, unknown>} */ (data);
  if (typeof r.ok !== "boolean") return { ok: false, reason: "missing field ok (boolean)" };
  if (!Array.isArray(r.checked) || !r.checked.every((x) => typeof x === "string")) {
    return { ok: false, reason: "checked must be a string array" };
  }
  if (!Array.isArray(r.bugs) || !r.bugs.every((x) => typeof x === "string")) {
    return { ok: false, reason: "bugs must be a string array" };
  }
  // ok: true while still listing bugs is a self-contradicting report — trust neither side.
  if (r.ok && r.bugs.length > 0) return { ok: false, reason: `ok: true but has ${r.bugs.length} bug(s) — contradictory report` };
  if (!r.ok) return { ok: false, reason: `evaluator concluded red: ${r.bugs.join(" · ") || "(no reason given)"}` };
  if (r.checked.length === 0) return { ok: false, reason: "checked is empty — concluded green without checking anything" };
  return { ok: true, reason: `green (${r.checked.length} item(s) checked)` };
}

/**
 * @param {string} root @param {string} id @param {"qa"|"sec"} kind
 * @returns {{ok: boolean, reason: string}}
 */
export function checkReportFile(root, id, kind) {
  const file = path.join(root, "reports", `${id}.${kind}.json`);
  if (!fs.existsSync(file)) return { ok: false, reason: `no report yet: ${path.relative(root, file)}` };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, reason: `${path.relative(root, file)}: malformed JSON — ${/** @type {Error} */ (err).message}` };
  }
  return checkReport(data);
}

/**
 * Verdict for `verify:` by role KIND (A-021): a `kind: reviewer` role does NOT block — its findings
 * go to the INBOX, a missing/broken report only warns (the INBOX says so); other roles (qa) block as before.
 * @param {string} root @param {string} id @param {string} suffix  `qa` | `sec` | role name
 * @param {Record<string, {kind: string}>} [roles]
 * @returns {{ok: boolean, reason: string}}
 */
export function verdict(root, id, suffix, roles = config.roles) {
  const role = suffix === "sec" ? "security" : suffix;
  if (roles[role]?.kind !== "reviewer") return checkReportFile(root, id, /** @type {"qa"|"sec"} */ (suffix));
  const file = path.join(root, "reports", `${id}.${suffix}.json`);
  if (!fs.existsSync(file)) return { ok: true, reason: `reviewer ${role} has no report yet — not blocking; the INBOX will report it` };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: true, reason: `reviewer ${role}'s report is malformed — not blocking; the INBOX will report it` };
  }
  if (typeof data.error === "string") return { ok: true, reason: `reviewer ${role} failed to submit findings (${data.error}) — not blocking` };
  const n = validateFindings(data).ok ? data.findings.length : 0;
  return { ok: true, reason: `reviewer ${role}: ${n} finding(s) → INBOX, not blocking merge` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [id, kind] = process.argv.slice(2);
  if (!id || !kind || !/^[\w-]+$/.test(kind) || (kind !== "qa" && kind !== "sec" && !config.roles[kind])) {
    process.stderr.write("Usage: node scripts/agent-queue/report-ok.mjs <id> qa|sec|<role name>\n");
    process.exit(2);
  }
  const r = verdict(process.cwd(), id, kind);
  process.stdout.write(`${r.ok ? "✓" : "✗"} ${id} ${kind}: ${r.reason}\n`);
  process.exit(r.ok ? 0 : 1);
}
