import { C, USDC_DECIMALS } from './config.js';
import { discover } from './discovery.js';
import { roundTripPreview, buildLiveBuyOrder, execute, liveSell, sellPreview } from './jupiter.js';
import { tokenSafety, solBalance, usdcBalance, tokenBalanceRaw, walletAddress } from './solana.js';
import {
  event, createPendingTrade, markEntryOpen, markEntryFailed, markExitPending,
  markClosed, markClosedUnknown, restoreExitPendingToOpen, updatePeak, openTrades, pendingTrades,
  openCount, recentlyTraded, todayStats, getRuntime, setRuntime,
} from './db.js';
import { notify } from './telegram.js';

const usdcRaw = () => String(Math.round(C.TRADE_USDC * 10 ** USDC_DECIMALS));
const usdcFromRaw = raw => Number(raw || 0) / 10 ** USDC_DECIMALS;
const pct = (value, base) => base > 0 ? ((value / base) - 1) * 100 : 0;

export class MemeHunter {
  constructor() {
    this.scanBusy = false;
    this.monitorBusy = false;
    this.runtimePaused = false;
    this.pauseReason = '';
    this.sellRouteFailures = new Map();
    this.lastCandidateAt = new Map();
  }

  async init() {
    const rt = await getRuntime('pause', { paused: false, reason: '' });
    this.runtimePaused = !!rt?.paused;
    this.pauseReason = rt?.reason || '';
    await this.reconcilePending();
    await notify([
      '🧠 SOLANA MEMEHUNTER STARTED',
      `Mode: ${C.LIVE_TRADING ? 'MICRO LIVE' : 'SHADOW / NO EXECUTION'}`,
      `Wallet: ${walletAddress() || 'NOT CONFIGURED'}`,
      `Trade size: ${C.TRADE_USDC.toFixed(2)} USDC`,
      `Max open: ${C.MAX_OPEN_POSITIONS}`,
      `Daily loss stop: -${C.MAX_DAILY_LOSS_USDC.toFixed(2)} USDC`,
      `Paused: ${this.runtimePaused ? 'YES - ' + this.pauseReason : 'NO'}`,
    ].join('\n'));
  }

  async reconcilePending() {
    const pending = await pendingTrades();
    for (const t of pending) {
      if (t.status === 'ENTRY_PENDING') {
        try {
          const bal = await tokenBalanceRaw(t.mint);
          if (bal > 0n) {
            await markEntryOpen(t.id, {
              tokenRaw: bal.toString(),
              signature: null,
              entryUsdc: Number(t.entry_usdc || C.TRADE_USDC),
              metaPatch: { reconciledAfterRestart: true },
            });
            await event('RECONCILED_ENTRY_OPEN', t.mint, { tradeId: t.id, tokenRaw: bal.toString() });
            await notify(`⚠️ RECOVERED OPEN POSITION\n${t.symbol || t.mint}\nRestart happened during entry; position management resumed.`);
          } else {
            await markEntryFailed(t.id, 'RESTART_RECONCILE_NO_TOKEN_BALANCE');
          }
        } catch (e) {
          await this.pause(`ENTRY_RECONCILE_FAILED:${e.message}`);
        }
      } else if (t.status === 'EXIT_PENDING') {
        try {
          const bal = await tokenBalanceRaw(t.mint);
          await this.pause(`RECOVERED_EXIT_PENDING:${t.id}`);
          if (bal > 0n) {
            await restoreExitPendingToOpen(t.id, 'RESTART_RETRY_EXIT');
            await event('RECONCILED_EXIT_RETRY', t.mint, { tradeId: t.id, tokenRaw: bal.toString() });
            await notify(`🛑 MEMEHUNTER PAUSED\nRecovered an unfinished exit for ${t.symbol || t.mint}. Position monitor will retry selling; no new buys.`);
          } else {
            await markClosedUnknown(t.id, 'RESTART_EXIT_BALANCE_ZERO_REVIEW_REQUIRED');
            await event('RECONCILED_EXIT_CLOSED_REVIEW', t.mint, { tradeId: t.id });
            await notify(`🛑 MEMEHUNTER PAUSED\n${t.symbol || t.mint} token balance is zero after an interrupted exit. Trade marked CLOSED_REVIEW; verify transaction history before resuming.`);
          }
        } catch (e) {
          await this.pause(`EXIT_RECONCILE_FAILED:${e.message}`);
        }
      }
    }
  }

  async pause(reason) {
    this.runtimePaused = true;
    this.pauseReason = reason;
    await setRuntime('pause', { paused: true, reason, at: new Date().toISOString() });
    await event('PAUSED', null, { reason });
  }

  async resume(reason = 'manual') {
    this.runtimePaused = false;
    this.pauseReason = '';
    await setRuntime('pause', { paused: false, reason, at: new Date().toISOString() });
    await event('RESUMED', null, { reason });
  }

  async preflight() {
    if (!C.JUPITER_API_KEY) return { ok: false, reason: 'MISSING_JUPITER_API_KEY' };
    if (C.LIVE_TRADING && !C.BS58_PRIVATE_KEY) return { ok: false, reason: 'MISSING_BS58_PRIVATE_KEY' };
    if (this.runtimePaused) return { ok: false, reason: `PAUSED:${this.pauseReason}` };
    const stats = await todayStats();
    if (stats.trades >= C.MAX_TRADES_PER_DAY) return { ok: false, reason: 'MAX_TRADES_PER_DAY', stats };
    if (stats.pnl <= -C.MAX_DAILY_LOSS_USDC) {
      await this.pause(`DAILY_LOSS_LIMIT:${stats.pnl.toFixed(2)}`);
      return { ok: false, reason: 'DAILY_LOSS_LIMIT', stats };
    }
    if (await openCount() >= C.MAX_OPEN_POSITIONS) return { ok: false, reason: 'MAX_OPEN_POSITIONS' };
    if (C.LIVE_TRADING) {
      const [sol, usdc] = await Promise.all([solBalance(), usdcBalance()]);
      if (sol < C.MIN_SOL_GAS) return { ok: false, reason: 'LOW_SOL_GAS', sol };
      if (usdc < C.TRADE_USDC) return { ok: false, reason: 'LOW_USDC', usdc };
    }
    return { ok: true, stats };
  }

  async scanOnce() {
    if (this.scanBusy) return;
    this.scanBusy = true;
    try {
      const pf = await this.preflight();
      if (!pf.ok) {
        if (!String(pf.reason).startsWith('MAX_OPEN_POSITIONS') && !String(pf.reason).startsWith('PAUSED')) {
          console.log('PREFLIGHT_BLOCK', pf.reason);
        }
        return;
      }
      const candidates = await discover();
      for (const c of candidates) {
        const last = this.lastCandidateAt.get(c.mint) || 0;
        if (Date.now() - last < 60_000) continue;
        this.lastCandidateAt.set(c.mint, Date.now());
        if (await recentlyTraded(c.mint, C.REENTRY_COOLDOWN_HOURS)) continue;
        await this.evaluateCandidate(c);
        if (await openCount() >= C.MAX_OPEN_POSITIONS) break;
      }
    } catch (e) {
      console.error('SCAN_ERROR', e.stack || e.message);
      await event('SCAN_ERROR', null, { error: e.message });
    } finally {
      this.scanBusy = false;
    }
  }

  async evaluateCandidate(c) {
    await event('CANDIDATE', c.mint, c);
    let safety;
    try {
      safety = await tokenSafety(c.mint);
    } catch (e) {
      await event('REJECT', c.mint, { gate: 'TOKEN_SAFETY_RPC_ERROR', error: e.message });
      return;
    }
    if (!safety.ok) {
      await event('REJECT', c.mint, { gate: safety.reason, safety, market: c });
      return;
    }

    let rt;
    try {
      rt = await roundTripPreview(c.mint, usdcRaw());
    } catch (e) {
      await event('REJECT', c.mint, { gate: 'NO_TWO_WAY_JUPITER_ROUTE', error: e.message });
      return;
    }
    if (!Number.isFinite(rt.roundtripLossPct) || rt.roundtripLossPct > C.MAX_ROUNDTRIP_LOSS_PCT) {
      await event('REJECT', c.mint, { gate: 'ROUNDTRIP_COST', roundtripLossPct: rt.roundtripLossPct });
      return;
    }

    const meta = { market: c, safety, roundtripLossPct: rt.roundtripLossPct, previewOutRaw: rt.buy.outAmount };
    await event('QUALIFIED', c.mint, meta);

    if (!C.LIVE_TRADING) {
      await notify([
        '🟡 QUALIFIED — SHADOW ONLY',
        `${c.symbol} | score ${c.score.toFixed(1)}`,
        `Liquidity: $${Math.round(c.liquidityUsd).toLocaleString()}`,
        `5m volume: $${Math.round(c.m5VolumeUsd).toLocaleString()}`,
        `Buy/Sell: ${c.buySellRatio.toFixed(2)}`,
        `5m: ${c.m5PriceChangePct.toFixed(1)}%`,
        `Round-trip cost: ${rt.roundtripLossPct.toFixed(2)}%`,
        c.url || '',
      ].filter(Boolean).join('\n'));
      return;
    }

    const tradeId = await createPendingTrade({
      mint: c.mint,
      symbol: c.symbol,
      pairAddress: c.pairAddress,
      entryUsdc: C.TRADE_USDC,
      expectedRaw: rt.buy.outAmount,
      score: c.score,
      meta,
    });

    try {
      const order = await buildLiveBuyOrder(c.mint, usdcRaw());
      const preview = BigInt(rt.buy.outAmount);
      const liveExpected = BigInt(order.outAmount);
      const deteriorationPct = preview > 0n && liveExpected < preview
        ? Number((preview - liveExpected) * 1_000_000n / preview) / 10_000
        : 0;
      if (deteriorationPct > C.MAX_ENTRY_QUOTE_DETERIORATION_PCT) {
        throw new Error(`ENTRY_QUOTE_DETERIORATION_${deteriorationPct.toFixed(2)}pct`);
      }
      const result = await execute(order);
      const tokenRaw = String(result.totalOutputAmount || result.outputAmountResult || order.outAmount);
      const spentUsdc = usdcFromRaw(result.totalInputAmount || usdcRaw());
      await markEntryOpen(tradeId, {
        tokenRaw,
        signature: result.signature,
        entryUsdc: spentUsdc,
        metaPatch: { router: order.router, feeBps: order.feeBps, deteriorationPct },
      });
      await event('BUY_FILLED', c.mint, { tradeId, signature: result.signature, tokenRaw, spentUsdc });
      await notify([
        '🟢 MEMEHUNTER BOUGHT',
        `${c.symbol}`,
        `Spent: ${spentUsdc.toFixed(4)} USDC`,
        `Trade size cap: ${C.TRADE_USDC.toFixed(2)} USDC`,
        `SL: -${C.STOP_LOSS_PCT}% | TP: +${C.TAKE_PROFIT_PCT}%`,
        `TX: https://solscan.io/tx/${result.signature}`,
      ].join('\n'));
    } catch (e) {
      await markEntryFailed(tradeId, e.message);
      await event('BUY_FAILED', c.mint, { tradeId, error: e.message });
      await notify(`⚠️ BUY FAILED\n${c.symbol}\n${e.message.slice(0, 300)}`);
    }
  }

  async monitorOnce() {
    if (this.monitorBusy) return;
    this.monitorBusy = true;
    try {
      const trades = await openTrades();
      for (const t of trades) await this.monitorTrade(t);
    } catch (e) {
      console.error('MONITOR_ERROR', e.stack || e.message);
      await event('MONITOR_ERROR', null, { error: e.message });
    } finally {
      this.monitorBusy = false;
    }
  }

  async monitorTrade(t) {
    const raw = String(t.entry_token_raw || '0');
    if (BigInt(raw) <= 0n) {
      await this.pause(`OPEN_TRADE_BAD_TOKEN_AMOUNT:${t.id}`);
      return;
    }
    let q;
    try {
      q = await sellPreview(t.mint, raw);
      this.sellRouteFailures.set(t.id, 0);
    } catch (e) {
      const n = (this.sellRouteFailures.get(t.id) || 0) + 1;
      this.sellRouteFailures.set(t.id, n);
      await event('SELL_ROUTE_FAIL', t.mint, { tradeId: t.id, failures: n, error: e.message });
      if (n >= C.MAX_SELL_ROUTE_FAILURES && !this.runtimePaused) {
        await this.pause(`SELL_ROUTE_FAILURES:${t.symbol || t.mint}`);
        await notify(`🛑 NEW BUYS PAUSED\nCannot get sell route for ${t.symbol || t.mint} (${n} times). Exit monitor keeps retrying.`);
      }
      return;
    }

    const valueUsdc = usdcFromRaw(q.outAmount);
    const entryUsdc = Number(t.entry_usdc || C.TRADE_USDC);
    const pnlPct = pct(valueUsdc, entryUsdc);
    const peak = Math.max(Number(t.peak_value_usdc || 0), valueUsdc);
    if (peak > Number(t.peak_value_usdc || 0)) await updatePeak(t.id, peak);
    const peakPct = pct(peak, entryUsdc);
    const heldMin = t.entry_time ? (Date.now() - new Date(t.entry_time).getTime()) / 60_000 : 0;

    let reason = '';
    if (pnlPct <= -C.STOP_LOSS_PCT) reason = `STOP_LOSS_${pnlPct.toFixed(2)}%`;
    else if (pnlPct >= C.TAKE_PROFIT_PCT) reason = `TAKE_PROFIT_${pnlPct.toFixed(2)}%`;
    else if (peakPct >= C.TRAILING_ARM_PCT && (peakPct - pnlPct) >= C.TRAILING_GIVEBACK_PCT) {
      reason = `TRAILING_EXIT_${pnlPct.toFixed(2)}%_PEAK_${peakPct.toFixed(2)}%`;
    } else if (heldMin >= C.MAX_HOLD_MIN) {
      reason = `MAX_HOLD_${heldMin.toFixed(1)}m`;
    }

    if (reason) await this.exitTrade(t, reason);
  }

  async exitTrade(t, reason) {
    const claimed = await markExitPending(t.id, reason, { exitTriggeredAt: new Date().toISOString() });
    if (!claimed) return;
    try {
      const walletRaw = await tokenBalanceRaw(t.mint);
      const recordedRaw = BigInt(t.entry_token_raw || '0');
      if (walletRaw <= 0n) throw new Error('NO_TOKEN_BALANCE_FOR_EXIT');
      const sellRaw = walletRaw < recordedRaw ? walletRaw : recordedRaw;
      const { result } = await liveSell(t.mint, sellRaw.toString());
      const exitUsdc = usdcFromRaw(result.totalOutputAmount || result.outputAmountResult || '0');
      const entryUsdc = Number(t.entry_usdc || C.TRADE_USDC);
      const pnl = exitUsdc - entryUsdc;
      await markClosed(t.id, { exitUsdc, signature: result.signature, reason, pnl });
      await event('SELL_FILLED', t.mint, { tradeId: t.id, reason, signature: result.signature, exitUsdc, pnl });
      await notify([
        pnl >= 0 ? '💰 MEMEHUNTER SOLD — PROFIT' : '🔴 MEMEHUNTER SOLD — LOSS',
        `${t.symbol || t.mint}`,
        `Reason: ${reason}`,
        `Exit: ${exitUsdc.toFixed(4)} USDC`,
        `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDC`,
        `TX: https://solscan.io/tx/${result.signature}`,
      ].join('\n'));

      const stats = await todayStats();
      if (stats.pnl <= -C.MAX_DAILY_LOSS_USDC) {
        await this.pause(`DAILY_LOSS_LIMIT:${stats.pnl.toFixed(2)}`);
        await notify(`🛑 DAILY CIRCUIT BREAKER\nRealized P&L today: ${stats.pnl.toFixed(2)} USDC\nNo more new buys.`);
      }
    } catch (e) {
      await restoreExitPendingToOpen(t.id, `EXIT_FAILED:${e.message}`);
      await event('SELL_FAILED', t.mint, { tradeId: t.id, reason, error: e.message });
      await this.pause(`EXIT_FAILED:${t.symbol || t.mint}`);
      await notify(`🛑 EXIT FAILED — NEW BUYS PAUSED\n${t.symbol || t.mint}\n${e.message.slice(0, 300)}\nExit monitor will retry.`);
    }
  }

  async status() {
    const [stats, open] = await Promise.all([todayStats(), openTrades()]);
    const wallet = { address: walletAddress() || null, sol: null, usdc: null };
    if (C.BS58_PRIVATE_KEY) {
      try { [wallet.sol, wallet.usdc] = await Promise.all([solBalance(), usdcBalance()]); } catch {}
    }
    return {
      ok: true,
      mode: C.LIVE_TRADING ? 'MICRO_LIVE' : 'SHADOW',
      paused: this.runtimePaused,
      pauseReason: this.pauseReason,
      wallet,
      today: stats,
      openPositions: open.map(t => ({
        id: t.id,
        mint: t.mint,
        symbol: t.symbol,
        entryUsdc: Number(t.entry_usdc),
        entryTime: t.entry_time,
      })),
      risk: {
        tradeUsdc: C.TRADE_USDC,
        maxOpen: C.MAX_OPEN_POSITIONS,
        maxTradesPerDay: C.MAX_TRADES_PER_DAY,
        maxDailyLossUsdc: C.MAX_DAILY_LOSS_USDC,
        stopLossPct: C.STOP_LOSS_PCT,
        takeProfitPct: C.TAKE_PROFIT_PCT,
      },
    };
  }

  run() {
    this.scanOnce();
    this.monitorOnce();
    setInterval(() => this.scanOnce(), C.SCAN_MS).unref();
    setInterval(() => this.monitorOnce(), C.POSITION_POLL_MS).unref();
  }
}
