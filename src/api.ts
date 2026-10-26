// CoinDCX public futures market data. No API keys needed.
const API = "https://api.coindcx.com";
const PUB = "https://public.coindcx.com";

export type Ticker = {
  pair: string; // e.g. B-LIGHT_USDT
  last: number;
  high: number; // 24h
  low: number; // 24h
  vol: number; // 24h quote volume, USDT
  chg: number; // 24h change, %
  funding: number; // current funding rate (fraction)
};
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Book = { bid: number; ask: number };

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

export const activePairs = () =>
  get<string[]>(`${API}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT`);

export async function tickers(): Promise<Map<string, Ticker>> {
  const j = await get<{ prices: Record<string, any> }>(`${PUB}/market_data/v3/current_prices/futures/rt`);
  const out = new Map<string, Ticker>();
  for (const [pair, p] of Object.entries(j.prices)) {
    out.set(pair, { pair, last: +p.ls, high: +p.h, low: +p.l, vol: +p.v, chg: +p.pc, funding: +p.fr });
  }
  return out;
}

/** INR per USDT: the fixed rate CoinDCX applies to INR-margined futures, falling back to the spot price. */
export async function inrRate(): Promise<number> {
  const conv = await get<{ symbol: string; conversion_price: number }[]>(`${API}/api/v1/derivatives/futures/data/conversions`).catch(() => []);
  const fixed = conv.find((c) => c.symbol === "USDTINR")?.conversion_price;
  if (fixed) return +fixed;
  const spot = await get<{ market: string; last_price: string }[]>(`${API}/exchange/ticker`);
  return +spot.find((t) => t.market === "USDTINR")!.last_price;
}

/** Last `minutes` of 1-minute candles, oldest first. */
export async function candles1m(pair: string, minutes = 60): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - minutes * 60;
  const j = await get<{ s: string; data: any[] }>(
    `${PUB}/market_data/candlesticks?pair=${pair}&from=${from}&to=${to}&resolution=1&pcode=f`,
  );
  return (j.data ?? [])
    .map((d) => ({ t: d.time, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume }))
    .sort((a, b) => a.t - b.t);
}

export async function book(pair: string): Promise<Book> {
  const j = await get<{ bids: Record<string, string>; asks: Record<string, string> }>(
    `${PUB}/market_data/v3/orderbook/${pair}-futures/10`,
  );
  const bids = Object.keys(j.bids ?? {}).map(Number);
  const asks = Object.keys(j.asks ?? {}).map(Number);
  return { bid: bids.length ? Math.max(...bids) : NaN, ask: asks.length ? Math.min(...asks) : NaN };
}

/** Run `fn` over `items` with at most `n` in flight. Failures yield undefined. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
