// @ts-check
/**
 * LAYER 1 — converts task files written in the old (prose) format to
 * front-matter. Run ONCE for an existing backlog.
 *
 * The body is kept byte for byte: only a front-matter block is prepended. Seven
 * fields are inferred from what the old format already records:
 *   `LEGACY_DEPS_LABEL` line → deps · `File:` → scope (to infer the gate)
 *   section `## <config.headings.doneWhen>` → verify (boxes with a command) and manual (boxes without)
 *   every box ticked → status: done
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

// Markers of the legacy prose format — part of the file format, so they come from `config.headings`.
const LEGACY_DEPS_LABEL = config.headings.legacyDeps;
const LEGACY_MANUAL_MARK = config.headings.legacyManual;

/** @param {string} line @returns {string[]} */
function backticks(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * @param {string} name file name
 * @param {string} content
 * @returns {{frontMatter: string, data: Record<string, unknown>} | null} null = already has front-matter
 */
export function toFrontMatter(name, content) {
  if (content.startsWith("---\n")) return null;

  const lines = content.split("\n");
  const id = /^([A-Z]-\d{3})/.exec(name)?.[1] ?? "";
  const heading = lines.find((l) => l.startsWith("# ")) ?? "";
  const title = heading.replace(/^#\s*[A-Z]-\d{3}\s*·?\s*/, "").trim();

  const depLine = lines.find((l) => l.startsWith(LEGACY_DEPS_LABEL)) ?? "";
  const depsRaw = depLine.slice(LEGACY_DEPS_LABEL.length).trim();
  const deps =
    depsRaw === "" || depsRaw === "—"
      ? []
      : [...depsRaw.matchAll(/\b([A-Z]-\d{3})\b/g)].map((m) => m[1]);

  const scopeLine = lines.find((l) => l.startsWith("File:")) ?? "";
  const scope = backticks(scopeLine);

  /** @type {string[]} */ const verify = [];
  /** @type {string[]} */ const manual = [];
  let inDone = false;
  let allTicked = true;
  for (const line of lines) {
    if (line.startsWith(`## ${config.headings.doneWhen}`)) { inDone = true; continue; }
    if (inDone && line.startsWith("## ")) { inDone = false; }
    if (!line.startsWith("- [")) continue;

    if (!line.startsWith("- [x]")) allTicked = false;
    if (!inDone) continue;

    const text = line.slice(6).trim();
    const cmds = backticks(line);
    // The manual marker wins over everything: there is a command, but a human still decides.
    if (text.startsWith(LEGACY_MANUAL_MARK) || cmds.length === 0) {
      const stripped = text.startsWith(LEGACY_MANUAL_MARK) ? text.slice(LEGACY_MANUAL_MARK.length).replace(/^\s*/, "") : text;
      manual.push(stripped.replace(/`/g, ""));
    } else {
      verify.push(cmds[0]);
    }
  }

  const haystack = `${scope.join(" ")} ${title}`.toLowerCase();
  const gate = manual.length > 0
    ? "manual"
    : config.migrationPaths.some((p) => scope.some((s) => s.includes(p)))
      ? "migration"
      : config.moneyKeywords.some((k) => haystack.includes(k.toLowerCase()))
        ? "money"
        : "none";

  const data = {
    id, title,
    status: allTicked ? "done" : "todo",
    deps, gate, verify, manual,
    owner: null, updated: null,
  };

  /** @param {string[]} items */
  const block = (items) =>
    items.length === 0 ? " []" : `\n${items.map((i) => `  - ${i}`).join("\n")}`;

  const frontMatter = [
    "---",
    `id: ${data.id}`,
    `title: ${data.title}`,
    `status: ${data.status}`,
    `deps: [${deps.join(", ")}]`,
    `gate: ${gate}`,
    `verify:${block(verify)}`,
    `manual:${block(manual)}`,
    "owner: null",
    "updated: null",
    "---",
    "",
  ].join("\n");

  return { frontMatter, data };
}

/**
 * @param {{dir?: string, write?: boolean, out?: (s: string) => void}} [options]
 * @returns {{converted: string[], skipped: string[], stats: Record<string, number>}}
 */
export function migrate(options = {}) {
  const dir = options.dir ?? config.tasksDir;
  const out = options.out ?? ((s) => process.stdout.write(`${s}\n`));
  const files = fs.readdirSync(dir).filter((f) => /^[A-Z]-\d{3}-.*\.md$/.test(f)).sort();

  /** @type {string[]} */ const converted = [];
  /** @type {string[]} */ const skipped = [];
  /** @type {Record<string, number>} */ const stats = { done: 0, todo: 0, gated: 0, noVerify: 0 };

  for (const name of files) {
    const file = path.join(dir, name);
    const content = fs.readFileSync(file, "utf8");
    const result = toFrontMatter(name, content);
    if (result === null) { skipped.push(name); continue; }

    const d = /** @type {any} */ (result.data);
    stats[d.status] += 1;
    if (d.gate !== "none") stats.gated += 1;
    if (d.verify.length === 0) stats.noVerify += 1;

    converted.push(name);
    out(
      `${d.id}  status=${d.status.padEnd(4)} gate=${String(d.gate).padEnd(9)} ` +
      `deps=${d.deps.length} verify=${d.verify.length} manual=${d.manual.length}`
    );
    if (options.write) fs.writeFileSync(file, result.frontMatter + content);
  }

  return { converted, skipped, stats };
}
