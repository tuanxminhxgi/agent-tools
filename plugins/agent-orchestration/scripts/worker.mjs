// @ts-check
/**
 * WORKER — one parallel task running in its own worktree, with its own test DB and
 * e2e ports. Design: docs/agent-orchestration.md §3.
 *
 * Three things MUST be separate per worker; miss one and tests turn flaky and agents
 * go "fix" things that aren't broken:
 *   - code tree: `.claude/worktrees/<id>` on branch `agent/<id>`;
 *   - test DB: same database, own schema `agent_w<n>` (TEST_DATABASE_URL, E2E_SCHEMA);
 *   - e2e ports: 3100 + 10·n (web), +1 (API).
 *
 * The session store `.claude/agent-queue.json` is a path RELATIVE to the project root,
 * so each worktree has its own store — no extra mechanism needed.
 *
 * A task assigned to a worker carries `owner: worker:w<n>` in its task file in the MAIN
 * worktree. Hooks and `currentTask` in the main worktree skip such tasks: they are
 * verified in their own worktree, by the integrator.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const WORKER_OWNER_PREFIX = "worker:";

/** @param {string} id */
export const branchName = (id) => `agent/${id}`;

/** @param {string} root @param {string} id */
export const worktreePath = (root, id) => path.join(root, ".claude", "worktrees", id);

/** @param {string|null} owner @returns {boolean} */
export const isWorkerOwned = (owner) => owner !== null && owner.startsWith(WORKER_OWNER_PREFIX);

/** @param {number} slot */
export const workerOwner = (slot) => `${WORKER_OWNER_PREFIX}w${slot}`;

/**
 * Slot number in `owner: worker:w<n>`; not a worker owner (or n < 1) → null.
 * @param {string|null} owner @returns {number|null}
 */
export function slotOfOwner(owner) {
  const m = owner === null ? null : /^worker:w(\d+)$/.exec(owner);
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
}

/**
 * Free slots, lowest first — deterministic.
 * @param {number[]} used @param {number} workers @returns {number[]}
 */
export function freeSlots(used, workers) {
  const taken = new Set(used);
  const out = [];
  for (let n = 1; n <= workers; n += 1) if (!taken.has(n)) out.push(n);
  return out;
}

/**
 * Point a Postgres URL at its own `schema`, for BOTH kinds of URL reader:
 *   - `schema=<s>` — ORM tooling that reads this parameter (e.g. Prisma's migration engine);
 *   - `options=-c search_path=<s>` — the plain `pg` driver (also used by ORM driver adapters at test time)
 *     IGNORES `schema=`; only `search_path` routes queries into the right schema.
 * With only `schema=`, migrations create tables in `<s>` but tests still run on `public` — every
 * worker writes to the same place (measured on Postgres 16, 2026-09-26: `current_schema()` = public).
 * Existing `options` are kept, an old `search_path` is replaced. All other parameters are kept.
 * @param {string} url @param {string} schema @returns {string}
 */
export function withSchema(url, schema, schemaParam = true) {
  const [base, query = ""] = url.split("?");
  const parts = query.split("&").filter((p) => p !== "");
  const kept = parts.filter((p) => !p.startsWith("schema=") && !p.startsWith("options="));
  const oldOptions = parts.find((p) => p.startsWith("options="));
  const flags = oldOptions
    ? decodeURIComponent(oldOptions.slice("options=".length)).replace(/-c\s*search_path=\S+/g, "").trim()
    : "";
  const options = `${flags ? `${flags} ` : ""}-c search_path=${schema}`;
  return `${base}?${[...kept, ...(schemaParam ? [`schema=${schema}`] : []), `options=${encodeURIComponent(options)}`].join("&")}`;
}

/**
 * Environment variables specific to worker `slot`. PURE FUNCTION.
 * @param {number} slot
 * @param {{testDatabaseUrl?: string|null, portBase?: number, testDbEnvVar?: string, schemaParam?: boolean}} [options]
 *        `testDbEnvVar`/`schemaParam` come from `testDb` in the project config (defaults: TEST_DATABASE_URL, true)
 * @returns {Record<string, string>}
 */
export function workerEnv(slot, options = {}) {
  const portBase = options.portBase ?? 3100;
  const schema = `agent_w${slot}`;
  /** @type {Record<string, string>} */
  const env = {
    AGENT_QUEUE_ROLE: "worker",
    AGENT_QUEUE_WORKER: `w${slot}`,
    // Workers never commit/push: the integrator merges serially in the main worktree.
    AGENT_QUEUE_COMMIT: "0",
    AGENT_QUEUE_PUSH: "0",
    E2E_WEB_PORT: String(portBase + 10 * slot),
    E2E_API_PORT: String(portBase + 10 * slot + 1),
    E2E_SCHEMA: schema,
  };
  if (options.testDatabaseUrl) {
    env[options.testDbEnvVar ?? "TEST_DATABASE_URL"] = withSchema(options.testDatabaseUrl, schema, options.schemaParam ?? true);
  }
  return env;
}

/**
 * Mask the password in every `scheme://user:pass@host` URL — used when PRINTING env to the
 * screen or a log. The full value only lives in the worker's env file (gitignored).
 * @param {string} value @returns {string}
 */
export function maskSecrets(value) {
  return value.replace(/(\/\/[^:/@\s]+):[^@\s]+@/g, "$1:***@");
}

/**
 * The worker's env file: OUTSIDE the worktree (the worker cannot commit it by accident) and inside
 * the gitignored `.claude/worktrees/`.
 * @param {string} root @param {string} id
 */
export const envFilePath = (root, id) => path.join(root, ".claude", "worktrees", `${id}.env`);

/**
 * @param {Record<string, string>} env @returns {string} content shaped `export K="v"`
 */
export function renderEnv(env) {
  return Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") + "\n";
}

/**
 * Read one key from a `.env` file. No file / no key → null.
 * @param {string} file @param {string} key @returns {string|null}
 */
export function readDotenv(file, key) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * @param {string} cwd @param {string[]} args
 * @returns {{ok: boolean, out: string}}
 */
export function runGit(cwd, args) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

/**
 * Parse `git worktree list --porcelain` output, keeping only worktrees DIRECTLY under `dir`
 * (`.claude/worktrees/`). PURE FUNCTION. The main worktree and worktrees elsewhere are dropped.
 * @param {string} text @param {string} dir
 * @returns {{id: string, path: string, branch: string}[]}  `branch` empty when HEAD is detached
 */
export function parseWorktrees(text, dir) {
  /** @type {{id: string, path: string, branch: string}[]} */
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (wt === undefined || path.dirname(wt) !== dir) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? "";
    out.push({ id: path.basename(wt), path: wt, branch: ref.replace(/^refs\/heads\//, "") });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Worker worktrees that actually exist (directory still on disk) under `.claude/worktrees/`.
 * `git` prints symlink-resolved paths (macOS: /var → /private/var), so compare by realpath.
 * @param {string} root @returns {{id: string, path: string, branch: string}[]}
 */
export function listWorktrees(root) {
  const r = runGit(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const real = fs.realpathSync(root);
  return parseWorktrees(r.out, path.join(real, ".claude", "worktrees"))
    .filter((w) => fs.existsSync(w.path))
    .map((w) => ({ ...w, path: worktreePath(root, w.id) }));
}

/**
 * Orphan worktrees: no backlog task has that id, or the task is `done` but the worktree remains.
 * A `todo` task with a worktree is NOT an orphan — it was just `release`d and will reuse it when rescheduled. PURE FUNCTION.
 * @param {Map<string, {status: string}>} backlog @param {string[]} ids @returns {string[]}
 */
export function orphanWorktrees(backlog, ids) {
  return ids.filter((id) => {
    const status = backlog.get(id)?.status;
    return status === undefined || status === "done";
  }).sort();
}

/**
 * Create the task's worktree on a new branch from `base`. Already exists → reuse it.
 * @param {string} root @param {string} id @param {string} [base]
 * @returns {{path: string, branch: string, created: boolean}}
 */
export function createWorktree(root, id, base = "HEAD") {
  const dir = worktreePath(root, id);
  const branch = branchName(id);
  if (fs.existsSync(dir)) return { path: dir, branch, created: false };
  const r = runGit(root, ["worktree", "add", "-b", branch, dir, base]);
  if (!r.ok) throw new Error(`Could not create worktree for ${id}: ${r.out}`);
  return { path: dir, branch, created: true };
}

/**
 * Symlink dependency directories (gitignored) from the main worktree into the worker's
 * worktree (A-018). A fresh worktree has NO `node_modules` — without it no test command
 * runs; reinstalling costs ~1 GB per worker. Lockfiles are identical because parallel
 * tasks never hold the `lockfile` lock.
 *
 * Also accepts gitignored FILES that tests need (e.g. a `.env` from which app config requires `DATABASE_URL`
 * and e2e learns how to reach the DB — without it every such task in the parallel lane goes red, T-232/T-235 2026-09-27).
 * Source missing → skipped (no dangling symlink). Destination already present → left alone.
 * @param {string} root @param {string} worktree @param {string[]} dirs
 * @returns {{linked: string[], skipped: string[]}}
 */
export function linkDependencies(root, worktree, dirs) {
  /** @type {{linked: string[], skipped: string[]}} */
  const out = { linked: [], skipped: [] };
  for (const rel of dirs) {
    const src = path.join(root, rel);
    const dst = path.join(worktree, rel);
    if (!fs.existsSync(src) || lstatOrNull(dst) !== null) {
      out.skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? "dir" : "file");
    out.linked.push(rel);
  }
  return out;
}

/**
 * Remove only entries that are SYMLINKS. A real directory (e.g. someone ran `npm install` in the
 * worktree) is left alone and reported — never delete along a path that goes through a symlink.
 * @param {string} worktree @param {string[]} dirs
 * @returns {{removed: string[], kept: string[]}}
 */
export function unlinkDependencies(worktree, dirs) {
  /** @type {{removed: string[], kept: string[]}} */
  const out = { removed: [], kept: [] };
  for (const rel of dirs) {
    const dst = path.join(worktree, rel);
    const st = lstatOrNull(dst);
    if (st === null) continue;
    if (st.isSymbolicLink()) {
      fs.unlinkSync(dst);
      out.removed.push(rel);
    } else {
      out.kept.push(rel);
    }
  }
  return out;
}

/** @param {string} p @returns {fs.Stats|null} */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Fast (copy-on-write) copy command per OS: macOS/APFS `cp -c`, Linux `cp --reflink=auto`.
 * @param {string} platform @param {string} src @param {string} dst @returns {{cmd: string, args: string[]}}
 */
function cloneCommand(platform, src, dst) {
  return platform === "darwin"
    ? { cmd: "cp", args: ["-cR", src, dst] }
    : { cmd: "cp", args: ["-R", "--reflink=auto", src, dst] };
}

/**
 * `rel` must be a relative path INSIDE `worktree` (no `..`, not absolute). Returns the absolute destination path.
 * @param {string} worktree @param {string} rel @returns {string}
 */
function insideWorktree(worktree, rel) {
  const base = path.resolve(worktree);
  const dst = path.resolve(base, rel);
  const within = path.relative(base, dst);
  if (within === "" || within.startsWith("..") || path.isAbsolute(within)) {
    throw new Error(`Path "${rel}" is not inside worktree ${worktree}`);
  }
  return dst;
}

/**
 * Delete ONE real directory inside the worktree. Refuses if the target is a symlink or if its parent
 * (after resolving symlinks) falls outside the worktree — never delete along a path through a symlink.
 * @param {string} worktree @param {string} dst absolute path already checked by `insideWorktree`
 * @returns {boolean} deleted
 */
function removeRealDirInside(worktree, dst) {
  const st = lstatOrNull(dst);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) return false;
  const realWt = fs.realpathSync(worktree);
  const realParent = fs.realpathSync(path.dirname(dst));
  if (realParent !== realWt && !realParent.startsWith(realWt + path.sep)) return false;
  fs.rmSync(dst, { recursive: true, force: true });
  return true;
}

/**
 * Copy dependency directories (gitignored) from the main worktree into the worker's worktree (A-081),
 * for tools that reject symlinks pointing outside the project (e.g. Turbopack with a symlinked `node_modules`, T-235/T-236).
 * Copy-on-write (APFS/btrfs/xfs): 548 MB takes ~6 seconds and uses no extra space until a file is modified.
 *
 * Clone command exits ≠ 0 (filesystem unsupported) → remove the partial copy, then copy normally with `fs.cpSync`,
 * keeping inner symlinks (`.bin/`) as is; the name goes into `slow`. The copy carries the SessionStart hook's
 * `.session-start.json`, so the hook sees a REAL directory matching the lockfile hash and skips `npm ci`.
 * Source missing → skipped. Destination already present (even a symlink) → left alone.
 * @param {string} root @param {string} worktree @param {string[]} dirs
 * @param {{exec?: (cmd: string, args: string[]) => void, platform?: string}} [deps]  injectable for tests
 * @returns {{cloned: string[], skipped: string[], slow: string[]}}
 */
export function cloneDependencies(root, worktree, dirs, deps = {}) {
  const exec = deps.exec ?? ((/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  });
  const platform = deps.platform ?? process.platform;
  /** @type {{cloned: string[], skipped: string[], slow: string[]}} */
  const out = { cloned: [], skipped: [], slow: [] };
  for (const rel of dirs) {
    const src = path.join(root, rel);
    const dst = insideWorktree(worktree, rel);
    if (!fs.existsSync(src) || lstatOrNull(dst) !== null) {
      out.skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      const { cmd, args } = cloneCommand(platform, src, dst);
      exec(cmd, args);
    } catch {
      removeRealDirInside(worktree, dst);
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      out.slow.push(rel);
    }
    out.cloned.push(rel);
  }
  return out;
}

/**
 * Delete copied directories. ONLY deletes when the target is inside `worktree` and is NOT a symlink
 * (symlinks are removed by `unlinkDependencies`). A parent that is a symlink leaving the worktree is not touched either.
 * @param {string} worktree @param {string[]} dirs
 * @returns {{removed: string[], kept: string[]}}
 */
export function removeClonedDependencies(worktree, dirs) {
  /** @type {{removed: string[], kept: string[]}} */
  const out = { removed: [], kept: [] };
  for (const rel of dirs) {
    let dst;
    try {
      dst = insideWorktree(worktree, rel);
    } catch {
      out.kept.push(rel);
      continue;
    }
    if (lstatOrNull(dst) === null) continue;
    if (removeRealDirInside(worktree, dst)) out.removed.push(rel);
    else out.kept.push(rel);
  }
  return out;
}

/**
 * Clean up the worktree and branch. Only call AFTER merging (or when deliberately dropping the task).
 * Dependency symlinks are removed BEFORE `git worktree remove --force`, so that heavy-handed delete
 * never faces a symlink pointing at the real `node_modules`. Then the copied directories are
 * deleted (A-081) — only real directories inside the worktree.
 * @param {string} root @param {string} id @param {string[]} [linkDirs] @param {string[]} [cloneDirs]
 */
export function removeWorktree(root, id, linkDirs = [], cloneDirs = []) {
  const dir = worktreePath(root, id);
  if (fs.existsSync(dir)) {
    // cloneDirs also go through the unlink step: a worktree built before a config change may still have symlinks there.
    unlinkDependencies(dir, [...linkDirs, ...cloneDirs]);
    removeClonedDependencies(dir, cloneDirs);
    runGit(root, ["worktree", "remove", "--force", dir]);
  }
  runGit(root, ["branch", "-D", branchName(id)]);
}
