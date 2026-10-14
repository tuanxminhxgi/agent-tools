// @ts-check
/**
 * LAYER 3 — ALL of the loop's decision logic, as PURE FUNCTIONS.
 *
 * Deliberately separated from side effects: if decisions lived inside the hook file,
 * Layer 3 would be the only layer nobody could test. Here every branch is testable
 * with `node --test`, without spinning up a real Claude session.
 *
 * Two phases, because running verify commands is a side effect and some branches don't need it:
 *   decidePre  — is it worth running the verify commands?
 *   decidePost — they ran; how do we proceed?
 *
 * LOOP GUARD (A-015). The first version relied on Claude Code's `stop_hook_active` flag —
 * but that flag is set on EVERY stop right after a hook block, so the hook exited before
 * settling the task just finished: the chain advanced one task per human message.
 * Replaced by two capped counters. Invariant: EVERY `block` branch increments a counter —
 *   - claim a new task → `chained` (cap AGENT_QUEUE_MAX_CHAIN);
 *   - demand a fix     → `failCount` (cap AGENT_QUEUE_MAX_RETRIES).
 * So the loop is always bounded without the flag.
 */

/**
 * The `doing` task that THIS SESSION's Stop hook may settle. PURE FUNCTION.
 *
 * The first version took the first `doing` task regardless of holder — so one session's hook
 * verified, committed and chained another session's or the conductor's task (incident 2026-09-26:
 * a conductor child session settled A-023 midway, then claimed A-024 itself). Now it only takes:
 *   - a task whose `owner` equals the session's `session_id` (the `claim` hook and CLI `start` write it);
 *   - an unheld task: `owner` empty or `local-*` (CLI `start` run outside Claude Code).
 * `conductor`, `worker:*` and other session ids → skipped, returned in `skipped` for logging.
 * @template {{id: string, owner: string|null}} T
 * @param {T[]} doing @param {string|null} sessionId
 * @returns {{current: T|null, skipped: T[]}}
 */
export function pickOwnTask(doing, sessionId) {
  const mine = sessionId ? doing.find((t) => t.owner === sessionId) : undefined;
  const current = mine ?? doing.find((t) => isUnowned(t.owner)) ?? null;
  return { current, skipped: doing.filter((t) => t !== current && !isUnowned(t.owner) && t.owner !== sessionId) };
}

/** @param {string|null} owner */
function isUnowned(owner) {
  return owner === null || owner === "" || owner.startsWith("local-");
}

/**
 * @typedef {Object} PreInput
 * @property {boolean} disabled        AGENT_QUEUE_DISABLE=1
 * @property {string|null} currentId   task currently `doing`, null = none
 */

/**
 * @param {PreInput} input
 * @returns {{action: "exit"|"verify", reason: string|null}}
 */
export function decidePre(input) {
  if (input.disabled) {
    return { action: "exit", reason: "AGENT_QUEUE_DISABLE=1" };
  }
  // An ordinary session, not a backlog run — leave it alone.
  if (input.currentId === null) {
    return { action: "exit", reason: "no task in progress" };
  }
  return { action: "verify", reason: null };
}

/**
 * @typedef {Object} PostInput
 * @property {string} currentId
 * @property {{ok: boolean, reason: string|null, failures: Array<{command: string, output: string}>}} verify
 * @property {string[]} [manual]     visual checks of the current task
 * @property {number} [failCount]    consecutive failures, INCLUDING this one (when failing)
 * @property {number} [maxRetries]
 * @property {{id: string, title: string, prompt: string}|null} next
 * @property {{gated: boolean, reason: string|null}|null} nextGate  the next task's before-start gate
 * @property {number} chained
 * @property {number} maxChain
 * @property {{reason: string}|null} [ciClosed]  CI gate closed (A-084): don't load the next task; absent/null = open
 */

/**
 * @typedef {Object} PostDecision
 * @property {"exit"|"block"} action
 * @property {boolean} markDone    → done (only when no visual check remains)
 * @property {boolean} markGate    → needs-human: automated part green, human checks remain
 * @property {boolean} markFailed  → failed: failed more times than allowed
 * @property {string|null} claim
 * @property {string} reason
 */

/**
 * @param {PostInput} input
 * @returns {PostDecision}
 */
export function decidePost(input) {
  const manual = input.manual ?? [];
  const failCount = input.failCount ?? 1;
  const maxRetries = input.maxRetries ?? 2;
  const none = { markDone: false, markGate: false, markFailed: false, claim: null };

  if (!input.verify.ok) {
    const detail = input.verify.failures
      .map((f) => `$ ${f.command}\n${f.output}`)
      .join("\n\n");
    if (failCount > maxRetries) {
      return {
        ...none,
        action: "exit",
        markFailed: true,
        reason:
          `Task ${input.currentId} failed ${failCount} times in a row (cap AGENT_QUEUE_MAX_RETRIES=${maxRetries}) ` +
          `→ failed, chain stopped. Retrying the same way won't help — needs a human look or a task split.\n\n${detail}`,
      };
    }
    // Mark NOTHING, do NOT move to another task. Hand the agent the verbatim errors.
    return {
      ...none,
      action: "block",
      reason:
        `Task ${input.currentId} not passing yet (attempt ${failCount}/${maxRetries + 1}): ${input.verify.reason}\n\n${detail}\n\n` +
        `Fix it, then end your turn again. Do not edit the \`status\` field yourself — the verifier does that.`,
    };
  }

  // Automated part green. Visual checks remain → needs-human, but the chain STILL
  // moves on to another task: never stop to wait for a human.
  const settle = manual.length > 0
    ? { markDone: false, markGate: true, head: `Automated part of ${input.currentId} is green — awaiting your check: ${manual[0]}.` }
    : { markDone: true, markGate: false, head: `Done ${input.currentId}.` };
  const base = { markDone: settle.markDone, markGate: settle.markGate, markFailed: false };

  if (input.next === null) {
    return { ...base, action: "exit", claim: null, reason: `${settle.head} No ready tasks left.` };
  }

  // A-084: CI gate closed — this task is still settled and committed (not pushed, by `commitTask`), but the next task is not loaded.
  if (input.ciClosed) {
    return {
      ...base,
      action: "exit",
      claim: null,
      reason: `${settle.head} Not chaining further: ${input.ciClosed.reason}`,
    };
  }

  if (input.nextGate?.gated) {
    return {
      ...base,
      action: "exit",
      claim: null,
      reason: `${settle.head} Stopped at ${input.next.id} — needs your approval before starting: ${input.nextGate.reason}`,
    };
  }

  if (input.chained + 1 > input.maxChain) {
    return {
      ...base,
      action: "exit",
      claim: null,
      reason:
        `${settle.head} Chained ${input.chained} task(s) in this session, ` +
        `stopping at cap AGENT_QUEUE_MAX_CHAIN=${input.maxChain}.`,
    };
  }

  return {
    ...base,
    action: "block",
    claim: input.next.id,
    reason: `${settle.head} Next task:\n\n${input.next.prompt}`,
  };
}
