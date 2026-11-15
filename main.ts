// Trend Rider — a long-only trend-following bot for cbBTC (CBBTC/USDC, 1-minute bars).
//
// Idea: BTC's 1-minute bars are mostly noise (median move 0 bps, stdev ~12 bps) while a
// full-size round trip costs ~43 bps on this pool, so most "moves" are not worth trading.
// This bot only enters when three independent trend readings agree that a real move is
// underway, then rides it with a trailing stop and lets a strong trend run to a take-profit.
// It stays in cash the rest of the time, which is what a long-only bot must do on a
// falling day: cash earns nothing, but it also loses nothing.
//
// Entry (flat only): the fast EMA is above the slow EMA, the 6-bar return is above
// +60 bps (a sharp short-term push), AND the 60-bar return is above 0 (the push is
// part of a sustained move, not a blip in a downtrend). Buy 100% of cash.
// Exit (long only): the close falls 80 bps below the highest close since entry
// (trailing stop), or the position is worth 4% over its cost (take-profit), or the
// fast EMA falls back below the slow EMA (trend over). Sell the whole position.
// After any exit the bot waits 10 bars before it may enter again, so a stop-out
// cannot be re-bought on the next bar of the same chop.
//
// Everything is deterministic: every decision is a pure function of the bars the
// harness has sent. No clock, no environment, no randomness, no network, no files.
// Amounts use the shim's bigint account; the EMAs run in float64 (IEEE 754, so the
// same bars give the same orders on every run).

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Fast and slow EMA spans, in bars. */
const FAST_SPAN = 12;
const SLOW_SPAN = 26;
/** Short momentum window (bars) and its entry threshold (bps). */
const MOM_FAST_BARS = 6;
const MOM_FAST_BPS = 60;
/** Long momentum window (bars) and its entry threshold (bps). */
const MOM_SLOW_BARS = 60;
const MOM_SLOW_BPS = 0;
/** Trailing stop: exit when the close is this far (bps) below the peak since entry. */
const TRAIL_BPS = 80;
/** Take-profit: exit when the position is worth this far (bps) over its cost. */
const TAKE_PROFIT_BPS = 400;
/** Bars to wait after an exit before a new entry is allowed. */
const COOLDOWN_BARS = 10;
/** Slippage cap on every order (bps past the latest close). */
const MAX_SLIPPAGE_BPS = 100;
/**
 * The scored window is 1,440 one-minute bars (24 hours, per the competition rules),
 * so batch seq runs 0..1439. A position opened in the final bars cannot develop
 * before the flatten at the last close: it only pays the round-trip cost. Refuse
 * new entries in the last NO_ENTER_LAST bars.
 */
const TOTAL_BARS = 1440;
const NO_ENTER_LAST = 30;

/** One exponential moving average over closes, seeded by the mean of its first span. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

/** Return over the last `n` closes ending at index `i`, in bps, or null without history. */
function momentumBps(closes: number[], i: number, n: number): number | null {
  if (i < n) return null;
  const then = closes[i - n];
  if (then === 0) return null;
  return ((closes[i] / then) - 1) * 10000;
}

const closes: number[] = [];
const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
/** Highest close since the current entry, as a bigint price (0 when flat). */
let peakClose = 0n;
/** First seq on which a new entry is allowed again (after an exit). */
let reenterAt = 0;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Only CBBTC exists in this universe; ignore any batch without its bar.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(Number(bar.c));
    emaStep(fast, Number(bar.c));
    emaStep(slow, Number(bar.c));
    if (state.warmingUp) return [];

    const i = closes.length - 1;
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      // Track the peak close while holding, for the trailing stop.
      if (close > peakClose) peakClose = close;
      const value = state.value(SYMBOL, held.qty);
      const takeProfit = value * 10000n >= held.cost * BigInt(10000 + TAKE_PROFIT_BPS);
      const stoppedOut = peakClose > 0n && close * 10000n < peakClose * BigInt(10000 - TRAIL_BPS);
      const trendOver = fast.value !== null && slow.value !== null && fast.value < slow.value;
      if (takeProfit || stoppedOut || trendOver) {
        reenterAt = batch.seq + COOLDOWN_BARS;
        peakClose = 0n;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: only enter when the trend readings agree, and not in the final bars
    // where a new position cannot develop before the flatten.
    if (batch.seq >= TOTAL_BARS - NO_ENTER_LAST) return [];
    if (batch.seq < reenterAt) return [];
    if (fast.value === null || slow.value === null) return [];
    if (fast.value <= slow.value) return [];
    if (Number(bar.c) <= slow.value) return [];
    const fastMom = momentumBps(closes, i, MOM_FAST_BARS);
    if (fastMom === null || fastMom <= MOM_FAST_BPS) return [];
    const slowMom = momentumBps(closes, i, MOM_SLOW_BARS);
    if (slowMom === null || slowMom <= MOM_SLOW_BPS) return [];
    const cash = state.cash;
    if (cash <= 0n) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    peakClose = close;
    return [buy];
  },
});
