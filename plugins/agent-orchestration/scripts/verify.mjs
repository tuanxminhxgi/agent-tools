// @ts-check
/**
 * LAYER 2 — the definition of "done", and the ONLY place in the whole system allowed
 * to conclude that a task is finished:
 *
 *   done  ⟺  every command in `verify:` exits 0  ∧  `manual:` is empty
 *
 * No other clause. No "the agent thinks it's fine", no "probably done".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.mjs";

/**
 * @typedef {Object} CheckResult
 * @property {string} command
 * @property {"passed"|"failed"|"skipped"} outcome
 * @property {number|null} exitCode
 * @property {string} output
 * @property {number} durationMs
 */

/**
 * Can commands that need a test DB run? Also checks the `.env` file declared in config,
 * because the test runner itself reads it — looking only at `process.env` would skip wrongly.
 * @returns {boolean}
 */
export function hasTestDatabase() {
  if (process.env[config.testDbEnvVar]) return true;
  // The project's .env file declared in config (`testDb.envFile`); if absent, look at env only.
  if (!config.testDbEnvFile) return false;
  try {
    const env = fs.readFileSync(config.testDbEnvFile, "utf8");
    return new RegExp(`^${config.testDbEnvVar}=.+$`, "m").test(env);
  } catch {
    return false;
  }
}

/** @param {string} text @param {number} keep */
function tail(text, keep) {
  return text.length <= keep ? text : `…(truncated)…\n${text.slice(-keep)}`;
}

/**
 * Name of the resource (in `disabledResources`) matching this command, if any — reuses
 * the same `resources.<name>.verify` patterns the scheduler (`schedule.mjs`) uses to
 * infer resources, so one declaration serves both.
 * @param {string} command
 * @param {string[]} disabledResources
 * @param {Record<string, {verify: string[]}>} resources
 * @returns {string|null}
 */
function disabledResourceFor(command, disabledResources, resources) {
  for (const name of disabledResources) {
    const resource = resources[name];
    if (resource?.verify.some((re) => new RegExp(re, "i").test(command))) return name;
  }
  return null;
}

/**
 * Run a command, collecting stdout+stderr, with a timeout.
 * @param {string} command
 * @param {{timeoutMs: number, cwd?: string}} options
 * @returns {Promise<{exitCode: number|null, output: string, timedOut: boolean}>}
 */
export function runCommand(command, options) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${output}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

/**
 * @param {import("./backlog.mjs").Task} task
 * @param {typeof config} [cfg]
 * @param {{manualOk?: boolean}} [options] `manualOk` = a HUMAN has checked and confirmed
 * @returns {Promise<{ok: boolean, results: CheckResult[], reason: string|null}>}
 */
export async function verifyTask(task, cfg = config, options = {}) {
  /** @type {CheckResult[]} */
  const results = [];

  if (task.verify.length === 0) {
    return { ok: false, results, reason: "task has no verify command" };
  }
  // A machine cannot check on a human's behalf. But a HUMAN can — and there must be
  // a way to say "I've looked", otherwise every task with `manual` could never be
  // closed through the tool. `--manual-ok` is a human action, not an agent's:
  // it is not part of any automated flow.
  if (task.manual.length > 0 && !options.manualOk) {
    return {
      ok: false,
      results,
      reason: `${task.manual.length} visual check(s) pending (a human confirms with --manual-ok)`,
    };
  }

  const deadline = Date.now() + cfg.verifyTimeoutMs;
  const testDb = hasTestDatabase();

  for (const command of task.verify) {
    // "Could not run" is NOT "ran and failed". Conflating the two sends the agent
    // off to fix something that isn't broken.
    const disabledBy = disabledResourceFor(command, cfg.disabledResources, cfg.resources);
    if (disabledBy) {
      results.push({
        command, outcome: "skipped", exitCode: null,
        output: `resource "${disabledBy}" is disabled via AGENT_QUEUE_DISABLE_RESOURCES`,
        durationMs: 0,
      });
      continue;
    }
    if (!testDb && cfg.needsTestDb.some((k) => command.includes(k))) {
      results.push({
        command, outcome: "skipped", exitCode: null,
        output: `${config.testDbEnvVar} is not set`, durationMs: 0,
      });
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({
        command, outcome: "failed", exitCode: null,
        output: "overall verify time budget exhausted", durationMs: 0,
      });
      continue;
    }

    const startedAt = Date.now();
    const run = await runCommand(command, {
      timeoutMs: Math.min(cfg.commandTimeoutMs, remaining),
    });
    results.push({
      command,
      outcome: run.exitCode === 0 && !run.timedOut ? "passed" : "failed",
      exitCode: run.exitCode,
      output: run.timedOut
        ? `${tail(run.output, cfg.outputTailChars)}\n(killed: timed out)`
        : tail(run.output, cfg.outputTailChars),
      durationMs: Date.now() - startedAt,
    });
  }

  const failed = results.filter((r) => r.outcome === "failed");
  const skipped = results.filter((r) => r.outcome === "skipped");

  if (failed.length > 0) {
    return { ok: false, results, reason: `${failed.length} verify command(s) failed` };
  }
  if (skipped.length > 0) {
    // Merge the reasons (missing TEST_DATABASE_URL, or a disabled resource) into one sentence —
    // deduplicated, since several commands can share a reason.
    const reasons = [...new Set(skipped.map((r) => r.output))];
    return {
      ok: false, results,
      reason: `${skipped.length} command(s) could not run (${reasons.join("; ")})`,
    };
  }
  return { ok: true, results, reason: null };
}
