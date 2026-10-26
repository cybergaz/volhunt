#!/usr/bin/env bun
// volhunt — CoinDCX futures volatility scanner + paper scalper (TUI).
import { parseArgs } from "node:util";
import { activePairs, book, candles1m, inrRate, pool, tickers, type Book, type Ticker } from "./api";
import { compute, type Metrics } from "./metrics";
import { Paper, type Side } from "./paper";

const SORTS = ["score", "atr", "5m", "surge", "range"] as const;
type Sort = (typeof SORTS)[number];

const { values: argv } = parseArgs({
  options: {
    sort: { type: "string", default: "score" },
    lev: { type: "string", default: "15" },
    currency: { type: "string", default: "inr" }, // inr | usdt — display currency, toggle with i
    margin: { type: "string" }, // per paper trade, in --currency (default ₹2000 / 20 USDT)
    tp: { type: "string", default: "1.5" }, // take-profit distance, in 1m ATRs
    sl: { type: "string", default: "1" }, // stop-loss distance, in 1m ATRs
    fee: { type: "string", default: "0.059" }, // taker fee % per leg (CoinDCX incl. GST)
    "min-vol": { type: "string", default: "1000000" }, // min 24h volume, USDT
    top: { type: "string", default: "30" }, // hottest pairs re-scanned every cycle
    once: { type: "boolean", default: false }, // print one ranked table and exit
    help: { type: "boolean", short: "h", default: false },
  },
});

if (argv.help) {
  console.log(`volhunt — rank CoinDCX futures by short-term volatility, paper-scalp the top ones.

usage: bun src/main.ts [--sort ${SORTS.join("|")}] [--lev 15] [--currency inr|usdt] [--margin 2000]
                       [--tp 1.5] [--sl 1] [--fee 0.059]
                       [--min-vol 1000000] [--top 30] [--once]

  --tp/--sl   distances in 1-minute ATRs, so targets scale with how much each pair moves
  --margin    paper margin per trade, in --currency
  --once      print a single ranked table (pipe-friendly) and exit`);
  process.exit(0);
}

const cfg = {
  lev: +argv.lev!,
  margin: 0, // USDT, set once the INR rate is known
  tpAtr: +argv.tp!,
  slAtr: +argv.sl!,
  fee: +argv.fee!,
  minVol: +argv["min-vol"]!,
  top: +argv.top!,
};

// ── state ────────────────────────────────────────────────────────────────────
let active = new Set<string>();
let ticks = new Map<string, Ticker>();
const metrics = new Map<string, Metrics>();
const books = new Map<string, Book>();
const paper = new Paper(cfg.fee);
let sortIdx = Math.max(0, SORTS.indexOf(argv.sort as Sort));
let selPair = ""; // cursor follows the pair, not the row, so re-sorting doesn't yank it away
let sel = 0;
let top = 0; // first visible row
let page = 20; // visible rows, updated on render
let search: string | null = null;
let cur: "INR" | "USDT" = argv.currency!.toUpperCase() === "USDT" ? "USDT" : "INR";
let rate = 0; // INR per USDT
let msg = "scanning…";
let lastScan = 0;
let cursor = 0; // round-robin position over the whole liquid universe

const name = (pair: string) => pair.replace(/^B-/, "").replace(/_USDT$/, "");
const range24 = (t: Ticker) => ((t.high - t.low) / t.last) * 100;
const liquid = () =>
  [...ticks.values()].filter((t) => active.has(t.pair) && t.vol >= cfg.minVol && t.last > 0);

async function refreshPrices() {
  ticks = await tickers();
  for (const p of [...paper.positions.values()]) {
    const t = ticks.get(p.pair);
    if (!t) continue;
    const c = paper.check(p.pair, t.last, metrics.get(p.pair)?.spreadPct ?? 0);
    if (c) msg = `${c.reason} ${name(c.pair)} ${c.side > 0 ? "LONG" : "SHORT"} → ${money(c.pnl)} (${sign(c.roe, 1)}% ROE)`;
  }
}

async function scan(pairs: string[]) {
  await pool(pairs, 8, async (pair) => {
    const [cs, b] = await Promise.all([candles1m(pair, 60), book(pair).catch(() => undefined)]);
    if (b) books.set(pair, b);
    const t = ticks.get(pair);
    const m = t && compute(t, cs, b, cfg.fee);
    if (m) metrics.set(pair, m);
  });
  lastScan = Date.now();
}

/** Each cycle: the current hottest pairs + open positions + the next slice of everything else. */
function scanSet(): string[] {
  const all = liquid().sort((a, b) => range24(b) - range24(a)).map((t) => t.pair);
  const hot = [...metrics.entries()]
    .filter(([p]) => ticks.has(p))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, cfg.top)
    .map(([p]) => p);
  const seed = metrics.size ? [] : all.slice(0, cfg.top * 2); // first pass: biggest 24h ranges
  const sweep = all.slice(cursor, cursor + cfg.top);
  cursor = cursor + cfg.top >= all.length ? 0 : cursor + cfg.top;
  return [...new Set([...seed, ...hot, ...paper.positions.keys(), ...sweep])];
}

// ── rendering ────────────────────────────────────────────────────────────────
const C = { r: "\x1b[0m", dim: "\x1b[2m", b: "\x1b[1m", red: "\x1b[31m", grn: "\x1b[32m", ylw: "\x1b[33m", cyn: "\x1b[36m", inv: "\x1b[7m" };
const tty = process.stdout.isTTY;
const paint = (s: string, col: string) => (tty && col ? col + s + C.r : s);
const sign = (x: number, d: number) => (x >= 0 ? "+" : "") + x.toFixed(d);
const num = (x: number) => (x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
/** Prices and money are kept in USDT and converted only for display. */
const fmtPrice = (usdt: number) => (cur === "INR" ? "₹" + num(usdt * rate) : num(usdt));
const money = (usdt: number, signed = true) => {
  const [v, unit] = cur === "INR" ? [usdt * rate, "₹"] : [usdt, ""];
  const s = (signed && v >= 0 ? "+" : v < 0 ? "-" : "") + unit + Math.abs(v).toFixed(2);
  return cur === "INR" ? s : s + " USDT";
};
const pct = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) + "%" : "—");
const updown = (x: number) => (x > 0 ? C.grn : x < 0 ? C.red : "");
const SPARK = "▁▂▃▄▅▆▇█";
const spark = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return xs.map((x) => SPARK[hi > lo ? Math.round(((x - lo) / (hi - lo)) * 7) : 3]).join("");
};

type Row = { t: Ticker; m: Metrics };
type Col = { h: string; w: number; left?: boolean; sort?: Sort; f: (r: Row) => [string, string?] };
const cols: Col[] = [
  { h: "PAIR", w: 12, left: true, f: (r) => [name(r.t.pair), paper.positions.has(r.t.pair) ? C.cyn : ""] },
  { h: "PRICE", w: 10, f: (r) => [fmtPrice(r.t.last)] },
  { h: "24H", w: 7, f: (r) => [sign(r.t.chg, 1) + "%", updown(r.t.chg)] },
  { h: "RNG24", w: 6, sort: "range", f: (r) => [range24(r.t).toFixed(0) + "%", C.dim] },
  { h: "ATR1m", w: 6, sort: "atr", f: (r) => [pct(r.m.atrPct), r.m.atrPct >= 0.5 ? C.ylw + C.b : r.m.atrPct >= 0.25 ? C.ylw : ""] },
  { h: "ROE/c", w: 6, f: (r) => [pct(r.m.atrPct * cfg.lev, 1), C.b] },
  { h: "5M", w: 7, sort: "5m", f: (r) => [sign(r.m.move5m, 2) + "%", updown(r.m.move5m)] },
  { h: "VOL×", w: 5, sort: "surge", f: (r) => [r.m.volSurge.toFixed(1), r.m.volSurge >= 2 ? C.ylw : ""] },
  { h: "SPRD", w: 6, f: (r) => [pct(r.m.spreadPct, 3), r.m.spreadPct > 0.1 ? C.red : C.dim] },
  { h: "COST", w: 5, f: (r) => [(r.m.costOfAtr * 100).toFixed(0) + "%", r.m.costOfAtr > 0.5 ? C.red : r.m.costOfAtr > 0.25 ? C.ylw : C.grn] },
  { h: "SCORE", w: 6, sort: "score", f: (r) => [r.m.score.toFixed(2), C.b] },
];
const cell = (s: string, w: number, left?: boolean) => (left ? s.padEnd(w) : s.padStart(w)).slice(0, w);

const sortKey: Record<Sort, (r: Row) => number> = {
  score: (r) => r.m.score,
  atr: (r) => r.m.atrPct,
  "5m": (r) => Math.abs(r.m.move5m),
  surge: (r) => r.m.volSurge,
  range: (r) => range24(r.t),
};

function rows(): Row[] {
  const out: Row[] = [];
  for (const [pair, m] of metrics) {
    const t = ticks.get(pair);
    if (t) out.push({ t, m });
  }
  const k = sortKey[SORTS[sortIdx]];
  return out.sort((a, b) => k(b) - k(a));
}

/** Keep the cursor on `selPair` and the viewport around the cursor. */
function syncCursor(rs: Row[]) {
  const i = rs.findIndex((r) => r.t.pair === selPair);
  sel = i >= 0 ? i : Math.min(sel, Math.max(0, rs.length - 1));
  selPair = rs[sel]?.t.pair ?? "";
  if (sel < top) top = sel;
  if (sel >= top + page) top = sel - page + 1;
  top = Math.max(0, Math.min(top, Math.max(0, rs.length - page)));
}

function table(rs: Row[], from: number, limit: number, selIdx = -1): string[] {
  const sorted = SORTS[sortIdx];
  const head = cols.map((c) => (c.sort === sorted ? paint(cell("▼" + c.h, c.w, c.left), C.b + C.cyn) : paint(cell(c.h, c.w, c.left), C.dim)));
  const lines = [paint("   #  ", C.dim) + head.join(" ")];
  rs.slice(from, from + limit).forEach((r, j) => {
    const i = from + j;
    const body = cols.map((c) => {
      const [s, col] = c.f(r);
      const hot = c.sort === sorted ? C.b : ""; // sorted column's values in bold
      // no styling inside the selected row: a reset there would cancel its inverse highlight
      return paint(cell(s, c.w, c.left), i === selIdx ? "" : (col ?? "") + hot);
    });
    const line = (i === selIdx ? "▶" : " ") + String(i + 1).padStart(3) + "  " + body.join(" ");
    lines.push(i === selIdx && tty ? C.inv + line + C.r : line);
  });
  return lines;
}

function detail(r: Row | undefined): string[] {
  if (!r) return ["", ""];
  const { t, m } = r;
  const tpRoe = cfg.lev * (cfg.tpAtr * m.atrPct - m.costPct);
  const slRoe = -cfg.lev * (cfg.slAtr * m.atrPct + m.costPct);
  return [
    paint(name(t.pair), C.b) + "  " + spark(m.candles.slice(-40).map((k) => k.c)) + paint("  last 40m", C.dim),
    `  if TP hits (${cfg.tpAtr} ATR): ${paint(sign(tpRoe, 1) + "% ROE", C.grn)}   if SL hits (${cfg.slAtr} ATR): ${paint(sign(slRoe, 1) + "% ROE", C.red)}` +
      paint(`   net of ${m.costPct.toFixed(3)}% fees+spread · funding ${(t.funding * 100).toFixed(4)}%`, C.dim),
  ];
}

function positionsPanel(): string[] {
  const s = paper.stats();
  const head = `── paper ── ${s.n} closed · ${s.wins}W/${s.n - s.wins}L · net ${money(s.net)}`;
  const out = [paint(head, C.dim)];
  for (const p of paper.positions.values()) {
    const t = ticks.get(p.pair);
    if (!t) continue;
    const v = paper.value(p, t.last, metrics.get(p.pair)?.spreadPct ?? 0);
    const age = Math.floor((Date.now() - p.openedAt) / 1000);
    out.push(
      `  ${paint(name(p.pair).padEnd(10), C.cyn)} ${paint(p.side > 0 ? "LONG " : "SHORT", p.side > 0 ? C.grn : C.red)} ${p.lev}×` +
        `  entry ${fmtPrice(p.entry)}  now ${fmtPrice(t.last)}  ${paint(`${sign(v.roe, 1)}% (${money(v.pnl)})`, updown(v.pnl) + C.b)}` +
        paint(`  TP ${fmtPrice(p.tp)} SL ${fmtPrice(p.sl)}  ${Math.floor(age / 60)}m${String(age % 60).padStart(2, "0")}s`, C.dim),
    );
  }
  return out;
}

function render() {
  const H = process.stdout.rows || 40;
  const rs = rows();
  const panel = positionsPanel();
  const fixed = 1 + 1 + 2 + panel.length + 2 + 1; // title, header, detail, panel, msg, keys
  page = Math.max(3, H - fixed);
  syncCursor(rs);
  const age = lastScan ? Math.round((Date.now() - lastScan) / 1000) + "s" : "…";
  const shown = rs.length ? `${top + 1}–${Math.min(top + page, rs.length)} of ${rs.length}` : "0";
  const title =
    paint("volhunt", C.b + C.ylw) +
    `  sort ${paint("▼" + SORTS[sortIdx], C.b + C.cyn)}  lev ${paint(cfg.lev + "×", C.b)}  margin ${money(cfg.margin, false)}  ${paint(cur === "INR" ? `₹${rate}/USDT` : "USDT", C.cyn)}` +
    paint(`  · CoinDCX futures · rows ${shown} · ${metrics.size}/${liquid().length} scanned · scan ${age} ago`, C.dim);
  const out = [
    title,
    ...table(rs, top, page, sel),
    ...detail(rs[sel]),
    ...panel,
    "",
    search !== null ? paint(`/${search}▏  (enter jump · esc cancel)`, C.cyn + C.b) : paint(msg, C.ylw),
    paint(
      `j/k move · PgDn/PgUp page · g/G ends · / find · sort ${SORTS.map((s, i) => `${i + 1}:${s}`).join(" ")} · ` +
        "i ₹/USDT · l/s long/short · c/C close · +/- lev · q quit",
      C.dim,
    ),
  ];
  const W = process.stdout.columns || 200;
  process.stdout.write("\x1b[H" + out.map((l) => clip(l, W) + "\x1b[K").join("\n") + "\x1b[J");
}

/** Cut a line to `w` visible columns, skipping ANSI escapes, so nothing wraps and scrolls the screen. */
function clip(s: string, w: number): string {
  let out = "", n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const j = s.indexOf("m", i);
      out += s.slice(i, j + 1);
      i = j;
    } else if (n < w) (out += s[i]), n++;
  }
  return out;
}

// ── input ────────────────────────────────────────────────────────────────────
const current = () => rows().find((r) => r.t.pair === selPair);

function trade(side: Side) {
  const r = current();
  if (!r) return;
  if (paper.positions.has(r.t.pair)) return void (msg = `already in ${name(r.t.pair)} — c to close`);
  const atr = (r.m.atrPct / 100) * r.t.last;
  const p = paper.open(r.t.pair, side, r.t.last, r.m.spreadPct, atr, { lev: cfg.lev, margin: cfg.margin, tpAtr: cfg.tpAtr, slAtr: cfg.slAtr });
  msg = `opened ${side > 0 ? "LONG" : "SHORT"} ${name(p.pair)} @ ${fmtPrice(p.entry)}  TP ${fmtPrice(p.tp)} (${sign(paper.roeAt(p, p.tp, r.m.spreadPct), 1)}%)  SL ${fmtPrice(p.sl)} (${sign(paper.roeAt(p, p.sl, r.m.spreadPct), 1)}%)`;
}

function closeOne(pair: string) {
  const t = ticks.get(pair);
  const c = t && paper.close(pair, t.last, metrics.get(pair)?.spreadPct ?? 0, "manual");
  if (c) msg = `closed ${name(pair)} → ${money(c.pnl)} (${sign(c.roe, 1)}% ROE)`;
}

/** Jump to a pair by name; scans it first if it hasn't been scanned yet. */
async function find(q: string) {
  const Q = q.trim().toUpperCase();
  if (!Q) return;
  const names = [...ticks.keys()].filter((p) => active.has(p));
  const hit = names.find((p) => name(p) === Q) ?? names.find((p) => name(p).startsWith(Q)) ?? names.find((p) => name(p).includes(Q));
  if (!hit) return void (msg = `no futures pair matching "${q}"`);
  if (!metrics.has(hit)) {
    msg = `scanning ${name(hit)}…`;
    render();
    await scan([hit]);
  }
  selPair = hit;
  msg = metrics.has(hit) ? `→ ${name(hit)}` : `couldn't load ${name(hit)}`;
}

function quit() {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  const s = paper.stats();
  if (s.n) console.log(`paper session: ${s.n} trades, ${s.wins} wins, net ${money(s.net)} · log: ${paper.logPath}`);
  process.exit(0);
}

function move(to: number) {
  const rs = rows();
  sel = Math.max(0, Math.min(to, rs.length - 1));
  selPair = rs[sel]?.t.pair ?? "";
}

function onSearchKey(k: string) {
  if (k === "\r" || k === "\n") {
    const q = search!;
    search = null;
    find(q).finally(render);
  } else if (k === "\x1b" || k === "\x03") search = null;
  else if (k === "\x7f" || k === "\b") search = search!.slice(0, -1);
  else if (/^[\w-]+$/.test(k)) search += k;
}

function onKey(k: string) {
  if (search !== null) return void (onSearchKey(k), render());
  if (k === "q" || k === "\x03") quit();
  else if (k === "j" || k === "\x1b[B") move(sel + 1);
  else if (k === "k" || k === "\x1b[A") move(sel - 1);
  else if (k === "\x1b[6~" || k === "\x04" || k === " ") move(sel + page);
  else if (k === "\x1b[5~" || k === "\x15") move(sel - page);
  else if (k === "g" || k === "\x1b[H") move(0);
  else if (k === "G" || k === "\x1b[F") move(Infinity);
  else if (k === "/") search = "";
  else if (k === "\t" || /^[1-5]$/.test(k)) {
    sortIdx = k === "\t" ? (sortIdx + 1) % SORTS.length : +k - 1;
    msg = `sort: ${SORTS[sortIdx]}`;
    move(0);
  }
  else if (k === "i" && rate) (cur = cur === "INR" ? "USDT" : "INR"), (msg = `showing ${cur}`);
  else if (k === "+" || k === "=") cfg.lev = Math.min(cfg.lev + 1, 100);
  else if (k === "-") cfg.lev = Math.max(cfg.lev - 1, 1);
  else if (k === "l") trade(1);
  else if (k === "s") trade(-1);
  else if (k === "c") {
    if (paper.positions.has(selPair)) closeOne(selPair);
    else msg = "no position on selected pair";
  } else if (k === "C") for (const p of [...paper.positions.keys()]) closeOne(p);
  render();
}

// ── main ─────────────────────────────────────────────────────────────────────
active = new Set(await activePairs());
await refreshPrices();
rate = await inrRate().catch(() => 0);
if (!rate) cur = "USDT";
const marginIn = argv.margin ? +argv.margin : cur === "INR" ? 2000 : 20;
cfg.margin = cur === "INR" ? marginIn / rate : marginIn;

if (argv.once) {
  await scan(scanSet());
  console.log(table(rows(), 0, cfg.top).join("\n"));
  process.exit(0);
}

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
// One chunk can hold several keys (fast typing, paste): split into escape sequences and single chars.
process.stdin.on("data", (d: string) => {
  for (const k of d.match(/\x1b\[[0-9;]*[~A-Za-z]|[\s\S]/g) ?? []) onKey(k);
});
process.on("SIGINT", quit);
process.stdout.on("resize", render);

const loop = async (fn: () => Promise<void>, ms: number) => {
  for (;;) {
    await fn().catch((e) => (msg = `error: ${e.message}`));
    await Bun.sleep(ms);
  }
};
render();
loop(refreshPrices, 2000);
loop(async () => {
  await scan(scanSet());
  if (msg === "scanning…") msg = "ready — j/k to browse, l/s to paper-trade the selected pair";
}, 10_000);
setInterval(render, 1000);
