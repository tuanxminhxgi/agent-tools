// @ts-check
/**
 * The page of `npm run agents:ui` (A-039, rebuilt to the v2 design in A-043): ONE string of HTML + CSS + JS, no
 * framework, no CDN, no outbound calls — the server (dashboard-server.mjs) just serves it at `GET /`.
 *
 * Seven panels with fixed ids: cards · tree (Task panel) · waiting (Needs-you strip) · timeline · agents (Detail panel +
 * collapsed agent table) · usage · plan (collapsed, at the bottom). An eighth panel `flow` (A-047, Q-006 = C) spans the full row,
 * right above `timeline`: an SVG swimlane drawing the `layout` of `GET /api/flow`, playing `frames` in real time.
 * Data: `GET /api/stream` (SSE, `event: state`); if SSE drops, falls back to polling `GET /api/state` every 2 seconds.
 * The page ONLY DRAWS: `runs`, `attention`, `cards` are pre-aggregated by buildState (dashboard.mjs). Picking an attempt →
 * `GET /api/log/:agentId` of the last role agent in that attempt (last ≤ 200 lines).
 * The user's selection `{task, attempt, tab}` lives in a client variable, not in the DOM, so it survives every SSE frame.
 *
 * Page text is written inline here in English — an internal tool, not localized.
 * All text taken from data goes through `textContent` (never `innerHTML`), so task titles/logs cannot inject markup.
 * Written with `String.raw`: do NOT use backticks or `${` in the JS/CSS below.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent dashboard</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0d0f12; --panel: #15181d; --line: #22262d; --text: #e7e9ec; --muted: #9aa3ae;
  --ok: #4ade80; --bad: #f87171; --attn: #f5c451; --dev: #3b6fd8; --run: #7ea6f0; --other: #566070;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--sans); }
.wrap { max-width: 1440px; margin: 0 auto; padding: 12px; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
h3 { font-size: 13px; margin: 12px 0 6px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.mono { font-family: var(--mono); }
.grow { flex: 1 1 auto; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-bottom: 12px; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); white-space: nowrap; }
.pill.s-running, .pill.s-ok, .pill.s-failed { border-color: currentColor; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 6px; }
.dot.live { background: var(--ok); } .dot.poll { background: var(--attn); } .dot.off { background: var(--bad); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; margin-bottom: 12px; }
.split { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); align-items: start; }
.split > .panel { margin-bottom: 0; }
.split { margin-bottom: 12px; }
.s-running { color: var(--run); } .s-ok { color: var(--ok); } .s-failed { color: var(--bad); }
.s-lost { color: var(--attn); } .s-waiting { color: var(--attn); }
.empty { color: var(--muted); font-style: italic; }
button { font: inherit; color: inherit; }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--run); outline-offset: 2px; }
a { color: var(--run); }

#waiting { border-color: var(--attn); }
#waiting h2 { color: var(--attn); }
.attn { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); }
.attn-item { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; background: var(--bg); display: flex; flex-direction: column; gap: 4px; }
.attn-item.k-failed { border-color: var(--bad); }
.tag { align-self: flex-start; font-size: 11px; font-weight: 700; letter-spacing: .05em; padding: 0 6px; border-radius: 3px; color: #0d0f12; background: var(--attn); }
.k-failed .tag { background: var(--bad); }
.k-orphan .tag { background: var(--muted); }
.jump { display: inline-flex; align-items: center; align-self: flex-start; }

#cards { display: grid; gap: 8px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.card .sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.card.alert { border-color: var(--bad); }
.card.alert .value { color: var(--bad); }
.slots { display: flex; gap: 3px; margin-top: 6px; }
.slots i { flex: 1 1 0; max-width: 40px; height: 6px; border-radius: 3px; background: var(--line); }
.slots i.on { background: var(--dev); }

.badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 12px; border: 1px solid currentColor; white-space: nowrap; }
.task { border-top: 1px solid var(--line); padding: 8px 0; }
.task:first-of-type { border-top: 0; padding-top: 0; }
.task-head { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; margin-bottom: 6px; }
.attempt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; width: 100%; text-align: left; margin: 0 0 4px; padding: 6px 10px; min-height: 36px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.attempt:hover { border-color: var(--muted); }
.attempt.sel { border-color: var(--run); background: color-mix(in srgb, var(--dev) 18%, var(--bg)); }
.a-n { font-weight: 650; }
.a-flow { flex: 1 1 auto; min-width: 0; }
.a-meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.diag { margin: 6px 0 2px; padding: 8px 10px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: 6px; background: color-mix(in srgb, var(--bad) 10%, var(--bg)); }
.diag strong { color: var(--bad); }
code, .cmd { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; word-break: break-word; }

.dhead { margin-bottom: 8px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
.tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 12px; min-height: 36px; cursor: pointer; color: var(--muted); }
.tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--run); }
.checks { list-style: none; margin: 0; padding: 0; }
.checks li { display: flex; gap: 8px; align-items: baseline; padding: 5px 8px; border-radius: 4px; }
.checks li.red { background: color-mix(in srgb, var(--bad) 16%, transparent); }
.checks .mk { width: 1.2em; flex: none; text-align: center; font-weight: 700; }
.checks .cmd { flex: 1 1 auto; min-width: 0; }
.checks .t { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
pre { margin: 8px 0 0; padding: 8px; background: color-mix(in srgb, var(--text) 6%, transparent); border-radius: 6px; overflow: auto; max-height: 360px; font: 12px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; }
.l-ok { color: var(--ok); } .l-bad { color: var(--bad); } .l-warn { color: var(--attn); } .l-dim { color: var(--muted); opacity: .7; }
details > summary { cursor: pointer; padding: 4px 0; }
details.panel > summary { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.all-agents { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 6px; }

.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; }
tr.sel { background: color-mix(in srgb, var(--dev) 18%, transparent); }
button.link { all: unset; cursor: pointer; color: var(--run); text-decoration: underline; }
button.link:focus-visible { outline: 2px solid var(--run); outline-offset: 2px; }

.gantt { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 8px; align-items: start; }
.track { position: relative; background: color-mix(in srgb, var(--text) 5%, transparent); border-radius: 4px; }
.track.idle { height: 28px; display: flex; align-items: center; padding: 0 8px; }
.bar { position: absolute; border-radius: 3px; padding: 0 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; text-align: left; color: #fff; border: 1px solid transparent; background: var(--other); cursor: default; }
button.bar { cursor: pointer; }
.bar.r-developer { background: var(--dev); }
.bar.b-failed, .bar.b-lost { border-color: var(--bad); }
.bar.sel { outline: 2px solid var(--text); outline-offset: 1px; }
.bar .redend { position: absolute; right: 0; top: 0; bottom: 0; width: 4px; background: var(--bad); }
.axis { position: relative; grid-column: 2; height: 18px; color: var(--muted); font-size: 11px; }
.axis span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.axis span:first-child { transform: none; }
.legend { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }

.total { font-size: 18px; font-weight: 650; }
.banner { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--bad); color: var(--bad); margin: 8px 0; }
.stack { display: grid; grid-template-columns: minmax(60px, 90px) minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; }
.stack .lane { display: flex; height: 22px; background: color-mix(in srgb, var(--text) 5%, transparent); border-radius: 4px; overflow: hidden; }
.seg { display: block; height: 100%; min-width: 2px; font-size: 11px; line-height: 22px; text-align: center; overflow: hidden; border-right: 1px solid var(--panel); }
.seg.g1 { background: #2b58b0; color: #fff; } .seg.g2 { background: #4a7de0; color: #0d0f12; }
.seg.g3 { background: #8fb0f0; color: #0d0f12; } .seg.g4 { background: #c5d6f8; color: #0d0f12; }
.seg.red { box-shadow: inset 0 -3px 0 var(--bad); }
.n { font-variant-numeric: tabular-nums; text-align: right; }
.bars { display: grid; grid-template-columns: minmax(80px, 160px) minmax(0, 1fr) auto; gap: 3px 8px; align-items: center; }
.bars .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bars .meter { height: 10px; background: color-mix(in srgb, var(--text) 8%, transparent); border-radius: 5px; overflow: hidden; }
.bars .meter i { display: block; height: 100%; background: var(--dev); }
.bars .over .meter i { background: var(--bad); }
.bars .over .lbl, .bars .over .n { color: var(--bad); font-weight: 600; }
.cols { display: grid; gap: 4px 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }

#flow .flow-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-bottom: 8px; min-height: 24px; }
.flow-btn { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; min-height: 28px; cursor: pointer; }
.flow-btn[aria-pressed="true"] { border-color: var(--run); }
.flow-btn:disabled { opacity: .5; cursor: default; }
.flow-toolbar select { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; min-height: 28px; max-width: 100%; }
.flow-replay, .flow-zoom { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 100%; }
.flow-replay[hidden] { display: none; }
#flow-scrub { flex: 1 1 140px; min-width: 100px; max-width: 100%; }
.flow-canvas { position: relative; overflow: hidden; max-height: 70vh; touch-action: pan-y; cursor: grab; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
.flow-canvas.panning { cursor: grabbing; user-select: none; }
.flow-canvas[hidden] { display: none; }
.flow-svg { display: block; max-width: none; }
.flow-lane-bg { fill: transparent; }
.flow-lane.odd .flow-lane-bg { fill: color-mix(in srgb, var(--text) 4%, transparent); }
.flow-lane-line { stroke: var(--line); stroke-width: 1; }
.flow-lane-label { fill: var(--muted); font: 12px var(--sans); }
.flow-edge { fill: none; stroke: var(--other); stroke-width: 1.5; }
.flow-edge.e-handoff { stroke: var(--run); }
.flow-edge.e-integrate { stroke: var(--ok); }
.flow-edge.e-spawn { stroke-dasharray: 2 4; }
.flow-edge.is-flow { stroke: var(--run); stroke-dasharray: 6 6; }
.flow-edge.is-hidden, .flow-node.is-hidden { opacity: 0; pointer-events: none; }
.flow-node { cursor: default; outline: none; }
.flow-node.is-faded { opacity: .4; }
.flow-body, .flow-halo { transform-box: fill-box; transform-origin: center; }
.flow-box { fill: var(--panel); stroke: var(--line); stroke-width: 1.5; }
.flow-halo { fill: none; stroke: var(--run); stroke-width: 2; opacity: 0; }
.flow-dot { fill: var(--other); }
.flow-title { fill: var(--text); font: 600 12px var(--sans); }
.flow-sub { fill: var(--muted); font: 11px var(--sans); }
.st-running .flow-box { stroke: var(--run); }
.st-running .flow-dot { fill: var(--run); }
.st-ok .flow-box { stroke: var(--ok); }
.st-ok .flow-dot { fill: var(--ok); }
.st-failed .flow-box { stroke: var(--bad); }
.st-failed .flow-dot { fill: var(--bad); }
.st-lost .flow-box { stroke: var(--muted); stroke-dasharray: 4 3; }
.st-lost .flow-dot { fill: var(--muted); }
.st-waiting .flow-box { stroke-dasharray: 4 3; }
.flow-node:focus-visible .flow-box { stroke: var(--text); stroke-width: 2.5; }
.flow-packet { fill: none; stroke: var(--run); stroke-width: 5; stroke-linecap: round; }
.flow-packet.back { stroke: var(--ok); }
.st-lost .flow-halo { stroke: var(--muted); }
.flow-canvas.hovering .flow-edge:not(.hot):not(.is-hidden) { opacity: .2; }
.flow-canvas.hovering .flow-node:not(.hot):not(.is-hidden) { opacity: .45; }
.flow-edge.hot { stroke: var(--text); stroke-width: 2.5; }
.flow-tip { position: absolute; z-index: 2; background: var(--panel); border: 1px solid var(--muted); border-radius: 6px; padding: 6px 8px; font-size: 12px; white-space: nowrap; pointer-events: none; }
.flow-tip strong { display: block; margin-bottom: 2px; }

@media (max-width: 899px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  #cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .attn { grid-template-columns: minmax(0, 1fr); }
  button, .jump, summary { min-height: 44px; }
  .attempt { align-items: center; }
  .tabs button { min-height: 44px; }
  .jump { padding: 0 4px; }
  .flow-btn, .flow-toolbar select { min-height: 40px; }
  .gantt { grid-template-columns: 56px minmax(0, 1fr); }
}
@media (max-width: 520px) {
  .wrap { padding: 8px; }
  .card .value { font-size: 20px; }
  .stack { grid-template-columns: minmax(48px, 70px) minmax(0, 1fr) auto; }
}
@media (prefers-reduced-motion: reduce) {
  #flow * { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <h1>Agent dashboard</h1>
  <span id="runid" class="mono muted small">no run yet</span>
  <span id="runstate" class="pill"></span>
  <span class="grow"></span>
  <span class="muted small"><span id="dot" class="dot"></span><span id="conn">connecting…</span> · <span id="stamp">no data yet</span></span>
  <span class="pill muted">read-only</span>
</header>
<section id="waiting" class="panel" aria-label="Needs you" hidden><h2 id="waiting-title">Needs you</h2><div class="body attn"></div></section>
<section id="cards" aria-label="Overview"></section>
<div class="split">
  <section id="tree" class="panel" aria-label="Task"><h2>Task</h2><div class="body"></div></section>
  <section id="agents" class="panel" aria-label="Detail"><h2>Detail</h2>
    <div class="dhead"></div>
    <div class="tabs" role="tablist" aria-label="Attempt detail">
      <button type="button" role="tab" id="tab-verify" aria-controls="pane-verify" aria-selected="true">Verify result</button>
      <button type="button" role="tab" id="tab-log" aria-controls="pane-log" aria-selected="false" tabindex="-1">Log</button>
    </div>
    <div id="pane-verify" role="tabpanel" aria-labelledby="tab-verify"></div>
    <div id="pane-log" role="tabpanel" aria-labelledby="tab-log" hidden><div class="muted small log-title"></div><pre class="log-out" aria-live="off"></pre></div>
    <details class="all-agents"><summary>Agent table (all agents, newest first)</summary><div class="all-body"></div></details>
  </section>
</div>
<section id="flow" class="panel" aria-label="Flow"><h2>Flow</h2>
  <div class="flow-toolbar"><span class="flow-run mono muted small">no run yet</span><span class="flow-badge pill s-waiting" hidden></span><span class="flow-note muted small"></span>
    <select id="flow-run" aria-label="Pick a run to replay"></select>
    <button type="button" id="flow-live" class="flow-btn" aria-pressed="true" disabled>Live</button>
    <span id="flow-new" class="pill s-waiting" hidden>new events</span>
    <span class="flow-replay" hidden>
      <button type="button" id="flow-play" class="flow-btn" aria-pressed="false">Play</button>
      <button type="button" id="flow-step-back" class="flow-btn" aria-label="Step back one event">◀ Back</button>
      <input type="range" id="flow-scrub" min="0" max="0" value="0" step="1" aria-label="Position in run">
      <button type="button" id="flow-step-fwd" class="flow-btn" aria-label="Step forward one event">Next ▶</button>
      <span class="flow-pos mono muted small">0 / 0</span>
      <button type="button" id="flow-speed-1" class="flow-btn" data-speed="1" aria-pressed="true">1×</button>
      <button type="button" id="flow-speed-4" class="flow-btn" data-speed="4" aria-pressed="false">4×</button>
      <button type="button" id="flow-speed-16" class="flow-btn" data-speed="16" aria-pressed="false">16×</button>
    </span>
    <span class="flow-zoom">
      <button type="button" id="flow-zoom-out" class="flow-btn" aria-label="Zoom out">−</button>
      <button type="button" id="flow-zoom-in" class="flow-btn" aria-label="Zoom in">+</button>
      <button type="button" id="flow-zoom-fit" class="flow-btn" aria-label="Reset view">Fit</button>
    </span></div>
  <div class="flow-canvas" hidden></div>
</section>
<section id="timeline" class="panel" aria-label="Timeline by slot"><h2>Timeline by slot</h2><div class="body"></div></section>
<section id="usage" class="panel" aria-label="Token"><h2>Token</h2><div class="body"></div></section>
<details id="plan" class="panel" aria-label="Next round plan"><summary>Next round plan</summary><div class="body"></div></details>
</div>
<script>
(function () {
  "use strict";
  var state = null;
  var sel = { task: null, attempt: null, tab: "verify", picked: false };
  var index = {};
  var agentsById = {};
  var logSeq = 0;
  var logKey = "";
  var pollTimer = null;
  var STATUS = { running: "Running", ok: "Done", failed: "Failed", lost: "Signal lost", waiting: "Waiting on human" };
  var MARK = { running: "●", ok: "✓", failed: "✗", lost: "?", waiting: "⏸" };
  var KIND = { failed: "FAILED", question: "QUESTION", "needs-human": "NEEDS CONFIRMATION", gated: "AWAITING APPROVAL", orphan: "ORPHAN" };
  var MAX_ROWS = 200;
  var MAX_TASKS = 60;
  var narrowQuery = window.matchMedia ? window.matchMedia("(max-width: 899px)") : null;

  function $(id) { return document.getElementById(id); }
  function body(id) { return $(id).querySelector(".body"); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return parent;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function btn(cls, text) { var b = el("button", cls, text); b.type = "button"; return b; }
  function num(n) { return n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US"); }
  function compact(n) {
    if (n === null || n === undefined) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }
  function dur(ms) {
    if (ms === null || ms === undefined) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min " + (s % 60) + " s";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }
  function tickLabel(ms) {
    var s = Math.round(ms / 1000);
    if (s === 0) return "0";
    if (s < 60) return "+" + s + " s";
    var m = Math.round(s / 60);
    if (m < 60) return "+" + m + " min";
    return "+" + Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  }
  function clock(ms) { return new Date(ms).toLocaleTimeString("en-US"); }
  // A-050: input + output + cache summed over every call is not comparable to an interactive session — the page shows
  // output (tokens written by the model), peak context and USD equivalent, one column each.
  function usd(x) { return x === null || x === undefined ? "—" : "≈ $" + Number(x).toFixed(2); }
  function isNarrow() { return narrowQuery ? narrowQuery.matches : false; }
  function label(a) { return a.role || a.kind || a.agentId; }
  function badge(status) {
    var b = el("span", "badge s-" + status);
    add(b, el("span", null, MARK[status] || "•"), " " + (STATUS[status] || status));
    return b;
  }
  function mark(status, text) {
    var s = el("span", "s-" + status);
    add(s, (MARK[status] || "•") + (text ? " " + text : ""));
    return s;
  }

  // ---- selection --------------------------------------------------------------------------------------------
  function findRun(id) {
    var runs = state.runs;
    for (var i = 0; i < runs.length; i++) if (runs[i].taskId === id) return runs[i];
    return null;
  }
  function findAttempt(run, n) {
    for (var i = 0; i < run.attempts.length; i++) if (run.attempts[i].n === n) return run.attempts[i];
    return null;
  }
  function defaultRun() {
    var runs = state.runs.filter(function (r) { return r.attempts.length > 0; });
    if (runs.length === 0) return null;
    var failed = runs.filter(function (r) { return r.status === "failed"; });
    if (failed.length > 0) return failed[0];
    var running = runs.filter(function (r) { return r.status === "running"; });
    return running.length > 0 ? running[0] : runs[runs.length - 1];
  }
  function buildIndex() {
    index = {}; agentsById = {};
    state.agents.forEach(function (a) { agentsById[a.agentId] = a; });
    state.runs.forEach(function (run) {
      run.attempts.forEach(function (at) {
        at.agents.forEach(function (id) { index[id] = { taskId: run.taskId, n: at.n }; });
      });
    });
  }
  // Keep the user's selection while the task/attempt still exists; nothing picked (or it vanished) → use the default.
  function resolveSelection() {
    var run = sel.picked && sel.task !== null ? findRun(sel.task) : null;
    if (!run || run.attempts.length === 0) { sel.picked = false; run = defaultRun(); }
    if (!run) { sel.task = null; sel.attempt = null; return; }
    sel.task = run.taskId;
    if (!(sel.picked && findAttempt(run, sel.attempt))) sel.attempt = run.attempts[run.attempts.length - 1].n;
  }
  function curRun() { return sel.task === null ? null : findRun(sel.task); }
  function curAttempt() { var r = curRun(); return r && sel.attempt !== null ? findAttempt(r, sel.attempt) : null; }
  function attemptRunning(at) {
    return at.agents.some(function (id) { return agentsById[id] && agentsById[id].status === "running"; });
  }
  function logAgent(at) {
    var ids = at.agents.slice().reverse();
    var main = ids.filter(function (id) { return agentsById[id] && agentsById[id].kind !== "subagent"; });
    return main.length > 0 ? main[0] : ids.length > 0 ? ids[0] : null;
  }
  function pickAttempt(taskId, n) {
    sel.task = taskId; sel.attempt = n; sel.picked = true;
    render();
  }
  function setTab(tab) {
    sel.tab = tab;
    renderTabs();
    syncLog(false);
  }

  // ---- header, Needs you, cards ------------------------------------------------------------------------------
  function renderHeader() {
    var c = state.cards, rid = state.timeline ? state.timeline.runId : null;
    $("runid").textContent = rid ? "run " + rid : "no run yet";
    var p = $("runstate"), cls = "muted", text = "no run yet";
    if (c.running > 0) { cls = "s-running"; text = "running"; }
    else if (c.tasksFailed > 0) { cls = "s-failed"; text = "stopped · " + c.tasksFailed + " failed"; }
    else if (state.runs.length > 0) { cls = "s-ok"; text = "done"; }
    p.className = "pill " + cls;
    p.textContent = text;
    $("stamp").textContent = "updated " + clock(Date.parse(state.generatedAt));
  }

  function renderAttention() {
    var sec = $("waiting"), box = clear(body("waiting")), items = state.attention;
    sec.hidden = items.length === 0;
    $("waiting-title").textContent = "Needs you (" + items.length + ")";
    items.forEach(function (it) {
      var d = el("div", "attn-item k-" + it.kind);
      add(d, el("span", "tag", KIND[it.kind] || it.kind), el("span", null, it.text));
      if (it.anchor.indexOf("task:") === 0) {
        var id = it.anchor.slice(5);
        var a = el("a", "jump", "View task " + id);
        a.href = "#task-" + id;
        a.addEventListener("click", function () {
          var run = findRun(id);
          if (run && run.attempts.length > 0) pickAttempt(id, run.attempts[run.attempts.length - 1].n);
        });
        add(d, a);
      }
      add(box, d);
    });
  }

  function card(lbl, value, sub, alert) {
    var c = el("div", "card" + (alert ? " alert" : ""));
    add(c, el("div", "label", lbl), el("div", "value", value), sub === null ? null : el("div", "sub", sub));
    return c;
  }

  function renderCards() {
    var c = state.cards, box = clear($("cards"));
    var slots = card("Slots in use", num(c.running) + (c.workers === null ? "" : " / " + c.workers), c.workers === null ? "max slots unknown" : "slots", false);
    if (c.workers !== null && c.workers > 0) {
      var bars = el("div", "slots");
      for (var i = 0; i < Math.min(c.workers, 16); i++) add(bars, el("i", i < c.running ? "on" : ""));
      add(slots, bars);
    }
    var span = c.runStartMs !== null && c.runEndMs !== null ? c.runEndMs - c.runStartMs : null;
    add(box, slots,
      card("Run result", num(c.tasksOk) + " done · " + num(c.tasksFailed) + " failed", num(c.attempts) + " attempts", c.tasksFailed > 0),
      card("Run duration", span === null ? "—" : dur(span), span === null ? null : clock(c.runStartMs) + " → " + clock(c.runEndMs), false),
      card("This run's cost", usd(c.costRun), "out " + compact(c.outputRun) + " tokens · today " + usd(c.costToday) + " · total " + usd(c.costTotal), false));
  }

  // ---- Task panel -------------------------------------------------------------------------------------------
  function attemptRow(run, at) {
    var on = run.taskId === sel.task && at.n === sel.attempt;
    var b = btn("attempt" + (on ? " sel" : ""));
    if (on) b.setAttribute("aria-current", "true");
    var flow = el("span", "a-flow"), first = true;
    at.agents.forEach(function (id) {
      var a = agentsById[id];
      if (!a || a.kind === "subagent") return;
      if (!first) add(flow, " → ");
      first = false;
      add(flow, mark(a.status, label(a)));
    });
    if (at.verify === null) {
      add(flow, first ? "" : " → ", el("span", "muted", "awaiting verify"));
    } else {
      var v = at.verify, txt = "verifier";
      if (v.checks) txt += " " + v.checks.filter(function (k) { return k.ok; }).length + "/" + v.checks.length;
      add(flow, first ? "" : " → ", mark(v.ok ? "ok" : "failed", txt));
    }
    add(b, el("span", "a-n", "Attempt " + at.n), flow, el("span", "a-meta", dur(at.durationMs) + " · " + usd(at.costUsd) + " · out " + compact(at.output)));
    b.addEventListener("click", function () { pickAttempt(run.taskId, at.n); });
    return b;
  }

  function diagBox(d) {
    var box = el("div", "diag");
    if (d.kind === "same-failure") {
      add(box, el("strong", null, "Diagnosis: same failure repeating"), el("div", "small muted", "Red command in " + d.count + " consecutive attempts:"), el("code", null, d.cmd));
    } else {
      add(box, el("strong", null, "Diagnosis: " + d.kind));
    }
    return box;
  }

  function renderTasks() {
    var box = clear(body("tree")), runs = state.runs;
    if (runs.length === 0) {
      add(box, el("div", "empty", "No tasks in the latest run yet."));
      return;
    }
    runs.slice(0, MAX_TASKS).forEach(function (run) {
      var t = el("div", "task");
      t.id = "task-" + run.taskId;
      var head = el("div", "task-head");
      add(head, badge(run.status), el("strong", null, run.taskId));
      if (run.title) add(head, el("span", "muted", run.title));
      if (run.slot !== null) add(head, el("span", "muted small", run.slot === 0 ? "sequential" : "slot " + run.slot));
      add(t, head);
      if (run.attempts.length === 0) add(t, el("div", "empty", "No attempts yet."));
      run.attempts.forEach(function (at) { add(t, attemptRow(run, at)); });
      if (run.diagnosis) add(t, diagBox(run.diagnosis));
      add(box, t);
    });
    if (runs.length > MAX_TASKS) add(box, el("div", "muted small", "Showing " + MAX_TASKS + " / " + runs.length + " tasks."));
  }

  // ---- Detail panel -----------------------------------------------------------------------------------------
  function renderTabs() {
    ["verify", "log"].forEach(function (name) {
      var on = sel.tab === name, t = $("tab-" + name);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      $("pane-" + name).hidden = !on;
    });
  }

  function renderVerify(at) {
    var box = clear($("pane-verify"));
    if (!at) { add(box, el("div", "empty", "Pick an attempt in the Task panel.")); return; }
    var v = at.verify;
    if (v === null) { add(box, el("div", "empty", "This attempt has no verify result yet.")); return; }
    if (v.checks) {
      var ul = el("ul", "checks");
      v.checks.forEach(function (k) {
        var li = el("li", k.skipped ? "" : k.ok ? "" : "red");
        var m = el("span", "mk " + (k.skipped ? "muted" : k.ok ? "s-ok" : "s-failed"), k.skipped ? "−" : k.ok ? "✓" : "✗");
        add(li, m, el("span", "cmd", k.cmd), el("span", "t", k.skipped ? "skipped" : dur(k.durationMs)));
        add(ul, li);
      });
      add(box, ul);
    } else {
      add(box, el("div", "muted small", "This event carries no per-command results — showing the reason."));
      add(box, el("div", v.ok ? "s-ok" : "s-failed", (v.ok ? "✓ " : "✗ ") + (v.reason || (v.ok ? "green" : "red"))));
    }
    if (v.failTail) {
      add(box, el("h3", null, "Output of the first red command (last ≤ 20 lines)"), el("pre", null, v.failTail));
    }
  }

  function renderDetail() {
    var run = curRun(), at = curAttempt(), head = clear($("agents").querySelector(".dhead"));
    if (run && at) {
      add(head, el("strong", null, run.taskId + " · Attempt " + at.n), " ");
      if (at.verify) add(head, mark(at.verify.ok ? "ok" : "failed", at.verify.ok ? "verify green" : "verify red"));
      else add(head, el("span", "muted", attemptRunning(at) ? "running" : "not verified"));
      var when = at.startedAt ? clock(Date.parse(at.startedAt)) + " · " : "";
      add(head, el("div", "muted small", when + dur(at.durationMs) + " · " + usd(at.costUsd) + " · out " + num(at.output) + " tokens · peak context " + num(at.peakContext)));
    } else {
      add(head, el("span", "empty", "No attempt selected."));
    }
    renderTabs();
    renderVerify(at);
  }

  // ---- log (colored per line) -------------------------------------------------------------------------------
  function lineClass(line) {
    var s = line.toLowerCase();
    if (s.indexOf("-----") !== -1) return "l-dim";
    if (line.indexOf("✗") !== -1 || /\bred\b/.test(s) || s.indexOf("error") !== -1) return "l-bad";
    if (s.indexOf("denied") !== -1 || s.indexOf("rejected") !== -1 || s.indexOf("warn") !== -1) return "l-warn";
    if (line.indexOf("✓") !== -1 || /\bgreen\b/.test(s)) return "l-ok";
    return "";
  }
  function paintLog(out, text) {
    clear(out);
    if (text === "") { out.textContent = "(empty log)"; return; }
    text.split("\n").forEach(function (line, i, all) {
      if (i === all.length - 1 && line === "") return;
      add(out, el("span", lineClass(line), line + "\n"));
    });
  }
  function syncLog(force) {
    if (sel.tab !== "log") return;
    var pane = $("pane-log"), out = pane.querySelector(".log-out"), title = pane.querySelector(".log-title");
    var at = curAttempt(), id = at ? logAgent(at) : null;
    if (!id) {
      logSeq++; logKey = "";
      title.textContent = "";
      clear(out).textContent = at ? "(this attempt has no agents)" : "(no attempt selected)";
      return;
    }
    var live = attemptRunning(at);
    if (id === logKey && !force && !live) return;
    var a = agentsById[id];
    title.textContent = "Log: " + (a ? label(a) : id) + (a && a.taskId ? " " + a.taskId : "") + " · " + id;
    if (id !== logKey) clear(out).textContent = "(loading log…)";
    logKey = id;
    var seq = ++logSeq;
    fetch("/api/log/" + encodeURIComponent(id), { cache: "no-store" }).then(function (r) {
      return r.text().then(function (text) { return r.ok ? text : "(" + text.trim() + ")"; });
    }).then(function (text) {
      if (seq !== logSeq) return;
      var stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      paintLog(out, text);
      if (stick) out.scrollTop = out.scrollHeight;
    }).catch(function () {
      if (seq === logSeq) clear(out).textContent = "(could not load log)";
    });
  }

  // ---- timeline ---------------------------------------------------------------------------------------------
  function niceStep(span) {
    var steps = [10000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 21600000];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 8) return steps[i];
    return steps[steps.length - 1];
  }

  // Last agent of a red attempt: mark a red tick at the end of its bar.
  function redEnds() {
    var ends = {};
    state.runs.forEach(function (run) {
      run.attempts.forEach(function (at) {
        if (at.verify && !at.verify.ok && at.agents.length > 0) ends[at.agents[at.agents.length - 1]] = true;
      });
    });
    return ends;
  }

  function renderTimeline() {
    var box = clear(body("timeline")), t = state.timeline, workers = state.cards.workers;
    if (t.bars.length === 0) {
      add(box, el("div", "empty", "The latest run has no agents yet."));
      return;
    }
    var span = Math.max(1000, t.endMs - t.startMs);
    var slots = {}, order = [], red = redEnds();
    t.bars.forEach(function (b) {
      if (!slots[b.slot]) { slots[b.slot] = []; order.push(b.slot); }
      slots[b.slot].push(b);
    });
    if (workers !== null) {
      for (var s = 1; s <= Math.min(workers, 16); s++) if (!slots[s]) { slots[s] = []; order.push(s); }
    }
    order.sort(function (a, b) { return a - b; });
    var H = isNarrow() ? 44 : 24, PITCH = H + 4;
    var grid = el("div", "gantt");
    order.forEach(function (slot) {
      var name = el("div", "muted small", slot === 0 ? "Sequential" : "Slot " + slot);
      if (slots[slot].length === 0) {
        add(grid, name, el("div", "track idle muted small", "idle the whole run"));
        return;
      }
      var lanes = [];
      var bars = slots[slot].slice().sort(function (a, b) { return a.startMs - b.startMs; });
      var track = el("div", "track");
      bars.forEach(function (b) {
        var lane = 0;
        while (lane < lanes.length && lanes[lane] > b.startMs) lane++;
        lanes[lane] = b.endMs;
        var left = Math.min(((b.startMs - t.startMs) / span) * 100, 99.2);
        var width = Math.min(Math.max(0.8, ((b.endMs - b.startMs) / span) * 100), 100 - left);
        var pos = index[b.agentId], a = agentsById[b.agentId];
        var on = pos && pos.taskId === sel.task && pos.n === sel.attempt;
        var role = a && a.role === "developer" ? " r-developer" : "";
        var bar = pos ? btn("bar b-" + b.status + role + (on ? " sel" : ""), b.label) : el("span", "bar b-" + b.status + role, b.label);
        bar.style.left = left + "%";
        bar.style.width = width + "%";
        bar.style.top = (lane * PITCH + 2) + "px";
        bar.style.height = H + "px";
        bar.style.lineHeight = (H - 2) + "px";
        bar.title = b.label + " · " + (STATUS[b.status] || b.status) + " · " + dur(b.endMs - b.startMs) + (red[b.agentId] ? " · verify red" : "");
        if (red[b.agentId]) add(bar, el("span", "redend"));
        if (pos) bar.addEventListener("click", function () { pickAttempt(pos.taskId, pos.n); });
        add(track, bar);
      });
      track.style.height = (lanes.length * PITCH + 4) + "px";
      add(grid, name, track);
    });
    var axis = el("div", "axis"), step = niceStep(span);
    for (var ms = 0; ms <= span; ms += step) {
      var tick = el("span", null, tickLabel(ms));
      tick.style.left = (ms / span) * 100 + "%";
      add(axis, tick);
    }
    add(grid, axis);
    add(grid, el("div", "legend", clock(t.startMs) + " → " + clock(t.endMs) + " · total " + dur(t.endMs - t.startMs) + " · blue = developer, grey = other roles, red tick at the end = verify red"));
    add(box, grid);
  }

  // ---- token ------------------------------------------------------------------------------------------------
  // Bars measure USD equivalent (A-050) — same unit as the real cost, not inflated by accumulated cache reads.
  function meters(map, opts) {
    opts = opts || {};
    var keys = Object.keys(map);
    var shown = opts.limit ? keys.slice(0, opts.limit) : keys;
    var max = 0;
    keys.forEach(function (k) { max = Math.max(max, map[k].costUsd || 0); });
    if (max === 0) max = 1;
    if (shown.length === 0) return el("div", "empty", "No token data yet.");
    var grid = el("div", "bars");
    shown.forEach(function (k) {
      var b = map[k], over = opts.over && opts.over.indexOf(k) !== -1;
      var lbl = el("span", "lbl", k + (over ? " · over threshold" : ""));
      lbl.title = k;
      var meter = el("span", "meter"), fill = el("i");
      fill.style.width = Math.max(1, ((b.costUsd || 0) / max) * 100) + "%";
      add(meter, fill);
      var row = el("div");
      row.style.display = "contents";
      if (over) row.className = "over";
      var n = el("span", "n", usd(b.costUsd));
      n.title = "out " + num(b.output) + " tokens · peak context " + num(b.peakContext);
      add(row, lbl, meter, n);
      add(grid, row);
    });
    if (shown.length < keys.length) add(grid, el("span", "muted small", "… and " + (keys.length - shown.length) + " more"));
    return grid;
  }

  // Stacked bars: one bar per task, one segment per attempt (red segment = verify red).
  function attemptStacks() {
    var runs = state.runs.filter(function (r) { return r.attempts.length > 0; }).slice(0, 12);
    var max = 1, totals = runs.map(function (r) {
      var t = 0;
      r.attempts.forEach(function (at) { t += at.costUsd || 0; });
      max = Math.max(max, t);
      return t;
    });
    if (runs.length === 0) return el("div", "empty", "No attempts yet.");
    var grid = el("div", "stack");
    runs.forEach(function (r, i) {
      var lane = el("div", "lane");
      r.attempts.forEach(function (at) {
        var g = Math.min(at.n, 4);
        var cost = at.costUsd || 0;
        var seg = el("span", "seg g" + g + (at.verify && !at.verify.ok ? " red" : ""), cost > 0 && cost / max > 0.06 ? String(at.n) : "");
        seg.style.width = Math.max(0.5, (cost / max) * 100) + "%";
        seg.title = r.taskId + " · Attempt " + at.n + " · " + usd(at.costUsd) + " · out " + num(at.output) + " tokens";
        add(lane, seg);
      });
      add(grid, el("span", "small", r.taskId), lane, el("span", "n", usd(totals[i])));
    });
    return grid;
  }

  function renderUsage() {
    var box = clear(body("usage")), u = state.usage, t = u.total;
    add(box, el("div", "total", usd(t.costUsd) + " · out " + num(t.output) + " tokens"));
    add(box, el("div", "muted small",
      "peak context " + num(t.peakContext) + " · cache read " + num(t.cacheRead) + " (summed over every call) · cache write " + num(t.cacheWrite) +
      " · in " + num(t.input) + " · " + num(t.agents) + " agents finished" +
      (t.unknown > 0 ? " (" + num(t.unknown) + " agents with unknown tokens)" : "")));
    add(box, el("div", "muted small", "USD is an equivalent (client-side estimate, not a bill)."));
    if (u.overThreshold.length > 0) {
      add(box, el("div", "banner", "Tasks over the token threshold: " + u.overThreshold.join(", ")));
    }
    add(box, el("h3", null, "By attempt (one bar per task, one segment per attempt; red = verify red)"), attemptStacks());
    var cols = el("div", "cols");
    var byModel = el("div"), byRole = el("div"), top = el("div"), topMap = {};
    u.top.forEach(function (b) { topMap[b.taskId] = b; });
    add(byModel, el("h3", null, "By model"), meters(u.byModel));
    add(byRole, el("h3", null, "By role"), meters(u.byRole));
    add(top, el("h3", null, "Top 5 most expensive tasks (USD)"), meters(topMap, { over: u.overThreshold }));
    add(cols, byModel, byRole, top);
    add(box, cols);
  }

  // ---- agent table (collapsed), plan --------------------------------------------------------------------------
  function renderAgents() {
    var box = clear($("agents").querySelector(".all-body"));
    var rows = state.agents.slice().sort(function (a, b) {
      var ra = a.status === "running" ? 0 : 1, rb = b.status === "running" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      var x = a.startedAt || "", y = b.startedAt || "";
      return x < y ? 1 : x > y ? -1 : 0;
    });
    if (rows.length === 0) {
      add(box, el("div", "empty", "The event ledger has no agents yet."));
      return;
    }
    var table = el("table"), thead = el("thead"), head = el("tr");
    ["Role", "Task", "Model", "Status", "Duration", "Output", "Peak context", "USD"].forEach(function (h, i) {
      add(head, el("th", i >= 4 ? "num" : "", h));
    });
    add(thead, head);
    add(table, thead);
    var tb = el("tbody");
    rows.slice(0, MAX_ROWS).forEach(function (a) {
      var pos = index[a.agentId];
      var on = pos && pos.taskId === sel.task && pos.n === sel.attempt;
      var tr = el("tr", on ? "sel" : "");
      var first = el("td");
      if (pos) {
        var b = btn("link", label(a));
        b.addEventListener("click", function () { pickAttempt(pos.taskId, pos.n); });
        add(first, b);
      } else {
        add(first, label(a));
      }
      var st = el("td");
      add(st, badge(a.status));
      add(tr, first, el("td", null, a.taskId || "—"), el("td", null, a.model || "—"), st, el("td", "num", dur(a.durationMs)),
        el("td", "num", num(a.usage ? a.usage.output : null)), el("td", "num", num(a.peakContext)), el("td", "num", usd(a.costUsd)));
      add(tb, tr);
    });
    add(table, tb);
    var wrap = el("div", "scroll");
    add(wrap, table);
    add(box, wrap);
    if (rows.length > MAX_ROWS) add(box, el("div", "muted small", "Showing " + MAX_ROWS + " / " + rows.length + " agents (newest first)."));
    add(box, el("div", "muted small", "Click a role name to select that agent's attempt."));
  }

  function renderPlan() {
    var box = clear(body("plan"));
    if (!state.plan || !state.plan.text) {
      add(box, el("div", "empty", "No plan yet."));
      return;
    }
    add(box, el("div", "muted small", "Preview like conductor --dry-run: runs nothing, changes nothing."));
    add(box, el("pre", null, state.plan.text));
  }

  function render() {
    if (!state) return;
    buildIndex();
    resolveSelection();
    renderHeader(); renderAttention(); renderCards(); renderTasks(); renderDetail();
    renderTimeline(); renderUsage(); renderAgents(); renderPlan();
    syncLog(false);
  }

  // ---- Flow panel (A-047) -----------------------------------------------------------------------------------
  // The page only DRAWS what GET /api/flow returns (layout + frames): it never builds edges or guesses handoffs itself.
  // Only transform / opacity / stroke-dashoffset are animated; status colors change via classes.
  var FLOW_URL = "/api/flow";
  var SVG_NS = "http:" + "//www.w3.org/2000/svg";
  var NODE_W = 160;
  var NODE_H = 40;
  var FLOW_BACKLOG = 12;
  var FRAME_GAP_MS = 380;
  var NODE_STATUSES = ["running", "ok", "failed", "lost", "waiting"];
  var reduceQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var flow = null;

  function flowReset() {
    if (flow) {
      Object.keys(flow.loops).forEach(function (k) { try { flow.loops[k].cancel(); } catch (err) { /* already cancelled */ } });
      if (flow.timer) clearTimeout(flow.timer);
      if (flow.replayTimer) clearTimeout(flow.replayTimer);
    }
    // picked: runId being replayed (null = live); epoch: lets stale fetch responses be ignored
    var keep = flow
      ? { loading: flow.loading, again: flow.again, picked: flow.picked, speed: flow.speed, epoch: flow.epoch + 1 }
      : { loading: false, again: false, picked: null, speed: 1, epoch: 0 };
    flow = {
      runId: null, lastSeq: -1, seen: {}, queue: [], playing: false, timer: 0, loading: keep.loading, again: keep.again,
      picked: keep.picked, speed: keep.speed, epoch: keep.epoch,
      frames: [], pos: 0, running: false, replayTimer: 0, news: false, transient: [],
      view: { x: 0, y: 0, k: 1 }, panning: null,
      reduced: !!(reduceQuery && reduceQuery.matches),
      svg: null, root: null, laneLayer: null, edgeLayer: null, nodeLayer: null, packetLayer: null, tip: null,
      lanes: {}, nodes: {}, edges: {}, data: {}, inEdge: {}, labels: {}, loops: {}, hot: []
    };
  }
  flowReset();

  function svgEl(tag, cls, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute("class", cls);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
    return e;
  }
  function svgText(parent, cls, x, y, text) {
    var t = svgEl("text", cls, { x: x, y: y });
    t.textContent = text;
    return add(parent, t);
  }
  function clsOf(e) { return (e.getAttribute("class") || "").split(" ").filter(function (c) { return c; }); }
  function setCls(e, name, on) {
    var list = clsOf(e), i = list.indexOf(name);
    if (on && i < 0) list.push(name);
    if (!on && i >= 0) list.splice(i, 1);
    e.setAttribute("class", list.join(" "));
  }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function nodeTitle(n) {
    if (n.kind === "conductor") return "Conductor";
    if (n.kind === "integrator") return "Integrator";
    if (n.kind === "planner") return "Planner";
    return n.role || n.agentId || n.id;
  }
  function nodeAria(n, status) {
    var parts = [nodeTitle(n), STATUS[status] || status];
    if (n.taskId) parts.push(n.taskId);
    if (n.model) parts.push(n.model);
    if (n.durationMs !== null && n.durationMs !== undefined) parts.push(dur(n.durationMs));
    if (n.tokens !== null && n.tokens !== undefined) parts.push(compact(n.tokens) + " token");
    return parts.join(" · ");
  }
  function edgePath(a, b) {
    var x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    if (x2 <= x1) {
      // subagent indented under its parent: from the parent's bottom to the child's left edge
      x1 = a.x + 14; y1 = a.y + NODE_H;
      return "M" + x1 + " " + y1 + " L" + x1 + " " + y2 + " L" + x2 + " " + y2;
    }
    var mx = (x1 + x2) / 2;
    return "M" + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2;
  }

  function flowCanvas() { return $("flow").querySelector(".flow-canvas"); }
  function flowBar(sel) { return $("flow").querySelector(".flow-toolbar").querySelector(sel); }
  function flowReady() { return !!(document.createElementNS && $("flow")); }

  function flowShowEmpty() {
    flowCanvas().hidden = true;
    flowBar(".flow-run").textContent = "no run yet";
    flowBar(".flow-badge").hidden = true;
  }

  function flowBuild() {
    var canvas = clear(flowCanvas());
    canvas.hidden = false;
    var svg = svgEl("svg", "flow-svg", { role: "group", "aria-label": "Agent flow diagram by lane", width: 1, height: 1 });
    flow.svg = svg;
    flow.root = add(svg, svgEl("g", "flow-root"));
    flow.laneLayer = add(flow.root, svgEl("g", "flow-lanes"));
    flow.edgeLayer = add(flow.root, svgEl("g", "flow-edges"));
    flow.nodeLayer = add(flow.root, svgEl("g", "flow-nodes"));
    flow.packetLayer = add(flow.root, svgEl("g", "flow-packets", { "aria-hidden": "true" }));
    add(canvas, svg);
    flow.tip = el("div", "flow-tip");
    flow.tip.setAttribute("role", "tooltip");
    flow.tip.hidden = true;
    add(canvas, flow.tip);
    canvas.className = "flow-canvas";
  }

  function flowSync(layout, hideNew) {
    flow.svg.setAttribute("width", layout.width);
    flow.svg.setAttribute("height", layout.height);
    layout.lanes.forEach(function (lane, i) {
      var r = flow.lanes[lane.id];
      if (!r) {
        var g = svgEl("g", "flow-lane" + (i % 2 ? " odd" : ""), { "data-lane": lane.id });
        r = { bg: add(g, svgEl("rect", "flow-lane-bg", { x: 0 })), line: add(g, svgEl("line", "flow-lane-line", { x1: 0, x2: 0 })), txt: svgText(g, "flow-lane-label", 8, 0, lane.label) };
        add(flow.laneLayer, g);
        flow.lanes[lane.id] = r;
      }
      r.bg.setAttribute("y", lane.y); r.bg.setAttribute("width", layout.width); r.bg.setAttribute("height", lane.height);
      r.line.setAttribute("y1", lane.y); r.line.setAttribute("y2", lane.y); r.line.setAttribute("x2", layout.width);
      r.txt.setAttribute("y", lane.y + 16);
    });
    flow.data = {};
    layout.nodes.forEach(function (n) { flow.data[n.id] = n; });
    layout.nodes.forEach(function (n) {
      var r = flow.nodes[n.id];
      if (!r) r = flowBuildNode(n, hideNew);
      r.data = n;
      r.g.setAttribute("transform", "translate(" + n.x + " " + n.y + ")");
      r.g.setAttribute("aria-label", nodeAria(n, r.status));
    });
    flow.inEdge = {};
    layout.edges.forEach(function (e) {
      var a = flow.data[e.from], b = flow.data[e.to];
      if (!a || !b) return;
      if (e.kind !== "integrate" && !flow.inEdge[e.to]) flow.inEdge[e.to] = e;
      var r = flow.edges[e.id];
      if (!r) {
        var p = svgEl("path", "flow-edge e-" + e.kind + (hideNew ? " is-hidden" : ""), { "data-edge": e.id, "aria-hidden": "true" });
        add(flow.edgeLayer, p);
        r = flow.edges[e.id] = { path: p, e: e, d: "" };
      }
      r.e = e;
      r.d = edgePath(a, b);
      r.path.setAttribute("d", r.d);
    });
  }

  function flowBuildNode(n, hidden) {
    var g = svgEl("g", "flow-node st-" + n.status + (hidden ? " is-hidden" : ""), {
      "data-node": n.id, tabindex: 0, role: "img", "aria-label": nodeAria(n, n.status)
    });
    var body = add(g, svgEl("g", "flow-body"));
    var halo = add(body, svgEl("rect", "flow-halo", { x: -3, y: -3, width: NODE_W + 6, height: NODE_H + 6, rx: 9 }));
    add(body, svgEl("rect", "flow-box", { x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 7 }));
    add(body, svgEl("circle", "flow-dot", { cx: 12, cy: 14, r: 4 }));
    svgText(body, "flow-title", 24, 18, clip(nodeTitle(n), 20));
    var sub = svgText(body, "flow-sub", 12, 33, clip(flow.labels[n.id] || n.taskId || "", 24));
    add(flow.nodeLayer, g);
    var r = flow.nodes[n.id] = { g: g, body: body, halo: halo, sub: sub, data: n, status: n.status };
    g.addEventListener("mouseenter", function () { flowHover(n.id); });
    g.addEventListener("mouseleave", flowUnhover);
    g.addEventListener("focus", function () { flowHover(n.id); });
    g.addEventListener("blur", flowUnhover);
    g.addEventListener("keydown", function (e) { if (e.key === "Escape") flowUnhover(); });
    return r;
  }

  // ---- hover / focus: highlight the conductor → node path + tooltip ----
  function flowUnhover() {
    flow.hot.forEach(function (x) { setCls(x, "hot", false); });
    flow.hot = [];
    setCls(flowCanvas(), "hovering", false);
    if (flow.tip) flow.tip.hidden = true;
  }
  function flowHover(id) {
    flowUnhover();
    var seen = {}, cur = id;
    var mark = function (x) { setCls(x, "hot", true); flow.hot.push(x); };
    while (cur && !seen[cur] && flow.nodes[cur]) {
      seen[cur] = true;
      mark(flow.nodes[cur].g);
      var e = flow.inEdge[cur];
      if (!e || !flow.edges[e.id]) break;
      mark(flow.edges[e.id].path);
      cur = e.from;
    }
    setCls(flowCanvas(), "hovering", true);
    var r = flow.nodes[id], n = r.data, tip = clear(flow.tip);
    add(tip, el("strong", null, nodeTitle(n)));
    [["Status", STATUS[r.status] || r.status], ["Model", n.model || "—"], ["Task", n.taskId || "—"],
      ["Duration", dur(n.durationMs)], ["Token", compact(n.tokens)]].forEach(function (row) {
      add(tip, el("div", null, row[0] + ": " + row[1]));
    });
    flow.tip.style.left = (n.x * flow.view.k + flow.view.x) + "px";
    flow.tip.style.top = ((n.y + NODE_H + 6) * flow.view.k + flow.view.y) + "px";
    flow.tip.hidden = false;
  }

  // ---- effects: each frame effect is one DOM operation / one Web Animation ----
  function canAnimate(node) { return !flow.reduced && typeof node.animate === "function"; }
  // one-shot animation (spawn/shake/fadeOut/packet): remembered so seeking can cancel it midway
  function track(a) {
    flow.transient = flow.transient.filter(function (x) { return x.playState === "running" || x.playState === "pending"; });
    flow.transient.push(a);
    return a;
  }
  function stopLoop(key) {
    var a = flow.loops[key];
    if (a) { try { a.cancel(); } catch (err) { /* already cancelled */ } delete flow.loops[key]; }
  }
  function startLoop(key, node, keyframes, opts) {
    stopLoop(key);
    if (canAnimate(node)) flow.loops[key] = node.animate(keyframes, opts);
  }
  function pulseOn(id) {
    var r = flow.nodes[id];
    if (r) startLoop("pulse:" + id, r.halo, [{ opacity: 0.8, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.18)" }], { duration: 1400, iterations: Infinity, easing: "ease-out" });
  }
  function blinkOn(id) {
    var r = flow.nodes[id];
    if (r) startLoop("pulse:" + id, r.halo, [{ opacity: 0.9 }, { opacity: 0.1 }], { duration: 2400, iterations: Infinity, direction: "alternate" });
  }
  function setStatus(id, status) {
    var r = flow.nodes[id];
    if (!r) return;
    NODE_STATUSES.forEach(function (s) { setCls(r.g, "st-" + s, false); });
    setCls(r.g, "st-" + status, true);
    r.status = status;
    r.g.setAttribute("aria-label", nodeAria(r.data, status));
    // loop follows status: running → pulse, signal lost → slow blink, otherwise stop
    if (status === "running") pulseOn(id);
    else if (status === "lost") blinkOn(id);
    else stopLoop("pulse:" + id);
  }
  function revealNode(id) {
    var r = flow.nodes[id];
    if (r) setCls(r.g, "is-hidden", false);
    return r;
  }
  function revealEdge(id, both) {
    var r = flow.edges[id];
    if (!r) return null;
    setCls(r.path, "is-hidden", false);
    revealNode(r.e.from);
    if (both) revealNode(r.e.to);
    return r;
  }

  // Returns how many one-shot animations ran (to know whether to wait between frames).
  function playEffect(fx, instant) {
    var r = fx.node ? flow.nodes[fx.node] : null, played = 0;
    switch (fx.type) {
      case "show":
        revealNode(fx.node);
        break;
      case "spawn":
        if (!r) break;
        revealNode(fx.node);
        if (!instant && canAnimate(r.body)) {
          track(r.body.animate([{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 300, easing: "ease-out" }));
          played++;
        }
        break;
      case "pulse": pulseOn(fx.node); break;
      case "stopPulse": stopLoop("pulse:" + fx.node); break;
      case "blink": blinkOn(fx.node); break;
      case "shake":
        if (r && !instant && canAnimate(r.body)) {
          track(r.body.animate([{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], { duration: 400 }));
          played++;
        }
        break;
      case "fadeOut":
        if (!r) break;
        stopLoop("pulse:" + fx.node);
        if (!instant && canAnimate(r.g)) {
          var fade = track(r.g.animate([{ opacity: 1 }, { opacity: 0.4 }], { duration: 500 }));
          fade.onfinish = function () { setCls(r.g, "is-faded", true); };
          played++;
        } else setCls(r.g, "is-faded", true);
        break;
      case "status": setStatus(fx.node, fx.status); break;
      case "label":
        flow.labels[fx.node] = fx.text;
        if (r) r.sub.textContent = clip(fx.text, 24);
        break;
      case "badge":
        flowBar(".flow-badge").textContent = fx.text;
        flowBar(".flow-badge").hidden = false;
        break;
      case "packet": {
        var er = revealEdge(fx.edge, flow.edges[fx.edge] && flow.edges[fx.edge].e.kind === "integrate");
        if (!er || instant || flow.reduced || !flow.packetLayer || typeof flow.packetLayer.appendChild !== "function") break;
        var pk = svgEl("path", "flow-packet" + (fx.reverse ? " back" : ""), { d: er.d, pathLength: 100, "stroke-dasharray": "4 200" });
        if (typeof pk.animate !== "function") break;
        add(flow.packetLayer, pk);
        var a = track(pk.animate(fx.reverse ? [{ strokeDashoffset: -100 }, { strokeDashoffset: 4 }] : [{ strokeDashoffset: 4 }, { strokeDashoffset: -100 }], { duration: 700, easing: "ease-in-out" }));
        a.onfinish = function () { flow.packetLayer.removeChild(pk); };
        played++;
        break;
      }
      case "dash": {
        var dr = flow.edges[fx.edge];
        if (!dr) break;
        stopLoop("dash:" + fx.edge);
        setCls(dr.path, "is-flow", fx.on);
        if (fx.on) startLoop("dash:" + fx.edge, dr.path, [{ strokeDashoffset: 12 }, { strokeDashoffset: 0 }], { duration: 900, iterations: Infinity });
        break;
      }
      default:
    }
    return played;
  }

  function playFrame(f, instant) {
    var played = 0;
    (f.effects || []).forEach(function (fx) {
      try { played += playEffect(fx, instant); } catch (err) { /* one broken effect must not jam the queue */ }
    });
    return played;
  }

  function flowSettle() {
    // queue drained: new nodes/edges no frame mentioned must still show
    Object.keys(flow.nodes).forEach(function (id) { setCls(flow.nodes[id].g, "is-hidden", false); });
    Object.keys(flow.edges).forEach(function (id) { setCls(flow.edges[id].path, "is-hidden", false); });
  }
  function flowStep() {
    flow.timer = 0;
    for (;;) {
      var f = flow.queue.shift();
      if (!f) { flow.playing = false; flowSettle(); return; }
      // backlog over threshold → apply the final state directly, no motion
      var played = playFrame(f, flow.reduced || flow.queue.length >= FLOW_BACKLOG);
      if (played > 0 && typeof setTimeout === "function") { flow.timer = setTimeout(flowStep, FRAME_GAP_MS); return; }
    }
  }
  // true for a new frame: remember id + last seq so the next request asks only for new ones ("signal lost" frames excluded)
  function flowNote(f) {
    if (!f || flow.seen[f.id]) return false;
    flow.seen[f.id] = true;
    if (typeof f.seqEnd === "number" && String(f.id).indexOf("lost:") !== 0 && f.seqEnd > flow.lastSeq) flow.lastSeq = f.seqEnd;
    return true;
  }
  function flowIngest(frames, instant) {
    (frames || []).forEach(function (f) {
      if (!flowNote(f)) return;
      if (instant) playFrame(f, true);
      else flow.queue.push(f);
    });
    if (!instant && !flow.playing && flow.queue.length) { flow.playing = true; flowStep(); }
  }

  // Returns true when the run changed midway: reload from scratch (no after) to rebuild.
  function flowApply(res) {
    if (!res || !res.layout || !res.layout.nodes || !res.layout.lanes) return false;
    flowRuns(res.runs);
    if (res.runId === null || res.runId === undefined) {
      if (flow.runId !== null) flowReset();
      flowShowEmpty();
      flowControls();
      return false;
    }
    var replay = flow.picked !== null;
    var fresh = flow.runId === null;
    if (!fresh && res.runId !== flow.runId) { flowReset(); return true; }
    if (fresh) {
      flow.runId = res.runId;
      flowBuild();
    }
    // replay: every node/edge starts hidden and appears as the viewer seeks forward
    flowSync(res.layout, !fresh || replay);
    flowBar(".flow-run").textContent = (replay ? "Replaying run " : "Run ") + res.runId + " · " + res.layout.nodes.length + " nodes";
    flowBar(".flow-note").textContent = flow.reduced ? "Reduced motion: effects off, colors and labels still update" : "";
    if (replay) {
      var before = flow.frames.length;
      (res.frames || []).forEach(function (f) { if (flowNote(f)) flow.frames.push(f); });
      if (fresh) {
        flowRewind();
        flowControls();
        flowSetRunning(flow.frames.length > 0);
        return false;
      }
      // while replaying, an SSE change does NOT jump back to live; it only shows a marker
      if (flow.frames.length > before) flow.news = true;
    } else {
      flowIngest(res.frames, fresh);
    }
    flowControls();
    return false;
  }

  function flowLoad() {
    if (!flowReady()) return;
    if (flow.loading) { flow.again = true; return; }
    flow.loading = true;
    var epoch = flow.epoch;
    var q = [];
    if (flow.picked !== null) q.push("runId=" + encodeURIComponent(flow.picked));
    if (flow.runId !== null && flow.lastSeq >= 0) q.push("after=" + flow.lastSeq);
    if (flow.reduced) q.push("reducedMotion=1");
    var url = FLOW_URL + (q.length ? "?" + q.join("&") : "");
    fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      flow.loading = false;
      if (flow.epoch !== epoch) flow.again = true; // user switched runs while waiting: drop the stale response
      else if (flowApply(res)) flow.again = true;
      if (flow.again) { flow.again = false; flowLoad(); }
    }).catch(function () { flow.loading = false; });
  }

  // ---- replay (A-048): only re-applies existing frames; guesses nothing ----
  var lastRunsSig = null;
  function flowRuns(runs) {
    var list = runs || [], sig = list.map(function (r) { return r.runId; }).join("|");
    var sel = $("flow-run");
    if (sig !== lastRunsSig) {
      lastRunsSig = sig;
      clear(sel);
      var first = el("option", null, "Live (latest run)");
      first.value = "";
      add(sel, first);
      list.forEach(function (r) {
        var o = el("option", null, "Run " + r.runId + (r.endedAt ? "" : " · running"));
        o.value = r.runId;
        add(sel, o);
      });
    }
    sel.value = flow.picked === null ? "" : flow.picked;
  }

  // Reset every node/edge to the state BEFORE the first frame (hidden, waiting, no loops, no packets).
  function flowRewind() {
    Object.keys(flow.loops).forEach(stopLoop);
    flow.transient.forEach(function (a) { try { a.cancel(); } catch (err) { /* already finished */ } });
    flow.transient = [];
    if (flow.packetLayer) clear(flow.packetLayer);
    flow.labels = {};
    Object.keys(flow.nodes).forEach(function (id) {
      var r = flow.nodes[id];
      setCls(r.g, "is-hidden", true);
      setCls(r.g, "is-faded", false);
      setStatus(id, "waiting");
      r.sub.textContent = clip(r.data.taskId || "", 24);
    });
    Object.keys(flow.edges).forEach(function (id) {
      setCls(flow.edges[id].path, "is-hidden", true);
      setCls(flow.edges[id].path, "is-flow", false);
    });
    var badge = flowBar(".flow-badge");
    badge.textContent = "";
    badge.hidden = true;
    flow.pos = 0;
  }

  // Seek to k applied frames. Forward applies more, backward rebuilds from the start; the last frame only animates when animate = true.
  function flowSeek(k, animate) {
    var n = flow.frames.length;
    k = Math.max(0, Math.min(n, Math.round(k) || 0));
    if (k < flow.pos) flowRewind();
    while (flow.pos < k) {
      var last = flow.pos === k - 1;
      playFrame(flow.frames[flow.pos], !(animate && last) || flow.reduced);
      flow.pos++;
    }
    // end of run: nodes/edges no frame mentioned (whole-run layout) still show
    if (flow.pos >= n) flowSettle();
    flowControls();
  }

  function flowSetRunning(on) {
    if (flow.replayTimer) { clearTimeout(flow.replayTimer); flow.replayTimer = 0; }
    flow.running = !!on && flow.picked !== null && flow.frames.length > 0;
    if (flow.running && flow.pos >= flow.frames.length) flowSeek(0, false);
    flowControls();
    if (flow.running) flowTick();
  }
  function flowTick() {
    flow.replayTimer = 0;
    if (!flow.running) return;
    var cur = flow.frames[flow.pos];
    if (!cur) { flowSetRunning(false); return; }
    flowSeek(flow.pos + 1, true);
    var next = flow.frames[flow.pos];
    if (!next) { flowSetRunning(false); return; }
    // gap = real time divided by speed, clamped to [150 ms, 3 s] so long runs stay watchable
    var gap = Math.max(150, Math.min(3000, (next.at - cur.at) / flow.speed));
    if (!(gap >= 150)) gap = 150;
    if (typeof setTimeout === "function") flow.replayTimer = setTimeout(flowTick, gap);
  }

  function flowControls() {
    var replay = flow.picked !== null, n = flow.frames.length;
    var live = $("flow-live");
    live.setAttribute("aria-pressed", replay ? "false" : "true");
    live.disabled = !replay;
    flowBar(".flow-replay").hidden = !replay;
    $("flow-new").hidden = !(replay && flow.news);
    $("flow-run").value = replay ? flow.picked : "";
    var play = $("flow-play");
    play.textContent = flow.running ? "Pause" : "Play";
    play.setAttribute("aria-pressed", flow.running ? "true" : "false");
    $("flow-step-back").disabled = flow.pos <= 0;
    $("flow-step-fwd").disabled = flow.pos >= n;
    var scrub = $("flow-scrub");
    scrub.setAttribute("max", String(n));
    scrub.value = String(flow.pos);
    flowBar(".flow-pos").textContent = flow.pos + " / " + n;
    [1, 4, 16].forEach(function (s) { $("flow-speed-" + s).setAttribute("aria-pressed", flow.speed === s ? "true" : "false"); });
  }

  function flowChoose(value) {
    var next = value === "" || value === null ? null : String(value);
    flowReset();
    flow.picked = next;
    flowControls();
    flowLoad();
  }

  // ---- pan / zoom: one transform on the root <g>, scale clamped to [0.25, 4] ----
  var ZOOM_MIN = 0.25;
  var ZOOM_MAX = 4;
  function flowApplyView() {
    var v = flow.view, canvas = flowCanvas();
    v.k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k));
    var cw = canvas.clientWidth || 0, ch = canvas.clientHeight || 0;
    var w = Number(flow.svg && flow.svg.getAttribute("width")) || 0, h = Number(flow.svg && flow.svg.getAttribute("height")) || 0;
    if (cw && w) v.x = Math.max(40 - w * v.k, Math.min(cw - 40, v.x)); // always keep part of the diagram in view
    if (ch && h) v.y = Math.max(40 - h * v.k, Math.min(ch - 40, v.y));
    if (flow.root) flow.root.setAttribute("transform", "translate(" + v.x + " " + v.y + ") scale(" + v.k + ")");
    if (flow.tip) flow.tip.hidden = true;
  }
  function flowZoomAt(px, py, factor) {
    var v = flow.view, nk = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * factor));
    v.x = px - (px - v.x) * (nk / v.k);
    v.y = py - (py - v.y) * (nk / v.k);
    v.k = nk;
    flowApplyView();
  }
  function flowZoomCenter(factor) {
    var c = flowCanvas();
    flowZoomAt((c.clientWidth || 0) / 2, (c.clientHeight || 0) / 2, factor);
  }
  function flowFit() {
    var c = flowCanvas(), w = Number(flow.svg && flow.svg.getAttribute("width")) || 0;
    flow.view.x = 0; flow.view.y = 0;
    flow.view.k = c.clientWidth && w ? Math.min(1, c.clientWidth / w) : 1;
    flowApplyView();
  }
  function flowBind() {
    var canvas = flowCanvas();
    var local = function (e) {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var p = local(e);
      flowZoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    canvas.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      flow.panning = { id: e.pointerId, x: e.clientX, y: e.clientY };
      setCls(canvas, "panning", true);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer capture failed: dragging still works inside the canvas */ }
    });
    canvas.addEventListener("pointermove", function (e) {
      var p = flow.panning;
      if (!p || p.id !== e.pointerId) return;
      flow.view.x += e.clientX - p.x;
      flow.view.y += e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      flowApplyView();
    });
    var end = function (e) {
      if (!flow.panning || flow.panning.id !== e.pointerId) return;
      flow.panning = null;
      setCls(canvas, "panning", false);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    $("flow-zoom-in").addEventListener("click", function () { flowZoomCenter(1.25); });
    $("flow-zoom-out").addEventListener("click", function () { flowZoomCenter(1 / 1.25); });
    $("flow-zoom-fit").addEventListener("click", flowFit);

    $("flow-run").addEventListener("change", function () { flowChoose($("flow-run").value); });
    $("flow-live").addEventListener("click", function () { flowChoose(null); });
    $("flow-play").addEventListener("click", function () { flowSetRunning(!flow.running); });
    $("flow-step-back").addEventListener("click", function () { flowSetRunning(false); flowSeek(flow.pos - 1, false); });
    $("flow-step-fwd").addEventListener("click", function () { flowSetRunning(false); flowSeek(flow.pos + 1, true); });
    $("flow-scrub").addEventListener("input", function () { flowSetRunning(false); flowSeek(Number($("flow-scrub").value), false); });
    [1, 4, 16].forEach(function (s) {
      $("flow-speed-" + s).addEventListener("click", function () { flow.speed = s; flowControls(); });
    });
  }
  if (flowReady()) flowBind();
  if (reduceQuery && reduceQuery.addEventListener) {
    reduceQuery.addEventListener("change", function () { flowReset(); flowLoad(); });
  }

  // ---- data wiring ------------------------------------------------------------------------------------------
  function conn(kind) {
    $("conn").textContent = kind === "live" ? "live (SSE)" : kind === "poll" ? "polling every 2 s" : "disconnected";
    $("dot").className = "dot " + kind;
  }
  function apply(s) { state = s; render(); flowLoad(); }
  function fetchState() {
    fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      apply(s);
      if (pollTimer) conn("poll");
    }).catch(function () { conn("off"); });
  }
  function startPoll() {
    if (pollTimer) return;
    fetchState();
    pollTimer = setInterval(fetchState, 2000);
    conn("poll");
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function connect() {
    if (typeof EventSource === "undefined") { startPoll(); return; }
    var es = new EventSource("/api/stream");
    es.addEventListener("state", function (e) {
      try { apply(JSON.parse(e.data)); } catch (err) { /* broken frame: wait for the next one */ }
    });
    es.onopen = function () { stopPoll(); conn("live"); };
    es.onerror = function () { startPoll(); };
  }

  $("tab-verify").addEventListener("click", function () { setTab("verify"); });
  $("tab-log").addEventListener("click", function () { setTab("log"); });
  $("agents").querySelector(".tabs").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    var next = sel.tab === "verify" ? "log" : "verify";
    setTab(next);
    $("tab-" + next).focus();
  });
  if (narrowQuery && narrowQuery.addEventListener) narrowQuery.addEventListener("change", function () { if (state) render(); });
  flowLoad();
  fetchState();
  connect();
})();
</script>
</body>
</html>
`;
