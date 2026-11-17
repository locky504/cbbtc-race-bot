// CBBTC Race Bot — a deterministic hourly mean-reversion bot for cbBTC/USDC.
//
// Idea (original design, built from the dev window's own structure):
//   On 1-minute bars the 60-minute return of cbBTC is strongly mean-reverting
//   (lag-1 autocorrelation of non-overlapping 60-minute returns is about -0.37
//   on the dev window). A sharp one-hour flush therefore tends to retrace.
//   The bot waits, flat, for such a flush — the 60-minute return at or below
//   -1.1% — then buys it in full, and exits when the price has retraced to
//   where it was an hour before the entry bar, or at a take-profit of +1.6% /
//   stop-loss of -0.9% against its cost, or after 600 bars. A round trip
//   costs roughly 0.37% of the traded size in fees, slippage and pool impact,
//   so the bot only trades moves an order of magnitude larger than that cost
//   and otherwise sits in cash; it never chases a trend and never trades
//   every minute.
//
//   Insurance leg: if the window has produced no fill at all by bar 1200
//   (a calm window with no flush), the bot takes one small mean-reversion
//   trade — 40% of cash when the price sits at least 0.3% under its 240-bar
//   EMA with RSI(14) under 45 — so that a quiet window still meets the
//   guardrail of at least one trade, at a size that cannot hurt much.
//
//   Everything is deterministic: indicators are float64 over the closes the
//   harness has sent, no clock, no environment, no Math.random. All amounts
//   are sized off the account the harness reports, capped at 0.15% of the
//   latest close's pool depth so a shallow pool cannot inflate impact, and
//   every order caps its slippage at 100 bps from the latest close.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** 60-minute flush that triggers the primary entry (return <= -1.1%). */
const FLUSH_RETURN = -0.011;
/** Primary exits, in bps against the position's cost. */
const TAKE_PROFIT_BPS = 160;
const STOP_LOSS_BPS = 90;
/** Primary: give a flush up to 600 bars (10 hours) to retrace. */
const PRIMARY_MAX_HOLD = 600;
/** Bars to wait after a sell before a fresh entry. */
const COOLDOWN_BARS = 3;
/** Slippage cap on every order, in bps from the latest close. */
const MAX_SLIPPAGE_BPS = 100;
/**
 * Impact cap: never buy more than this share of the pool depth the latest
 * close reports (0.15%), so a shallow race-window pool cannot turn a full
 * position into a large impact bill. On the dev window the depth is near
 * $800k, so the cap sits above the whole cash balance and changes nothing.
 */
const IMPACT_CAP_NUM = 15n;
const IMPACT_CAP_DEN = 10_000n;

/** Fallback leg (only when nothing has filled yet, late in the window). */
const FALLBACK_AFTER_BARS = 1200;
const FALLBACK_EMA_SPAN = 240;
const FALLBACK_GAP = 0.003; // close at least 0.3% under the 240-bar EMA
const FALLBACK_RSI_BELOW = 45;
const FALLBACK_SIZE_NUM = 2; // 40% of cash
const FALLBACK_SIZE_DEN = 5;
const FALLBACK_TAKE_PROFIT_BPS = 120;
const FALLBACK_MAX_HOLD = 240;

const RSI_BARS = 14;

/** Indicators kept over the closes the harness has sent, oldest first. */
const closes: number[] = [];
/** RSI(14), Wilder's smoothing; null until seeded. */
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
const rsiFirst: number[] = [];
/** EMA(240) of closes; null until seeded. */
let ema240: number | null = null;
const emaWarm: number[] = [];

/** Fills seen so far (any side, own orders only). */
let fillsSeen = 0;
/** Bar index of the last sell decision, for the cooldown. */
let lastSellBar = -1_000_000;
/** The open trade's exit terms, set at entry. */
interface Trade {
  entryBar: number;
  /** Price to retrace to (the close 60 minutes before entry), or null. */
  revertTo: number | null;
  /** Exit at/above this EMA instead of a fixed price, when set. */
  revertEma: boolean;
  takeProfitBps: number;
  maxHold: number;
}
let trade: Trade | null = null;

function pushClose(c: number): void {
  closes.push(c);
  // RSI(14), Wilder.
  const n = closes.length;
  if (n >= 2) {
    const change = c - closes[n - 2];
    if (rsiGain === null || rsiLoss === null) {
      rsiFirst.push(change);
      if (rsiFirst.length === RSI_BARS) {
        rsiGain = rsiFirst.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        rsiLoss = rsiFirst.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      rsiGain = (rsiGain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      rsiLoss = (rsiLoss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
    }
  }
  // EMA(240), seeded as the mean of its first span of closes.
  if (ema240 !== null) {
    ema240 += (2 / (FALLBACK_EMA_SPAN + 1)) * (c - ema240);
  } else {
    emaWarm.push(c);
    if (emaWarm.length === FALLBACK_EMA_SPAN) {
      ema240 = emaWarm.reduce((a, x) => a + x, 0) / FALLBACK_EMA_SPAN;
    }
  }
}

/**
 * The most this reply may spend on the symbol: the smallest of the cash
 * offered, the weight room and the impact cap against the latest close's
 * pool depth. Returns 0 when there is no depth to size against yet.
 */
function spendable(state: BarsState, cash: bigint): bigint {
  let room = state.weightRoom(SYMBOL);
  if (cash < room) room = cash;
  const depth = state.depthAt(SYMBOL);
  if (depth === null || depth.length === 0) return 0n;
  const cap = (depth[0] * IMPACT_CAP_NUM) / IMPACT_CAP_DEN;
  if (cap < room) room = cap;
  return room;
}

function rsi(): number | null {
  if (rsiGain === null || rsiLoss === null) return null;
  const moved = rsiGain + rsiLoss;
  return moved === 0 ? 50 : (100 * rsiGain) / moved;
}

/** The 60-minute return ending at the latest close, or null. */
function return60(): number | null {
  const n = closes.length;
  if (n < 61) return null;
  return closes[n - 1] / closes[n - 61] - 1;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) fillsSeen++;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) pushClose(Number(bar.c));
    if (state.warmingUp) return [];
    if (bar === undefined) return [];

    const close = Number(bar.c);
    const held = state.positions.get(SYMBOL);
    const barIndex = closes.length - 1;

    // --- exits for the open position -------------------------------------
    if (held !== undefined && held.qty > 0n) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const takeProfit = value * 10_000n >= cost * BigInt(10_000 + (trade?.takeProfitBps ?? TAKE_PROFIT_BPS));
      const stopLoss = value * 10_000n <= cost * BigInt(10_000 - STOP_LOSS_BPS);
      const reverted =
        (trade !== null && trade.revertTo !== null && close >= trade.revertTo) ||
        (trade !== null && trade.revertEma && ema240 !== null && close >= ema240);
      const timedOut = trade !== null && barIndex - trade.entryBar >= trade.maxHold;
      if (takeProfit || stopLoss || reverted || timedOut) {
        lastSellBar = barIndex;
        trade = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entries (flat) ---------------------------------------------------
    trade = null;
    if (barIndex - lastSellBar < COOLDOWN_BARS) return [];
    const r60 = return60();

    // Primary: a sharp one-hour flush — buy it in full.
    if (r60 !== null && r60 <= FLUSH_RETURN) {
      const notional = spendable(state, state.cash);
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      trade = { entryBar: barIndex, revertTo: closes[closes.length - 61], revertEma: false, takeProfitBps: TAKE_PROFIT_BPS, maxHold: PRIMARY_MAX_HOLD };
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // Fallback: nothing has filled yet, late in the window, price soft under
    // its long EMA with a weak RSI — one small trade so a quiet window still
    // trades.
    if (fillsSeen === 0 && barIndex >= FALLBACK_AFTER_BARS && ema240 !== null) {
      const r = rsi();
      if (r !== null && r < FALLBACK_RSI_BELOW && close < ema240 * (1 - FALLBACK_GAP)) {
        const size = (state.cash * BigInt(FALLBACK_SIZE_NUM)) / BigInt(FALLBACK_SIZE_DEN);
        const notional = spendable(state, size);
        if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        trade = { entryBar: barIndex, revertTo: null, revertEma: true, takeProfitBps: FALLBACK_TAKE_PROFIT_BPS, maxHold: FALLBACK_MAX_HOLD };
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
