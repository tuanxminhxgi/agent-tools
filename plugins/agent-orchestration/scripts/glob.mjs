// @ts-check
/**
 * MINIMAL glob matching for `touches:` — hand-written because `scripts/agent-queue/`
 * uses no external libraries (decision Q-D in docs/agent-task-queue.md).
 *
 * Understands exactly what task files use:
 *   `**`  matches 0..n directory segments
 *   `*`   matches any characters WITHIN one segment (not across `/`)
 *   everything else is literal — a path without wildcards matches exactly
 *
 * A-010 added `globsOverlap` here for the lane scheduler.
 */

/** @param {string} glob @returns {RegExp} */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` also matches "no directory"; a trailing `**` matches everything left.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** @param {string} glob @param {string} file @returns {boolean} */
export function matchGlob(glob, file) {
  return globToRegExp(glob).test(file);
}

/** @param {string[]} globs @param {string} file @returns {boolean} */
export function matchAny(globs, file) {
  return globs.some((g) => matchGlob(g, file));
}

/**
 * CAN two globs match the same file? Used by the lane scheduler (A-010):
 * two tasks whose `touches` overlap must not run in parallel.
 *
 * Deliberately CONSERVATIVE: when unsure, return `true`. A wrong "overlaps" only
 * costs a chance to parallelise; a wrong "disjoint" means two agents edit the same
 * file in two worktrees and break at merge time.
 *
 * Compares segment by segment; `**` is tried at every alignment (eats 0..n segments):
 *   - two different literal segments → no match (different branches of the tree);
 *   - one side has `*` → match that segment against the other's literal;
 *   - both have `*` → treated as a match (conservative);
 *   - both run out together → overlap; one side has a non-`**` segment left → disjoint.
 *
 * `**` is NOT "overlaps everything": the glob "`**` then `package.json`" only matches
 * files named package.json. Treating it as overlapping everything would make every task
 * hold the `lockfile` lock and kill the parallel lane (a real bug, caught by A-010's tests).
 *
 * @param {string} a @param {string} b @returns {boolean}
 */
export function globsOverlap(a, b) {
  return overlapFrom(a.split("/"), 0, b.split("/"), 0);
}

/** @param {string[]} sa @param {number} i @param {string[]} sb @param {number} j @returns {boolean} */
function overlapFrom(sa, i, sb, j) {
  if (i === sa.length && j === sb.length) return true;
  if (sa[i] === "**" && sb[j] === "**") return true;
  if (sa[i] === "**") {
    // `**` eats 0 segments, or eats one of the other side's segments and retries.
    return overlapFrom(sa, i + 1, sb, j) || (j < sb.length && overlapFrom(sa, i, sb, j + 1));
  }
  if (sb[j] === "**") {
    return overlapFrom(sa, i, sb, j + 1) || (i < sa.length && overlapFrom(sa, i + 1, sb, j));
  }
  if (i === sa.length || j === sb.length) return false;
  const x = sa[i];
  const y = sb[j];
  const wx = x.includes("*");
  const wy = y.includes("*");
  const same = wx && wy ? true
    : wx ? globToRegExp(x).test(y)
    : wy ? globToRegExp(y).test(x)
    : x === y;
  return same && overlapFrom(sa, i + 1, sb, j + 1);
}

/**
 * Does a `touches` entry DECLARE that it edits files under a lock's glob (A-080)? PURE FUNCTION.
 *
 * Differs from `globsOverlap` in ONE place, and only for "anywhere" lock globs (first segment is `**`,
 * e.g. `**` + `/package.json`, `**` + `/i18n/**`): a `**` segment of `touch` may not stand in for a
 * LITERAL segment of the lock glob. `packages/ui/**` only says "I edit something under packages/ui",
 * not "I edit package.json" — treating it as overlapping would make every task declaring a directory
 * glob hold `lockfile`/`i18n-seed`. A `*` segment in `touch` (`*.json`, `*`) still matches a literal
 * segment by `globsOverlap`'s `*` rule.
 *
 * ANCHORED lock globs (first segment not `**`: `db/migrations/**`, `db/seed*`) → plain `globsOverlap`,
 * i.e. still conservative.
 *
 * Only used to INFER LOCKS. Between two tasks' `touches` it is still `globsOverlap`/`anyOverlap` — a
 * mistake there means two agents edit the same file.
 *
 * @param {string} touch @param {string} lockGlob @returns {boolean}
 */
export function lockOverlap(touch, lockGlob) {
  if (!lockGlob.startsWith("**")) return globsOverlap(touch, lockGlob);
  return lockFrom(touch.split("/"), 0, lockGlob.split("/"), 0);
}

/** @param {string[]} st @param {number} i @param {string[]} sl @param {number} j @returns {boolean} */
function lockFrom(st, i, sl, j) {
  if (i === st.length && j === sl.length) return true;
  if (st[i] === "**") {
    // The touch's `**` eats 0 segments, or stands in for a lock `**` segment — never for a literal one.
    return lockFrom(st, i + 1, sl, j) || (sl[j] === "**" && lockFrom(st, i, sl, j + 1));
  }
  if (sl[j] === "**") {
    // The lock's `**` eats 0 segments, or eats one of the touch's segments.
    return lockFrom(st, i, sl, j + 1) || (i < st.length && lockFrom(st, i + 1, sl, j));
  }
  if (i === st.length || j === sl.length) return false;
  const x = st[i];
  const y = sl[j];
  const wx = x.includes("*");
  const wy = y.includes("*");
  const same = wx && wy ? true
    : wx ? globToRegExp(x).test(y)
    : wy ? globToRegExp(y).test(x)
    : x === y;
  return same && lockFrom(st, i + 1, sl, j + 1);
}

/**
 * Is every path matching `inner` CERTAIN to match `outer` (A-082)? PURE FUNCTION.
 * Unsure → `false`: this is used to EXCLUDE from a lock, so a wrong "yes" lets a schema-editing task
 * slip out of the `db-schema` lock; a wrong "no" only holds a lock unnecessarily.
 *
 * Compares segment by segment:
 *   - `outer`'s `**` eats 0..n of `inner`'s segments; a trailing `**` requires `inner` to have at least
 *     one segment left (`a/**` does not match the path `a`);
 *   - `inner`'s `**` can only be covered by `outer`'s `**` (a literal `outer` segment cannot cover "anything");
 *   - a segment with `*`: if `inner` is literal, test by regex; if `inner` also has `*`, only certain when
 *     the two segments are identical, or `outer` is a bare `*`.
 *
 * @param {string} outer @param {string} inner @returns {boolean}
 */
export function globCovers(outer, inner) {
  return coversFrom(outer.split("/"), 0, inner.split("/"), 0);
}

/** @param {string[]} so @param {number} i @param {string[]} si @param {number} j @returns {boolean} */
function coversFrom(so, i, si, j) {
  if (i === so.length) return j === si.length;
  if (so[i] === "**") {
    if (i === so.length - 1) return j < si.length;
    return coversFrom(so, i + 1, si, j) || (j < si.length && coversFrom(so, i, si, j + 1));
  }
  if (j === si.length || si[j] === "**") return false;
  return segmentCovers(so[i], si[j]) && coversFrom(so, i + 1, si, j + 1);
}

/** @param {string} outerSeg @param {string} innerSeg @returns {boolean} */
function segmentCovers(outerSeg, innerSeg) {
  if (!outerSeg.includes("*")) return outerSeg === innerSeg;
  if (outerSeg === "*" || outerSeg === innerSeg) return true;
  return !innerSeg.includes("*") && globToRegExp(outerSeg).test(innerSeg);
}

/**
 * Split a lock's glob list (A-082): entries starting with `!` are EXCLUSION globs ("don't count").
 * @param {string[]} globs @returns {{include: string[], exclude: string[]}}
 */
export function splitLockGlobs(globs) {
  return {
    include: globs.filter((g) => !g.startsWith("!")),
    exclude: globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)),
  };
}

/**
 * Does a `touches` entry DECLARE that it edits files under the lock: `lockOverlap` with a positive glob
 * and not `globCovers`-ed by any exclusion glob (A-082). PURE FUNCTION.
 * @param {string} touch @param {string[]} lockGlobs @returns {boolean}
 */
export function touchHoldsLock(touch, lockGlobs) {
  const { include, exclude } = splitLockGlobs(lockGlobs);
  return include.some((g) => lockOverlap(touch, g)) && !exclude.some((g) => globCovers(g, touch));
}

/**
 * Does a (diff) file belong to the lock: matches a positive glob and no exclusion glob (A-082).
 * @param {string[]} lockGlobs @param {string} file @returns {boolean}
 */
export function fileInLock(lockGlobs, file) {
  const { include, exclude } = splitLockGlobs(lockGlobs);
  return matchAny(include, file) && !matchAny(exclude, file);
}

/** Does any pair across the two lists overlap? @param {string[]} a @param {string[]} b */
export function anyOverlap(a, b) {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}
