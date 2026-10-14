// @ts-check
/**
 * PER-PROJECT CONFIG — `.claude/agent-queue.config.json`.
 * Design: docs/agent-plugin.md, section "`.claude/agent-queue.config.json`".
 *
 * The orchestration code keeps only GENERIC DEFAULTS — no money keywords, no skills, no
 * migration paths of any particular repo. A project's own rules (ORM schema, app roots,
 * skills, the env file of its test DB) live in that project's config file. That way the
 * same code runs in other projects (plugin P-002).
 *
 * This file does not import `config.mjs` — the dependency points the other way: `config.mjs`
 * calls `loadProjectConfig()` at load time.
 */
import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILE = path.join(".claude", "agent-queue.config.json");

/**
 * @typedef {Object} SkillRule
 * @property {string} skill     directory name under `.claude/skills/`
 * @property {string} domain    orchestration domain (backend, web…)
 * @property {string[]} globs   matching files → the hook reminds of the skill when a file is EDITED
 * @property {string[]} roots   root strings (e.g. `packages/api`) — also matched inside `verify:`
 *                              commands such as `cd packages/api && …` when a task is ASSIGNED
 * @property {string[]} reminder  reminder lines injected into the context
 */

/**
 * EXTRA condition of a reviewer role (A-090), evaluated right before the role is called (not when the chain is built).
 * `paths`: globs of files changed in the task's diff · `added`: regexes (strings) tested on each ADDED line of files matching `paths`.
 * Matches when ≥ 1 file matches `paths` AND (no `added` declared OR some added line matches one regex).
 * @typedef {{paths: string[], added?: string[]}} WhenDiff
 */

/**
 * One orchestration role (A-020). `when`: keys are OR-ed, except `diff` (reviewer roles only), which is an EXTRA condition.
 * @typedef {Object} RoleRule
 * @property {{domains?: string[], riskAtLeast?: "medium"|"high", touches?: string[],
 *             locks?: string[], openBugs?: boolean, always?: boolean, diff?: WhenDiff}} when
 * @property {"developer"|"evaluator"|"reviewer"|"fixer"|"planner"} kind
 * @property {string[]} skills   skills to load (directory names under .claude/skills/)
 * @property {string[]} writes   globs the role may write; reviewer = []
 * @property {string} model      Claude Code `--model` name: opus | sonnet | haiku
 * @property {string[]} [bash]   NARROW Bash patterns the role may run under `claude -p` (A-025, Q-001 = C), shaped
 *           `Bash(npx vitest:*)`; added to the `tools` of `.claude/agents/<role>.md` to form `--allowedTools`
 * @property {{from: number, model: string}[]} [modelByRound]  switch model by attempt round (A-026) —
 *           the largest `from` ≤ the round wins; roles without it use one model for every round
 * @property {number|null} [maxBudgetUsd]  cost cap of ONE `claude -p` session (A-087) → `--max-budget-usd`;
 *           null/absent = no cap
 */

/**
 * @typedef {Object} ProjectConfig
 * @property {string|null} projectName
 * @property {string} cliHint          how to invoke the CLI, printed in prompts/reports
 * @property {{moneyKeywords: string[], migrationPaths: string[], highPatterns: string[], mediumPatterns: string[]}} risk
 * @property {SkillRule[]} skills
 * @property {{domain: string, globs: string[]}[]} domains
 * @property {Record<string, string[]>} locks   exclusive lock → globs
 * @property {{commands: string[], envFile: string|null, envVar: string, schemaParam: boolean}} testDb
 *           `envVar`: name of the test-DB URL variable · `schemaParam`: also add `schema=<s>` to each worker's URL
 *           (read by e.g. Prisma's migration engine) besides `options=-c search_path=<s>`
 * @property {CommitRules} commit  how the conductor writes commit messages
 * @property {Record<string, {verify: string[], limit: number, serial?: boolean}>} resources  COUNTABLE resources
 *           (e.g. one e2e suite at a time) — no lane change, only caps how many tasks hold one at once
 *           (`serial: true` = a task holding it runs in the serial lane, on the main worktree)
 * @property {Record<string, RoleRule>} roles  orchestration role table (A-020)
 * @property {number} compactWindow  auto-compact window (tokens) of every `claude -p` session the conductor opens (A-075).
 *                                   Independent of `sessionChain.maxContext` (the "don't resume a session that big" threshold)
 * @property {number} workers        number of parallel workers for the project (env AGENT_QUEUE_WORKERS overrides)
 * @property {{linkDirs: string[], cloneDirs: string[]}} worker   dependency directories (gitignored) symlinked from the
 *                                   main worktree into each worker worktree — no reinstall (A-018).
 *                                   cloneDirs: dependency directories COPIED into the worktree (copy-on-write when the
 *                                   filesystem supports it) instead of symlinked — for tools that reject symlinks
 *                                   pointing outside the project (A-081). A path may not appear in both lists.
 * @property {string[]} diffIgnore   globs NOT counted toward the line/file thresholds of `reassess`
 *                                   (tests, docs, generated files); still counted by the "outside touches" check
 * @property {{port: number, tokenWarnPerTask: number|null}} dashboard  the `agents:ui` page (A-039):
 *                                   default port (`--port` overrides) and tokens/task threshold to flag red (`null` = off)
 * @property {SessionChain} sessionChain  single-session chain by risk (A-052)
 * @property {ChildSession} childSession  what a child `claude -p` session loads (A-087)
 * @property {CiWatch|null} ci       CI workflow to watch (A-079); `null` = off, `gh` is never called
 * @property {Headings} headings     section headings the harness READS from and WRITES to task/bug/question files
 */

/**
 * Markdown headings that are part of the file FORMAT (parsed by code), not prose. English by default; a project whose
 * backlog is already written in another language declares its own words here so existing files keep parsing.
 * @typedef {Object} Headings
 * @property {string} handoff         `## <handoff>` — the handoff log every agent appends to
 * @property {string} analysis        `## <analysis>` — the 7-question orchestration analysis of a task
 * @property {string} question        question file: the question itself
 * @property {string} options         question file: the options
 * @property {string} recommendation  question file: the recommended option
 * @property {string} answer          question file section AND the `<answer>:` line in INBOX
 * @property {string[]} bugSections   the 8 required sections of a bug file, in order (the last one = repro test)
 * @property {string} criticalPath    a line of `tasks/INDEX.md` containing this word (case-insensitive) lists the critical path
 * @property {string} doneWhen        legacy `## <doneWhen>` section read by `migrate`
 * @property {string} legacyDeps      legacy prose format read by `migrate`: label of the dependencies line
 * @property {string} legacyManual    legacy prose format read by `migrate`: marker of a manual-check box
 */

/**
 * Workflow + branch whose CI status INBOX and the conductor read (A-079). `gate` (A-084): `warn` (default) only REPORTS;
 * `block` means red CI on that branch → no push, no new work (`AGENT_QUEUE_CI_GATE` overrides for one run).
 * @typedef {{workflow: string, branch: string, gate: "warn"|"block", localHint?: string|null}} CiWatch
 * `localHint`: command shown in INBOX for rerunning a red job locally (`<job>` is a placeholder); omitted = no hint line.
 */

/**
 * `typeKeywords`: conventional-commit prefix → keywords looked up in the task title + scope (lower-case substring match);
 * key order = rule order, first match wins, no match → `chore`. `trailers`: lines appended to every commit message.
 * @typedef {{typeKeywords: Record<string, string[]>, trailers: string[]}} CommitRules
 */

/**
 * Single-session chain (A-052): tasks with risk ≥ `minRiskForSerial` run only in the serial lane, and the next task's
 * developer `--resume`s the previous task's developer session. A new session is opened when the previous one exceeds
 * `maxContext` tokens or has been idle longer than `maxGapMs` (cache gone cold — resuming then rewrites the whole
 * context, costlier than starting fresh). Both thresholds are initial GUESSES; A-054 recomputes them from the event log.
 * @typedef {{enabled: boolean, maxContext: number, maxGapMs: number, minRiskForSerial: string}} SessionChain
 */

/**
 * What a child session (A-087) loads. `--allowedTools` only decides what may be CALLED; personal MCP servers, skills and
 * tool definitions on the operator's machine are still LOADED into the context on every turn — so the default is LEAN:
 * no MCP (`--strict-mcp-config`), no skills (`--disable-slash-commands`), no Chrome (`--no-chrome`), tools per role
 * (`--tools`). `true` for `skills`/`chrome` = load them.
 * @typedef {{strictMcp: boolean, skills: boolean, chrome: boolean, toolsFromRole: boolean}} ChildSession
 */

/** @type {Readonly<ProjectConfig>} */
export const DEFAULTS = Object.freeze({
  projectName: null,
  cliHint: "node scripts/agent-queue/cli.mjs",
  risk: {
    moneyKeywords: [],
    migrationPaths: [],
    // Generic web vocabulary, not specific to any repo: mistakes here leak data.
    highPatterns: ["auth", "permission", "guard", "upload", "\\.routes\\.", "middleware", "session"],
    mediumPatterns: [],
  },
  skills: [],
  domains: [
    { domain: "e2e", globs: ["e2e/**"] },
    { domain: "infra", globs: ["scripts/**", ".claude/**", ".github/**"] },
  ],
  locks: {
    lockfile: ["**/package.json", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml"],
  },
  testDb: { commands: ["npm test", "vitest", "npm run test"], envFile: null, envVar: "TEST_DATABASE_URL", schemaParam: false },
  commit: {
    typeKeywords: {
      test: ["test", "fixture", "spec"],
      docs: ["docs", "readme", "documentation"],
      fix: ["fix", "bug", "patch", "hotfix"],
      refactor: ["refactor", "clean up", "cleanup", "rename"],
      perf: ["perf", "performance", "optimi"],
      build: ["migration", "schema", "build", "dependenc"],
      feat: ["add", "new", "feature", "api", "ui", "page", "endpoint", "job", "support"],
    },
    trailers: ["Co-Authored-By: Claude <noreply@anthropic.com>"],
  },
  diffIgnore: ["**/*.test.*", "**/*.spec.*", "**/*.md", "**/__fixtures__/**"],
  worker: { linkDirs: ["node_modules"], cloneDirs: [] },
  resources: {},
  workers: 3,
  compactWindow: 200_000,
  dashboard: { port: 4400, tokenWarnPerTask: null },
  sessionChain: { enabled: false, maxContext: 150_000, maxGapMs: 50 * 60_000, minRiskForSerial: "medium" },
  childSession: { strictMcp: true, skills: false, chrome: false, toolsFromRole: true },
  ci: null,
  headings: {
    handoff: "Handoff log",
    analysis: "Orchestration analysis",
    question: "Question",
    options: "Options",
    recommendation: "Recommendation",
    answer: "Answer",
    bugSections: ["Summary", "Environment", "Steps to reproduce", "Expected", "Actual", "Evidence", "Suspected code", "Repro test"],
    criticalPath: "critical path",
    doneWhen: "Done when",
    legacyDeps: "Depends on:",
    legacyManual: "[manual]",
  },
  // NEUTRAL roles — a project declares its own extra roles (reviewers, per-domain developers…) in its config.
  roles: /** @type {Record<string, RoleRule>} */ ({
    developer: {
      kind: "developer", when: { always: true }, skills: [], writes: ["**"], model: "sonnet",
      bash: ["Bash(npm run:*)", "Bash(npm test:*)", "Bash(node:*)", "Bash(npx:*)", "Bash(cd:*)"],
    },
    qa: {
      kind: "evaluator", when: { riskAtLeast: "medium" }, skills: [],
      writes: ["**/*.test.*", "**/*.spec.*", "e2e/**", "reports/**", "tasks/B-*"], model: "sonnet",
      bash: ["Bash(npx vitest:*)", "Bash(npx playwright:*)", "Bash(node --test:*)", "Bash(cd:*)"],
    },
    // reviewer: findings go to INBOX, they do NOT block merging (A-021); still only called when choosePattern asks for it.
    security: { kind: "reviewer", when: { riskAtLeast: "high" }, skills: [], writes: [], model: "sonnet" },
    planner: {
      kind: "planner", when: {}, skills: [], writes: ["tasks/**", "requirements/**"], model: "sonnet",
      // the queue CLI is run with `node <cli.mjs>` (slash commands are disabled in `claude -p`)
      bash: ["Bash(node:*)"],
    },
  }),
});

/**
 * Project root: `CLAUDE_PROJECT_DIR` if set; otherwise walk up from `cwd` to the first
 * directory containing the config file or `.git`; if none is found, `cwd`.
 * @param {string} [from] @returns {string}
 */
export function projectRoot(from = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE)) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(from);
    dir = up;
  }
}

/**
 * Generic defaults merged with the project's config file. Arrays REPLACE (no concatenation) —
 * a project declaring `skills` declares all of them; objects merge one level deep (`risk`, `testDb`, `locks`).
 * No file → defaults. Broken file → THROW with its path: guessing the config is the fastest
 * way for agents to run under the wrong rules without anyone noticing.
 *
 * @param {string} [root] @returns {ProjectConfig}
 */
export function loadProjectConfig(root = projectRoot()) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return clone(DEFAULTS);
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: invalid JSON — ${/** @type {Error} */ (err).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: must be a JSON object`);
  }
  const d = clone(DEFAULTS);
  const merged = {
    projectName: raw.projectName ?? d.projectName,
    cliHint: raw.cliHint ?? d.cliHint,
    risk: { ...d.risk, ...(raw.risk ?? {}) },
    skills: (raw.skills ?? d.skills).map((/** @type {any} */ s) => ({
      skill: String(s.skill), domain: String(s.domain ?? s.skill),
      globs: s.globs ?? [], roots: s.roots ?? [], reminder: s.reminder ?? [],
    })),
    domains: raw.domains ?? d.domains,
    locks: { ...d.locks, ...(raw.locks ?? {}) },
    testDb: { ...d.testDb, ...(raw.testDb ?? {}) },
    commit: {
      typeKeywords: raw.commit?.typeKeywords ?? d.commit.typeKeywords,
      trailers: raw.commit?.trailers ?? d.commit.trailers,
    },
    diffIgnore: raw.diffIgnore ?? d.diffIgnore,
    worker: { ...d.worker, ...(raw.worker ?? {}) },
    resources: { ...d.resources, ...(raw.resources ?? {}) },
    workers: raw.workers ?? d.workers,
    compactWindow: raw.compactWindow ?? d.compactWindow,
    dashboard: { ...d.dashboard, ...(raw.dashboard ?? {}) },
    sessionChain: { ...d.sessionChain, ...(raw.sessionChain ?? {}) },
    childSession: { ...d.childSession, ...(raw.childSession ?? {}) },
    ci: raw.ci === undefined || raw.ci === null || typeof raw.ci !== "object" || Array.isArray(raw.ci)
      ? raw.ci ?? d.ci
      : { gate: "warn", ...raw.ci },
    roles: normalizeRoles({ ...d.roles, ...(raw.roles ?? {}) }, file),
    headings: { ...d.headings, ...(raw.headings ?? {}) },
  };
  // A repeated glob is a harmless typo: dedupe (keep first occurrence order), no error.
  merged.diffIgnore = uniq(merged.diffIgnore);
  merged.worker.linkDirs = uniq(merged.worker.linkDirs);
  merged.worker.cloneDirs = uniq(merged.worker.cloneDirs);
  for (const lock of Object.keys(merged.locks)) merged.locks[lock] = uniq(merged.locks[lock]);
  for (const [name, r] of Object.entries(merged.resources)) {
    if (r.serial !== undefined && typeof r.serial !== "boolean") {
      throw new Error(`${file}: resource "${name}".serial must be true/false`);
    }
    if (!Array.isArray(r.verify) || r.verify.length === 0 || !Number.isInteger(r.limit) || r.limit < 1) {
      throw new Error(`${file}: resource "${name}" needs verify (non-empty array of regexes) and limit (integer ≥ 1)`);
    }
  }
  for (const key of /** @type {const} */ (["linkDirs", "cloneDirs"])) {
    const list = merged.worker[key];
    if (!Array.isArray(list) || !list.every((/** @type {unknown} */ p) => typeof p === "string" && p !== "")) {
      throw new Error(`${file}: worker.${key} must be an array of paths (non-empty strings)`);
    }
  }
  const linked = new Set(merged.worker.linkDirs.map(normalizeRel));
  for (const rel of merged.worker.cloneDirs) {
    if (linked.has(normalizeRel(rel))) {
      throw new Error(`${file}: worker — path "${rel}" is in both linkDirs and cloneDirs`);
    }
  }
  if (!Number.isInteger(merged.workers) || merged.workers < 0) {
    throw new Error(`${file}: workers must be an integer ≥ 0`);
  }
  if (!Number.isInteger(merged.compactWindow) || merged.compactWindow < 1) {
    throw new Error(`${file}: compactWindow must be an integer > 0`);
  }
  const { port, tokenWarnPerTask } = merged.dashboard;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${file}: dashboard.port must be an integer 0–65535`);
  }
  if (tokenWarnPerTask !== null && !(Number.isInteger(tokenWarnPerTask) && tokenWarnPerTask > 0)) {
    throw new Error(`${file}: dashboard.tokenWarnPerTask must be an integer > 0 or null`);
  }
  const sc = merged.sessionChain;
  if (typeof sc.enabled !== "boolean") throw new Error(`${file}: sessionChain.enabled must be true/false`);
  if (!Number.isInteger(sc.maxContext) || sc.maxContext < 1) throw new Error(`${file}: sessionChain.maxContext must be an integer > 0`);
  if (!Number.isInteger(sc.maxGapMs) || sc.maxGapMs < 0) throw new Error(`${file}: sessionChain.maxGapMs must be an integer ≥ 0`);
  if (!["low", "medium", "high"].includes(sc.minRiskForSerial)) {
    throw new Error(`${file}: sessionChain.minRiskForSerial must be low | medium | high`);
  }
  const cs = merged.childSession;
  const rawCs = raw.childSession;
  if (rawCs !== undefined && (rawCs === null || typeof rawCs !== "object" || Array.isArray(rawCs))) {
    throw new Error(`${file}: childSession must be an object`);
  }
  for (const key of /** @type {const} */ (["strictMcp", "skills", "chrome", "toolsFromRole"])) {
    if (typeof cs[key] !== "boolean") throw new Error(`${file}: childSession.${key} must be true/false`);
  }
  if (merged.ci !== null) {
    const ci = merged.ci;
    if (typeof ci !== "object" || Array.isArray(ci)) throw new Error(`${file}: ci must be null or an object {workflow, branch, gate?}`);
    for (const key of /** @type {const} */ (["workflow", "branch"])) {
      if (typeof ci[key] !== "string" || ci[key].trim() === "") throw new Error(`${file}: ci.${key} must be a non-empty string`);
    }
    if (ci.gate !== "warn" && ci.gate !== "block") throw new Error(`${file}: ci.gate must be "warn" or "block"`);
  }
  for (const [lock, globs] of Object.entries(merged.locks)) {
    if (!Array.isArray(globs) || !globs.every((/** @type {unknown} */ g) => typeof g === "string" && g !== "")) {
      throw new Error(`${file}: locks."${lock}" must be an array of globs (non-empty strings)`);
    }
    // A-082: a `!glob` entry is an exclusion; on its own the lock matches nothing — a typo, don't guess.
    if (globs.length > 0 && globs.every((/** @type {string} */ g) => g.startsWith("!"))) {
      throw new Error(`${file}: locks."${lock}" has only exclusion globs (!…) — no positive glob`);
    }
  }
  for (const [key, value] of Object.entries(merged.headings)) {
    const ok = key === "bugSections"
      ? Array.isArray(value) && value.length > 0 && value.every((/** @type {unknown} */ v) => typeof v === "string" && v.trim() !== "")
      : typeof value === "string" && value.trim() !== "";
    if (!ok) throw new Error(`${file}: headings.${key} must be a non-empty ${key === "bugSections" ? "array of strings" : "string"}`);
  }
  const { typeKeywords, trailers } = merged.commit;
  const stringList = (/** @type {unknown} */ a) => Array.isArray(a) && a.every((x) => typeof x === "string" && x.trim() !== "");
  if (!typeKeywords || typeof typeKeywords !== "object" || Array.isArray(typeKeywords)
    || !Object.values(typeKeywords).every(stringList)) {
    throw new Error(`${file}: commit.typeKeywords must map a commit type to an array of non-empty strings`);
  }
  if (!Array.isArray(trailers) || !trailers.every((t) => typeof t === "string")) {
    throw new Error(`${file}: commit.trailers must be an array of strings`);
  }
  const { envVar, schemaParam } = merged.testDb;
  if (typeof envVar !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
    throw new Error(`${file}: testDb.envVar must be an environment variable name`);
  }
  if (typeof schemaParam !== "boolean") throw new Error(`${file}: testDb.schemaParam must be true/false`);
  if (merged.ci !== null && merged.ci.localHint !== undefined && merged.ci.localHint !== null
    && (typeof merged.ci.localHint !== "string" || merged.ci.localHint.trim() === "")) {
    throw new Error(`${file}: ci.localHint must be a non-empty string or null`);
  }
  for (const s of merged.skills) {
    if (!s.skill || s.globs.length + s.roots.length === 0) {
      throw new Error(`${file}: skill "${s.skill}" needs at least one glob or root`);
    }
  }
  return merged;
}

const ROLE_KINDS = ["developer", "evaluator", "reviewer", "fixer", "planner"];

/**
 * Validate a role's `when.diff` (A-090): reviewer roles only; `paths` a non-empty array of strings; every `added` compiles to a RegExp.
 * A broken regex is caught HERE (when the config is read), not mid-run in the conductor.
 * @param {any} diff @param {string} kind @param {string} name @param {string} file
 */
function checkWhenDiff(diff, kind, name, file) {
  if (kind !== "reviewer") throw new Error(`${file}: role "${name}" — when.diff only applies to roles of kind "reviewer"`);
  const strings = (/** @type {unknown} */ a) => Array.isArray(a) && a.every((x) => typeof x === "string" && x !== "");
  if (!diff || typeof diff !== "object" || !strings(diff.paths) || diff.paths.length === 0) {
    throw new Error(`${file}: role "${name}" — when.diff.paths needs a non-empty array of strings`);
  }
  if (diff.added === undefined) return;
  if (!strings(diff.added)) throw new Error(`${file}: role "${name}" — when.diff.added needs an array of strings (regexes)`);
  for (const pattern of diff.added) {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new Error(`${file}: role "${name}" — when.diff.added has an invalid regex ${JSON.stringify(pattern)}: ${/** @type {Error} */ (err).message}`);
    }
  }
}

/**
 * Validate + fill defaults for the role table. A role missing `kind`/`model` → THROW with the file path.
 * @param {Record<string, any>} roles @param {string} file @returns {Record<string, RoleRule>}
 */
function normalizeRoles(roles, file) {
  /** @type {Record<string, RoleRule>} */
  const out = {};
  for (const [name, r] of Object.entries(roles)) {
    if (!r || !ROLE_KINDS.includes(r.kind)) {
      throw new Error(`${file}: role "${name}" needs kind ∈ ${ROLE_KINDS.join(" | ")}`);
    }
    if (typeof r.model !== "string" || r.model.trim() === "") {
      throw new Error(`${file}: role "${name}" needs model (opus | sonnet | haiku)`);
    }
    if (r.when?.diff !== undefined) checkWhenDiff(r.when.diff, r.kind, name, file);
    const when = r.when ?? {};
    if (when.touches !== undefined) when.touches = uniq(when.touches);
    /** @type {RoleRule} */
    const rule = { kind: r.kind, when, skills: r.skills ?? [], writes: r.writes ?? [], model: r.model };
    if (r.bash !== undefined) {
      if (!Array.isArray(r.bash) || !r.bash.every((/** @type {unknown} */ b) => typeof b === "string" && /^Bash\(.+\)$/.test(b))) {
        throw new Error(`${file}: role "${name}" — bash needs an array of patterns shaped "Bash(npx vitest:*)"`);
      }
      rule.bash = r.bash;
    }
    if (r.modelByRound !== undefined) {
      const steps = Array.isArray(r.modelByRound) ? r.modelByRound : [null];
      for (const st of steps) {
        if (!st || !Number.isInteger(st.from) || st.from < 1 || typeof st.model !== "string" || st.model.trim() === "") {
          throw new Error(`${file}: role "${name}" — modelByRound needs [{from: integer ≥ 1, model}]`);
        }
      }
      rule.modelByRound = steps;
    }
    if (r.maxBudgetUsd !== undefined && r.maxBudgetUsd !== null) {
      if (typeof r.maxBudgetUsd !== "number" || !Number.isFinite(r.maxBudgetUsd) || r.maxBudgetUsd <= 0) {
        throw new Error(`${file}: role "${name}" — maxBudgetUsd must be a number > 0 or null`);
      }
      rule.maxBudgetUsd = r.maxBudgetUsd;
    } else if (r.maxBudgetUsd === null) {
      rule.maxBudgetUsd = null;
    }
    out[name] = rule;
  }
  return out;
}

/** `a/b/` and `./a/b` are the same path — for detecting overlap between linkDirs and cloneDirs. @param {string} rel */
function normalizeRel(rel) {
  return path.posix.normalize(rel).replace(/\/+$/, "");
}

/** Drop duplicates, keep first-occurrence order. Not an array → returned as is so the later type check reports it. @template T @param {T} list @returns {T} */
function uniq(list) {
  return Array.isArray(list) ? /** @type {T} */ (/** @type {unknown} */ ([...new Set(list)])) : list;
}

/** @template T @param {T} v @returns {T} */
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Regex "root string appears as a path segment": preceded by start of string or a
 * non-word character; followed by a non-word character (unless the root itself ends with `/`).
 * Matches `packages/api` in `cd packages/api && npm test` as well as `packages/api/src/a.ts`.
 * @param {string} root @returns {RegExp}
 */
export function rootRegExp(root) {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${esc}${root.endsWith("/") ? "" : "(?!\\w)"}`);
}
