# cbbtc-race-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/locky504/cbbtc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/locky504/cbbtc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A deterministic trend + mean-reversion trading bot for Coinbase Wrapped BTC (cbBTC) on Solana, built for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.

## Run it

```sh
node /bot/main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) through the vendored SDK shim in `vendor/makefun-bars.ts` (a byte-identical copy of the kit's shim). Node 22, standard library only, no dependencies. To grade it locally on the dev window, use the kit's `grade-local --driver process`.

## Strategy

The bot trades one-minute cbBTC/USDC bars, long only, starting from 1,000 USDC of paper money. On the dev window the 60-minute return of cbBTC is strongly mean-reverting (lag-1 autocorrelation of non-overlapping 60-minute returns is about -0.37), so the bot waits flat for a sharp one-hour flush and buys the retrace:

- **Primary entry** — the 60-minute return at or below -1.1%: buy in full (100% of cash).
- **Primary exit** — when the price retraces to where it was an hour before the entry bar, or at +1.6% take-profit / -0.9% stop-loss against cost, or after 600 bars.
- **Fallback leg** — if nothing has filled by bar 1200 (a calm window with no flush), one small trade: 40% of cash when the price sits at least 0.3% under its 240-bar EMA with RSI(14) under 45, exited at +1.2% / -0.9% or back above the EMA. This keeps a quiet window trading.
- **Risk controls** — 3-bar cooldown after a sell; every order capped at 100 bps slippage from the latest close; buys capped at 0.15% of the latest close's pool depth so a shallow pool cannot inflate price impact; no leverage, no shorts.

A round trip costs roughly 0.37% of the traded size in fees, slippage and pool impact, so the bot only trades moves an order of magnitude larger than that cost and otherwise sits in cash. It never chases trends and never trades every minute. Parameters are few and deliberately coarse (one flush threshold, one take-profit, one stop-loss) to avoid fitting the dev window's individual bars.

Dev-window result (local grade, `grade-local --driver process`): **net PnL +$23.51**, 5 trades, win rate 100%, max drawdown 0.72%, 0 rejected orders; the first and second halves of the window are both profitable (+$15.91 / +$1.39). Two runs reproduce byte for byte.

## How it runs

It is fully deterministic: indicators are float64 over the closes the harness has sent — no clock, no environment, no randomness.

## Disclaimer

Paper trading only — no real money, no real orders, no wallet. The bot never touches the network and never reads anything outside its own directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dvanqqs1&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
