// @ts-check
/**
 * One place for the configuration of all three tiers. Every value can be overridden by an
 * environment variable — changing how it runs never means changing code.
 *
 * PROJECT-SPECIFIC rules (money keywords, migrations, skills, .env file…) do NOT live
 * here but in the project's `.claude/agent-queue.config.json` (P-001) — see
 * `project-config.mjs`. Precedence: environment variable > project file > generic default.
 */
import { loadProjectConfig } from "./project-config.mjs";

const project = loadProjectConfig();

/** @param {string} name @param {number} fallback */
function num(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  /** Project name, used in prompts ("read the section that applies to repo <name>"). */
  projectName: project.projectName,
  /** How to invoke the CLI, printed for humans/agents. */
  cliHint: project.cliHint,
  /** Headings that are part of the task/bug/question file format (see `Headings` in project-config.mjs). */
  headings: project.headings,
  tasksDir: "tasks",
  /** Planner input — one requirement per file (template: requirements/README.md). */
  requirementsDir: "requirements",
  indexFile: "tasks/INDEX.md",
  storeFile: ".claude/agent-queue.json",
  logFile: ".claude/agent-queue.log",

  /** Tier 2 — timeouts for check commands. */
  commandTimeoutMs: num("AGENT_QUEUE_CMD_TIMEOUT_MS", 10 * 60_000),
  verifyTimeoutMs: num("AGENT_QUEUE_VERIFY_TIMEOUT_MS", 20 * 60_000),
  /**
   * A task's reviewers run CONCURRENTLY (read-only, non-blocking, none reads another's output) instead of
   * one after another. `AGENT_QUEUE_PARALLEL_REVIEWERS=0` goes back to one role at a time.
   */
  parallelReviewers: process.env.AGENT_QUEUE_PARALLEL_REVIEWERS !== "0",
  /** Keep this many TRAILING characters of output — the tail is where errors are reported. */
  outputTailChars: num("AGENT_QUEUE_OUTPUT_CHARS", 4000),

  /** Tier 2 — gate rules. */
  gatesEnabled: process.env.AGENT_QUEUE_GATES !== "off",
  moneyKeywords: process.env.AGENT_QUEUE_MONEY_KEYWORDS !== undefined
    ? process.env.AGENT_QUEUE_MONEY_KEYWORDS.split(",").filter((k) => k.trim() !== "")
    : project.risk.moneyKeywords,
  migrationPaths: project.risk.migrationPaths,
  /** Risk inferred from paths (regexes, case-insensitive): high · medium. */
  highRiskPatterns: project.risk.highPatterns,
  mediumRiskPatterns: project.risk.mediumPatterns,
  /** Skill table SHARED by `skillsFor` (task assignment) and the skill-reminder hook (file edits). */
  skills: project.skills,
  /** Domains inferred from paths, in addition to the skills' domains. */
  domains: project.domains,
  /** Commands containing any of these strings need TEST_DATABASE_URL to run. */
  needsTestDb: project.testDb.commands,
  /** .env file that may hold TEST_DATABASE_URL (null = environment variables only). */
  testDbEnvFile: project.testDb.envFile,
  /** Name of the variable holding the test-DB URL. */
  testDbEnvVar: project.testDb.envVar,
  /** Also add `schema=<s>` (Prisma-style) to each worker's test-DB URL. */
  testDbSchemaParam: project.testDb.schemaParam,
  /** Commit message rules: type keywords + trailers. */
  commit: project.commit,
  /**
   * Resources DISABLED by name (matching `resources.<name>.verify` — e.g. `e2e-stack`).
   * A verify command matching the pattern of a resource in this list is marked
   * "skipped" instead of actually run — same as the existing "missing TEST_DATABASE_URL"
   * case, so the task still can NOT be closed (per "done ⟺ every verify: command exits 0"),
   * it just doesn't waste time/resources waiting on a suite known not to run yet.
   * `AGENT_QUEUE_DISABLE_RESOURCES=e2e-stack` (several names, comma-separated).
   */
  disabledResources: (process.env.AGENT_QUEUE_DISABLE_RESOURCES ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== ""),

  /**
   * Tier 3 — commit each time a task is confirmed done.
   * `protectedBranches` defaults to EMPTY: for a single-developer repo, blocking `main`
   * means the feature never runs and people switch the guard off right away. Teams
   * set `AGENT_QUEUE_PROTECTED_BRANCHES=main,production`.
   */
  commitEnabled: process.env.AGENT_QUEUE_COMMIT !== "0",
  pushEnabled: process.env.AGENT_QUEUE_PUSH === "1",
  protectedBranches: (process.env.AGENT_QUEUE_PROTECTED_BRANCHES ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b !== ""),

  /**
   * Orchestration — diff thresholds by task size (docs/agent-orchestration.md §2).
   * Exceeding the declared size's threshold signals a wrong analysis → `escalate`. XL has
   * no ceiling: it is already the top level, nowhere left to climb.
   */
  /** Files not counted toward diff thresholds — tests, docs, generated files (A-016). */
  diffIgnore: project.diffIgnore,
  diffLimits: {
    S: { lines: num("AGENT_QUEUE_DIFF_S_LINES", 150), files: num("AGENT_QUEUE_DIFF_S_FILES", 3) },
    M: { lines: num("AGENT_QUEUE_DIFF_M_LINES", 600), files: num("AGENT_QUEUE_DIFF_M_FILES", 12) },
    L: { lines: num("AGENT_QUEUE_DIFF_L_LINES", 2000), files: num("AGENT_QUEUE_DIFF_L_FILES", 40) },
  },

  /**
   * Orchestration — parallel lanes (docs/agent-orchestration.md §3). Number of workers
   * running concurrently, NOT counting the serial lane (which runs on the main worktree).
   */
  workers: num("AGENT_QUEUE_WORKERS", project.workers),
  /** Auto-compact window (tokens) of every `claude -p` session the conductor opens (A-075) — not the session-resume threshold. */
  compactWindow: project.compactWindow,
  /** CI workflow watched for INBOX + conductor (A-079); `null` = off. `AGENT_QUEUE_CI_STATUS=0` is a quick off switch in `ci-status.mjs`. */
  ci: project.ci,
  /** A worker running longer than this many minutes is stopped and its task goes back to `todo` (A-024); the worktree is kept. */
  workerTimeoutMin: num("AGENT_QUEUE_WORKER_TIMEOUT_MIN", 90),
  /** Countable resources, inferred from verify commands (A-019) — e.g. at most one e2e suite at a time. */
  resources: project.resources,
  /** Orchestration role table (A-020) — `roleChain` evaluates only this table. */
  roles: project.roles,
  /** Dependency directories symlinked into worker worktrees (A-018) — no repeated `npm install`. */
  workerLinkDirs: project.worker.linkDirs,
  /** Dependency directories COPIED (copy-on-write) into worker worktrees — for tools that reject symlinks leaving the project (A-081). */
  workerCloneDirs: project.worker.cloneDirs,
  /**
   * Exclusive locks inferred from `touches`: tasks touching these globs go to the serial lane,
   * one task at a time. The `money` lock comes not from paths but from `gate: money`.
   */
  lockRules: project.locks,

  /** Tier 3 — loop safety guards. */
  maxChain: num("AGENT_QUEUE_MAX_CHAIN", 5),
  /** Number of CONSECUTIVE red verifies on the same task before giving up (→ failed). */
  maxRetries: num("AGENT_QUEUE_MAX_RETRIES", 2),

  /**
   * Single-session chain by risk (A-052) — `.claude/agent-queue.config.json` → `sessionChain`. OFF by default since A-083
   * (resuming across tasks costs ~4x without saving turns); the rerun-after-red-verify path (A-053) does not depend on this flag.
   * `AGENT_QUEUE_SESSION_CHAIN=0` forces `enabled` to false (when the repo config turns it back on): medium tasks run in parallel, one fresh session each.
   */
  sessionChain: {
    ...project.sessionChain,
    enabled: process.env.AGENT_QUEUE_SESSION_CHAIN === "0" ? false : project.sessionChain.enabled,
  },
  /** What a child `claude -p` session loads (A-087) — `.claude/agent-queue.config.json` → `childSession`; `AGENT_QUEUE_CHILD_FULL=1` drops the lean flags. */
  childSession: project.childSession,
  disabled: process.env.AGENT_QUEUE_DISABLE === "1",
};

export const STATUSES = /** @type {const} */ ([
  "todo", "doing", "blocked", "done", "failed", "needs-human",
  // Orchestration (docs/agent-orchestration.md): planner writing · awaiting a human answer · awaiting bug fixes.
  "draft", "needs-decision", "waiting-bugs",
]);

export const GATES = /** @type {const} */ (["none", "money", "migration", "manual"]);

/**
 * Result of the orchestration analysis, packed into front-matter for machines — see
 * `docs/agent-orchestration.md` §1. Array order is ascending order.
 */
export const COMPLEXITIES = /** @type {const} */ (["S", "M", "L", "XL"]);
export const RISKS = /** @type {const} */ (["low", "medium", "high"]);
export const PATTERNS = /** @type {const} */ ([
  "auto", "single", "pipeline", "router", "planner-executor", "hierarchical",
]);

/** Bug file `tasks/B-<parent without dash>-<n>-<slug>.md` — §6 of the design. */
export const BUG_STATUSES = /** @type {const} */ (["open", "fixing", "fixed", "needs-human"]);
export const SEVERITIES = /** @type {const} */ (["critical", "high", "medium", "low"]);
export const BUG_FINDERS = /** @type {const} */ (["qa", "security", "integrator"]);

/** Questions the planner needs a human to decide — `tasks/questions/Q-xxx-<slug>.md`. */
export const QUESTION_STATUSES = /** @type {const} */ (["open", "answered", "closed"]);
