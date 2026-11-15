# Trend Rider — a long-only trend-following bot for cbBTC

Entry for the make.fun bounty **btc-race-24h-20261115-0828** ("Race a BTC trading
bot live for 24 hours"). It trades Coinbase Wrapped BTC (CBBTC) against USDC,
minute by minute, in a replay of real on-chain prices — paper money only, starting
with 1,000 USDC. It speaks the `agent-fun/bars-replay/v1` line protocol
(newline-delimited JSON on stdin/stdout) through the kit's SDK shim, vendored
byte-for-byte under `vendor/`.

## Strategy

BTC's 1-minute bars are mostly noise (median move 0 bps, stdev ~12 bps) while a
full-size round trip costs ~43 bps on this pool, so most "moves" are not worth
trading. This bot only enters when three independent trend readings agree that a
real move is underway, then rides it with a trailing stop and lets a strong trend
run to a take-profit. It stays in cash the rest of the time — which is what a
long-only bot must do on a falling day.

- **Entry** (flat only): fast EMA(12) above slow EMA(26), the 6-bar return above
  +60 bps (a sharp short-term push), AND the 60-bar return above 0 bps (the push
  is part of a sustained move, not a blip in a downtrend). Buys 100% of cash.
- **Exit** (long only): the close falls 80 bps below the highest close since
  entry (trailing stop), or the position is worth 4% over its cost (take-profit),
  or the fast EMA falls back below the slow EMA (trend over). Sells the whole
  position.
- **Cooldown**: after any exit the bot waits 10 bars before it may enter again,
  so a stop-out cannot be re-bought on the next bar of the same chop.

## Files

- `main.ts` — the bot (Node 22, TypeScript through type stripping, standard
  library only besides the vendored shim).
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte-for-byte.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the entrant's wallet.

## Determinism

Every decision is a pure function of the bars the harness has sent. No clock, no
environment, no randomness, no network, no files. The EMAs run in float64
(IEEE 754), so the same bars give the same orders on every run.

## Dev-window result

Graded locally with the kit CLI (`grade-local`, process driver) on the published
dev window (1,440 one-minute bars): net PnL **+US$21.27** on 6 trades (3
round-trips), which clears the dev gate (net PnL above 0 USDC).
