// @ts-check
/**
 * MINIMAL front-matter reader/writer — deliberately not full YAML.
 *
 * Understands exactly what the task format needs (see `docs/agent-task-queue.md` Layer 1):
 *   key: string | number | null   (keys may contain `-`: `blocked-on`)
 *   key: [a, b]                   (flat one-line array)
 *   key:                          (flat multi-line array)
 *     - item
 *
 * Anything outside that THROWS with the path and line number, never guesses. Hand-written
 * instead of pulling in `js-yaml` because all of `scripts/agent-queue/` must run out of
 * the box, with nothing installed (decision Q-D in the design doc).
 */

const DELIM = "---";

export class FrontMatterError extends Error {
  /** @param {string} message @param {string} source @param {number} line */
  constructor(message, source, line) {
    super(`${source}:${line}: ${message}`);
    this.name = "FrontMatterError";
    this.source = source;
    this.line = line;
  }
}

/** @param {string} raw @returns {string} */
function stripComment(raw) {
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  // Only cut when `#` follows whitespace — `a#b` is a valid value.
  const at = raw.search(/\s#/);
  return at === -1 ? raw : raw.slice(0, at);
}

/** @param {string} raw @returns {string|number|null} */
function scalar(raw) {
  const value = stripComment(raw).trim();
  if (value === "null" || value === "~" || value === "") return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * @param {string} text file content
 * @param {string} source path, only used in error messages
 * @returns {{data: Record<string, unknown>, body: string, endLine: number}}
 */
export function parseFrontMatter(text, source = "<string>") {
  const lines = text.split("\n");
  if (lines[0].trim() !== DELIM) {
    throw new FrontMatterError("missing front-matter (must open with `---`)", source, 1);
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === DELIM);
  if (close === -1) {
    throw new FrontMatterError("front-matter has no closing `---` line", source, 1);
  }

  /** @type {Record<string, unknown>} */
  const data = {};
  /** @type {string|null} */
  let listKey = null;

  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    if (/^\s+-\s/.test(line)) {
      if (listKey === null) {
        throw new FrontMatterError("array item belongs to no key", source, lineNo);
      }
      const item = line.replace(/^\s+-\s/, "");
      /** @type {unknown[]} */ (data[listKey]).push(scalar(item));
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) {
      throw new FrontMatterError(`invalid line: ${JSON.stringify(line)}`, source, lineNo);
    }
    const key = match[1];
    const rest = match[2].trim();

    if (rest === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;

    if (rest.startsWith("[")) {
      const closeIdx = rest.indexOf("]");
      if (closeIdx === -1) {
        throw new FrontMatterError("one-line array is missing `]`", source, lineNo);
      }
      const inner = rest.slice(1, closeIdx).trim();
      data[key] = inner === "" ? [] : inner.split(",").map((p) => scalar(p));
      continue;
    }

    data[key] = scalar(rest);
  }

  return { data, body: lines.slice(close + 1).join("\n"), endLine: close + 1 };
}

/**
 * Patch a few front-matter fields, KEEPING everything else, including comments and
 * line order. Edits line by line in place instead of rebuilding the block — rebuilding
 * loses comments and bloats the diff.
 *
 * @param {string} text
 * @param {Record<string, string|number|null>} patch scalar values only
 * @param {string} source
 * @returns {string}
 */
export function patchFrontMatter(text, patch, source = "<string>") {
  const lines = text.split("\n");
  if (lines[0].trim() !== DELIM) {
    throw new FrontMatterError("missing front-matter", source, 1);
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === DELIM);
  if (close === -1) {
    throw new FrontMatterError("front-matter has no closing `---` line", source, 1);
  }

  for (const [key, value] of Object.entries(patch)) {
    const idx = lines.findIndex(
      (l, i) => i > 0 && i < close && new RegExp(`^${key}:`).test(l)
    );
    const rendered = value === null ? "null" : String(value);
    // Keep a trailing comment if any.
    const comment = idx === -1 ? "" : (/\s(#.*)$/.exec(lines[idx])?.[1] ?? "");
    const line = comment ? `${key}: ${rendered}        ${comment}` : `${key}: ${rendered}`;
    if (idx === -1) {
      lines.splice(close, 0, line);
    } else {
      lines[idx] = line;
    }
  }

  return lines.join("\n");
}
