// @ts-check
/**
 * REVIEWER FINDINGS → INBOX, DO NOT BLOCK MERGING (A-021).
 *
 * Decided by the repo owner 2026-09-26: findings of reviewers (roles with `kind: reviewer` in the
 * `roles` table — e.g. security, rbac, i18n, migration) show up in `tasks/INBOX.md` for a human; only
 * `qa` bugs (a red reproduction test) block. Reviewers have NO write access, so they print a final
 * ```json … ``` block; the conductor extracts it and writes `reports/<id>.<role>.json`.
 *
 * A reviewer that fails to submit JSON → a report with `error` is still written and the INBOX says so — NEVER silent.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { reportSuffix } from "./roles.mjs";
import { emitEvent } from "./events.mjs";

export const SEVERITIES = /** @type {const} */ (["critical", "high", "medium", "low"]);

/**
 * @typedef {{severity: "critical"|"high"|"medium"|"low", rule: string, file: string, line?: number, detail: string}} Finding
 * @typedef {{role: string, task: string, ok: boolean, checked: string[], findings: Finding[]}} FindingsReport
 * @typedef {{role: string, task: string, error: string}} FindingsFailure
 */

/**
 * The LAST ```json … ``` block in the reviewer's stdout. PURE FUNCTION.
 * @param {string} stdout
 * @returns {{ok: true, report: FindingsReport} | {ok: false, error: string}}
 */
export function parseFindings(stdout) {
  const blocks = [...stdout.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) return { ok: false, error: "no ```json … ``` block in the output" };
  let data;
  try {
    data = JSON.parse(blocks[blocks.length - 1][1]);
  } catch (err) {
    return { ok: false, error: `last JSON block is malformed: ${/** @type {Error} */ (err).message}` };
  }
  const v = validateFindings(data);
  if (!v.ok) return { ok: false, error: `malformed report: ${v.missing.join(" · ")}` };
  return { ok: true, report: /** @type {FindingsReport} */ (data) };
}

/**
 * @param {unknown} report @returns {{ok: boolean, missing: string[]}}
 */
export function validateFindings(report) {
  /** @type {string[]} */
  const missing = [];
  if (report === null || typeof report !== "object" || Array.isArray(report)) return { ok: false, missing: ["object JSON"] };
  const r = /** @type {Record<string, unknown>} */ (report);
  if (typeof r.role !== "string" || r.role === "") missing.push("role");
  if (typeof r.task !== "string" || r.task === "") missing.push("task");
  if (typeof r.ok !== "boolean") missing.push("ok");
  if (!Array.isArray(r.checked) || !r.checked.every((x) => typeof x === "string")) missing.push("checked (string array)");
  if (!Array.isArray(r.findings)) {
    missing.push("findings (array)");
  } else {
    r.findings.forEach((f, i) => {
      const x = /** @type {Record<string, unknown>} */ (f ?? {});
      if (!SEVERITIES.includes(/** @type {never} */ (x.severity))) missing.push(`findings[${i}].severity`);
      for (const k of ["rule", "file", "detail"]) if (typeof x[k] !== "string" || x[k] === "") missing.push(`findings[${i}].${k}`);
      if (x.line !== undefined && !Number.isInteger(x.line)) missing.push(`findings[${i}].line`);
    });
    // ok: true while still listing findings is a self-contradicting report.
    if (r.ok === true && r.findings.length > 0) missing.push("ok: true but has findings");
  }
  return { ok: missing.length === 0, missing };
}

/** Max reviewer calls per review pass: the first + ONE retry (A-073). There is no third. */
export const MAX_REVIEWER_CALLS = 2;

/**
 * Retry the reviewer? PURE FUNCTION, shared by the serial (`runWorker`) and parallel (`runChainStep`) paths.
 * Retry only when the output could NOT be parsed and fewer than `MAX_REVIEWER_CALLS` calls were made. A reviewer
 * exiting ≠ 0 does not come through here — it takes the existing recovery path; the caller filters.
 * @param {{ok: boolean}} parsed result of `parseFindings` @param {number} callsMade calls made so far (including the one just finished)
 */
export function shouldRetryReviewer(parsed, callsMade) {
  return !parsed.ok && callsMade < MAX_REVIEWER_CALLS;
}

/**
 * Tail appended to the original prompt for the retry: the verbatim `parseFindings` error + why the previous turn was discarded.
 * @param {string} error
 */
export function reviewerRetryTail(error) {
  return [
    "",
    "## Retry once",
    `Error: ${error}`,
    "Your previous turn had no JSON block, so it was discarded; review again and end with a JSON block.",
    "The FINAL message must contain a ```json block (even with no findings: `\"ok\": true, \"findings\": []`). "
      + `Do not write \`## ${config.headings.handoff}\`, do not ask for permissions.`,
  ].join("\n");
}

/**
 * Extract + write the reviewer's report. On failure writes an error record (the INBOX reports it), never throws.
 * @param {string} root @param {string} taskId @param {string} role @param {string} stdout
 * @returns {{file: string, ok: boolean}}
 */
export function recordFindings(root, taskId, role, stdout) {
  const file = path.join(root, "reports", `${taskId}.${reportSuffix(role)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parsed = parseFindings(stdout);
  /** @type {FindingsReport | FindingsFailure} */
  const body = parsed.ok ? parsed.report : { role, task: taskId, error: parsed.error };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  emitFindings(root, taskId, role, file, parsed.ok ? parsed.report.findings : null);
  return { file, ok: parsed.ok };
}

/**
 * Event ledger: one `finding` per severity that has findings (with `count`), pointing at the report file.
 * A reviewer that failed to submit JSON → one `finding` with severity `error` (the INBOX reports it too — never silent). Never throws.
 * @param {string} root @param {string} taskId @param {string} role @param {string} file
 * @param {Finding[]|null} list null = error report
 */
function emitFindings(root, taskId, role, file, list) {
  const rel = path.relative(root, file);
  if (list === null) {
    emitEvent(root, "finding", { taskId, role, severity: "error", count: 1, file: rel });
    return;
  }
  for (const severity of SEVERITIES) {
    const count = list.filter((f) => f.severity === severity).length;
    if (count > 0) emitEvent(root, "finding", { taskId, role, severity, count, file: rel });
  }
}

/** Names of the `kind: reviewer` roles in the current roles table. @param {Record<string, {kind: string}>} [roles] */
export function reviewerRoles(roles = config.roles) {
  return Object.entries(roles).filter(([, r]) => r.kind === "reviewer").map(([name]) => name).sort();
}

/** Findings resolutions ledger (A-071), relative to the repo root. Lives next to the reports but is no role's report. */
export const RESOLUTIONS_FILE = "reports/resolutions.json";

export const RESOLUTION_STATUSES = /** @type {const} */ (["fixed", "accepted", "wontfix", "false-positive"]);

/**
 * @typedef {{task: string, role: string, file: string, line?: number, rule: string, status: "fixed"|"accepted"|"wontfix"|"false-positive", by?: string, evidence: string[], note: string, date: string}} Resolution
 * @typedef {Finding & {task: string, role: string}} TaggedFinding
 */

/**
 * Match key between a ledger entry and a finding: all five fields `task`, `role` (role name), `file`, `line`, `rule`. PURE FUNCTION.
 * @param {{task: string, role: string, file: string, line?: number, rule: string}} x
 */
export function resolutionKey(x) {
  return JSON.stringify([x.task, x.role, x.file, x.line ?? null, x.rule]);
}

/**
 * Check the ledger SHAPE (no disk access yet): object `{schemaVersion: 1, resolutions: []}`, every entry complete,
 * valid `status`, `fixed` has `by`. PURE FUNCTION.
 * @param {unknown} data
 * @returns {{ok: boolean, problems: string[], entries: Resolution[]}}
 */
export function validateResolutions(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, problems: ["ledger must be a JSON object"], entries: [] };
  const d = /** @type {Record<string, unknown>} */ (data);
  /** @type {string[]} */
  const problems = [];
  if (d.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (!Array.isArray(d.resolutions)) return { ok: false, problems: [...problems, "resolutions (array)"], entries: [] };
  d.resolutions.forEach((e, i) => {
    const x = /** @type {Record<string, unknown>} */ (e !== null && typeof e === "object" && !Array.isArray(e) ? e : {});
    const at = `resolutions[${i}]`;
    for (const k of ["task", "role", "file", "rule", "note", "date"]) if (typeof x[k] !== "string" || x[k] === "") problems.push(`${at}.${k}`);
    if (x.line !== undefined && !Number.isInteger(x.line)) problems.push(`${at}.line`);
    if (!RESOLUTION_STATUSES.includes(/** @type {never} */ (x.status))) problems.push(`${at}.status (${RESOLUTION_STATUSES.join("|")})`);
    if (x.by !== undefined && (typeof x.by !== "string" || x.by === "")) problems.push(`${at}.by`);
    if (x.status === "fixed" && x.by === undefined) problems.push(`${at}.by (required when fixed)`);
    if (!Array.isArray(x.evidence) || x.evidence.length === 0 || !x.evidence.every((p) => typeof p === "string" && p !== "")) problems.push(`${at}.evidence (≥ 1 path)`);
  });
  return { ok: problems.length === 0, problems, entries: problems.length === 0 ? /** @type {Resolution[]} */ (d.resolutions) : [] };
}

/**
 * Check the disk/task part of ledger entries that ALREADY have the right shape: `by` is an existing task, `evidence`
 * paths exist inside `root`, no duplicate keys. Returns a list of problems (empty = clean).
 * @param {Resolution[]} entries @param {{root: string, taskIds: Set<string>}} ctx
 * @returns {string[]}
 */
export function checkResolutionRefs(entries, { root, taskIds }) {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `resolutions[${i}] (${e.task} · ${e.file}${e.line === undefined ? "" : `:${e.line}`})`;
    if (e.by !== undefined && !taskIds.has(e.by)) problems.push(`${at}: by "${e.by}" is not an existing task`);
    for (const p of e.evidence) {
      const abs = path.resolve(root, p);
      const inside = abs === root || abs.startsWith(path.resolve(root) + path.sep);
      if (!inside || !fs.existsSync(abs)) problems.push(`${at}: evidence "${p}" does not exist`);
    }
    const key = resolutionKey(e);
    if (seen.has(key)) problems.push(`${at}: duplicate key of an earlier entry`);
    seen.add(key);
  });
  return problems;
}

/**
 * Read the resolutions ledger. NEVER throws: missing file = empty ledger; broken (bad JSON, wrong shape) = empty ledger with `problems`.
 * @param {string} root
 * @returns {{entries: Resolution[], problems: string[]}}
 */
export function loadResolutions(root) {
  const file = path.join(root, RESOLUTIONS_FILE);
  if (!fs.existsSync(file)) return { entries: [], problems: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], problems: ["malformed JSON"] };
  }
  const v = validateResolutions(data);
  return { entries: v.entries, problems: v.problems };
}

/**
 * Can a ledger entry be reported as orphan when it matches no finding? `fixed` cannot (see `loadFindings`);
 * `accepted`/`wontfix`/`false-positive` can — that finding should still be in the report.
 * @param {Resolution} e
 */
function isOrphanCandidate(e) {
  return e.status !== "fixed";
}

/**
 * Read every reviewer report in `reports/` for the INBOX, then filter by the resolutions ledger.
 * `findings` keeps only OPEN findings; `resolved` are findings matched by a ledger entry (with `resolution`);
 * `orphanResolutions` are ledger entries matching no finding AND not `fixed` (A-091: a fixed finding is no longer raised
 * by the re-review — a remaining `fixed` entry is evidence, not junk). Broken ledger → treated as empty + one entry in `failures`.
 * @param {string} root @param {string[]} [reviewers]
 * @returns {{findings: TaggedFinding[], failures: FindingsFailure[], resolved: (TaggedFinding & {resolution: Resolution})[], orphanResolutions: Resolution[]}}
 */
export function loadFindings(root, reviewers = reviewerRoles()) {
  const dir = path.join(root, "reports");
  /** @type {TaggedFinding[]} */
  const all = [];
  /** @type {FindingsFailure[]} */
  const failures = [];
  if (!fs.existsSync(dir)) return { findings: all, failures, resolved: [], orphanResolutions: loadResolutions(root).entries.filter(isOrphanCandidate) };
  const suffixes = new Map(reviewers.map((r) => [reportSuffix(r), r]));
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^(.+)\.([^.]+)\.json$/.exec(name);
    if (!m || !suffixes.has(m[2])) continue;
    const role = /** @type {string} */ (suffixes.get(m[2]));
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      failures.push({ role, task: m[1], error: `${name}: malformed JSON` });
      continue;
    }
    if (typeof data.error === "string") {
      failures.push({ role, task: m[1], error: data.error });
      continue;
    }
    for (const f of validateFindings(data).ok ? data.findings : []) all.push({ ...f, task: m[1], role });
  }
  const rank = (/** @type {string} */ s) => SEVERITIES.indexOf(/** @type {never} */ (s));
  all.sort((a, b) => rank(a.severity) - rank(b.severity) || a.task.localeCompare(b.task) || a.role.localeCompare(b.role));

  const ledger = loadResolutions(root);
  if (ledger.problems.length > 0) failures.push({ role: "resolutions", task: RESOLUTIONS_FILE, error: ledger.problems.join(" · ") });
  const byKey = new Map(ledger.entries.map((e) => [resolutionKey(e), e]));
  const findingKeys = new Set(all.map(resolutionKey));
  /** @type {TaggedFinding[]} */
  const findings = [];
  /** @type {(TaggedFinding & {resolution: Resolution})[]} */
  const resolved = [];
  for (const f of all) {
    const resolution = byKey.get(resolutionKey(f));
    if (resolution) resolved.push({ ...f, resolution });
    else findings.push(f);
  }
  const orphanResolutions = ledger.entries.filter((e) => isOrphanCandidate(e) && !findingKeys.has(resolutionKey(e)));
  return { findings, failures, resolved, orphanResolutions };
}
