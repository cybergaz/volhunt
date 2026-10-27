import type { Book, Candle, Instrument, Ticker } from "./api";

export type Metrics = {
  atrPct: number; // ATR(14) on 1m candles as % of price: "how much a typical candle moves"
  move5m: number; // % change vs 5 completed candles ago
  volSurge: number; // avg volume of last 5 candles / avg of the 30 before
  spreadPct: number; // (ask - bid) / mid, %
  costPct: number; // round-trip cost as % of price: spread + 2 × taker fee
  costOfAtr: number; // costPct / atrPct: share of a typical candle eaten by costs
  score: number;
  candles: Candle[];
};

/** Wilder ATR over completed candles. */
export function atr(c: Candle[], n = 14): number {
  if (c.length < n + 1) return NaN;
  const tr = c.slice(1).map((k, i) => Math.max(k.h - k.l, Math.abs(k.h - c[i].c), Math.abs(k.l - c[i].c)));
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (const x of tr.slice(n)) a = (a * (n - 1) + x) / n;
  return a;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Highest leverage CoinDCX allows for `margin` USDT (bigger positions get lower caps). NaN if unknown. */
export function maxLeverage(ins: Instrument, margin: number): number {
  for (const [lev, cap] of ins.levTiers) if (margin * lev <= cap) return lev;
  return ins.levTiers.at(-1)?.[0] ?? NaN;
}

/** Approximate adverse price move (%) that liquidates an isolated position: margin minus maintenance margin. */
export function liqMovePct(ins: Instrument | undefined, lev: number, margin: number): number {
  const notional = margin * lev;
  const mm = ins?.mmTiers.find(([cap]) => notional <= cap)?.[1] ?? ins?.mmTiers.at(-1)?.[1] ?? 1.5;
  return Math.max(0, 100 / lev - mm);
}

export function compute(t: Ticker, raw: Candle[], b: Book | undefined, feePct: number): Metrics | undefined {
  // Drop the in-progress candle so its partial volume doesn't skew the surge ratio.
  const c = raw.filter((k) => k.t + 60_000 <= Date.now());
  if (c.length < 20) return undefined;
  const price = t.last;
  const atrPct = (atr(c) / price) * 100;
  const ref = c[c.length - 6]?.c ?? c[0].c;
  const move5m = ((price - ref) / ref) * 100;
  const volSurge = mean(c.slice(-5).map((k) => k.v)) / mean(c.slice(-35, -5).map((k) => k.v));
  const mid = b ? (b.bid + b.ask) / 2 : NaN;
  const spreadPct = b && mid > 0 ? ((b.ask - b.bid) / mid) * 100 : NaN;
  const costPct = (Number.isFinite(spreadPct) ? spreadPct : 0) + 2 * feePct;
  const costOfAtr = costPct / atrPct;
  // Rank by raw candle size, boosted when activity is accelerating, cut by how much costs eat.
  const surge = Math.sqrt(Math.min(Math.max(volSurge || 1, 0.5), 4));
  const score = atrPct * surge * Math.max(0, 1 - costOfAtr);
  return { atrPct, move5m, volSurge, spreadPct, costPct, costOfAtr, score, candles: c };
}
