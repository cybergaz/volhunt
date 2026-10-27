// Paper trading: simulated fills at last price ± half spread, taker fee on both legs.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Side = 1 | -1; // 1 = long, -1 = short
export type Position = {
  pair: string;
  side: Side;
  lev: number;
  margin: number; // USDT
  qty: number;
  entry: number;
  tp: number;
  sl: number;
  liq: number; // liquidation price
  openedAt: number;
};
export type Closed = Position & { exit: number; pnl: number; roe: number; reason: string; closedAt: number };

export class Paper {
  positions = new Map<string, Position>();
  closed: Closed[] = [];
  private log: string;

  constructor(private feePct: number) {
    const dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "volhunt");
    mkdirSync(dir, { recursive: true });
    this.log = join(dir, "paper-trades.jsonl");
  }

  get logPath() {
    return this.log;
  }

  open(pair: string, side: Side, last: number, spreadPct: number, atr: number, o: { lev: number; margin: number; tpAtr: number; slAtr: number; liqPct: number }) {
    const entry = last * (1 + (side * (spreadPct || 0)) / 200);
    const qty = (o.margin * o.lev) / entry;
    const p: Position = {
      pair, side, lev: o.lev, margin: o.margin, qty, entry,
      tp: entry + side * o.tpAtr * atr,
      sl: entry - side * o.slAtr * atr,
      liq: entry * (1 - (side * o.liqPct) / 100),
      openedAt: Date.now(),
    };
    this.positions.set(pair, p);
    return p;
  }

  /** Net PnL (USDT) and ROE (% of margin) if closed at `price` right now. */
  value(p: Position, price: number, spreadPct = 0) {
    const exit = price * (1 - (p.side * (spreadPct || 0)) / 200);
    const fees = (this.feePct / 100) * p.qty * (p.entry + exit);
    const pnl = p.side * p.qty * (exit - p.entry) - fees;
    return { exit, pnl, roe: (pnl / p.margin) * 100 };
  }

  /** ROE at a hypothetical exit price, e.g. the TP or SL level. */
  roeAt(p: Position, price: number, spreadPct = 0) {
    return this.value(p, price, spreadPct).roe;
  }

  close(pair: string, price: number, spreadPct: number, reason: string): Closed | undefined {
    const p = this.positions.get(pair);
    if (!p) return;
    let { exit, pnl, roe } = this.value(p, price, spreadPct);
    if (reason === "LIQ") ({ pnl, roe } = { pnl: -p.margin, roe: -100 }); // isolated: the whole margin is gone
    const c: Closed = { ...p, exit, pnl, roe, reason, closedAt: Date.now() };
    this.positions.delete(pair);
    this.closed.push(c);
    try {
      appendFileSync(this.log, JSON.stringify(c) + "\n");
    } catch {}
    return c;
  }

  /** Close anything that hit TP, SL or liquidation at `price`. */
  check(pair: string, price: number, spreadPct: number): Closed | undefined {
    const p = this.positions.get(pair);
    if (!p) return;
    if (p.side * (price - p.tp) >= 0) return this.close(pair, price, spreadPct, "TP");
    if (p.side * (price - p.liq) <= 0) return this.close(pair, price, spreadPct, "LIQ");
    if (p.side * (price - p.sl) <= 0) return this.close(pair, price, spreadPct, "SL");
  }

  stats() {
    const n = this.closed.length;
    const wins = this.closed.filter((c) => c.pnl > 0).length;
    const net = this.closed.reduce((s, c) => s + c.pnl, 0);
    return { n, wins, net };
  }
}
