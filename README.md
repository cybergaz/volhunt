# volhunt

A TUI scanner for CoinDCX futures (all ~500 perpetual contracts) that ranks pairs by short-term volatility (SCORE), with paper trading so you can practise scalping them without real money. It only uses public market data: no API keys and no real orders.

```sh
bun src/main.ts                       # TUI, ₹, sorted by SCORE
bun src/main.ts --currency usdt       # start in USDT
bun src/main.ts --margin 2000 --lev 15 --tp 1.5 --sl 1
bun src/main.ts --once                # print one ranked table and exit
```

## Columns

| col   | meaning |
|-------|---------|
| PRICE | in ₹ (at CoinDCX's INR-futures conversion rate) or USDT; toggle with `i` |
| ATR1m | average size of one 1-minute bar, as % of price (ATR 14) |
| ROE/c | ATR1m × leverage: the ROE one typical bar is worth, up or down |
| 5M    | % move over the last 5 completed minutes |
| VOL×  | volume of the last 5 min ÷ the 30 min before. Above 2 means it's waking up |
| SPRD  | best ask − best bid, % of mid |
| COST  | round-trip cost (2 × 0.059% taker fee + spread) as a share of one bar. Above 50% means fees eat most of the move |
| SCORE | ATR1m × √(VOL×) × (1 − COST) |
| RNG24 | 24h high−low range as % of price |

## Keys

| key | action |
|-----|--------|
| `j/k` `↑/↓` | move (the list scrolls with you) |
| `PgDn/PgUp` `space` `^d/^u` | page |
| `g/G` | top / bottom |
| `/` | find a pair by name; it gets scanned if it hasn't been yet |
| `1`–`5` or `tab` | sort by score, atr, 5m, surge, range |
| `i` | toggle ₹ / USDT |
| `l` / `s` | paper long / short |
| `c` / `C` | close selected / close all |
| `+/-` | leverage |
| `q` | quit |

Scanning: each 10s cycle covers the 30 top-scoring pairs, any pair you hold, and the next 30 from the rest of the liquid universe (24h vol ≥ 1M USDT). The whole universe is covered about every 2 minutes.

Paper trades fill at the last price ± half the spread and pay the taker fee on both legs. TP/SL are set in ATRs, so a quiet pair gets tight targets and a wild one gets wide ones. TP/SL are checked every 2s, so wicks between checks are missed. Closed trades go to `~/.local/share/volhunt/paper-trades.jsonl`.
