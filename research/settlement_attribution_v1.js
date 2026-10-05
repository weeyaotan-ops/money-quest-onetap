'use strict';

// Offline only. No exchange calls, writes, or live strategy imports.
// Requires complete fills spanning a verified flat position before this entry.
function attributeSettlement(trade, fills, evidence = {}) {
  const fail = reason => ({status: 'UNVERIFIED', reason, net: null, actualR: null});
  const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
  if (evidence.flatBeforeEntry !== true || evidence.completeFillHistory !== true)
    return fail('MISSING_POSITION_OR_HISTORY_EVIDENCE');
  if (!trade?.symbol || !['BUY', 'SELL'].includes(trade.side)
      || !['BOTH', 'LONG', 'SHORT'].includes(trade.positionSide)
      || trade.entryOrderId == null || !finite(trade.executedQty) || !(Number(trade.executedQty) > 0)
      || !finite(trade.actualRisk) || !(Number(trade.actualRisk) > 0)) return fail('INVALID_TRADE_METADATA');
  if ((trade.positionSide === 'LONG' && trade.side !== 'BUY')
      || (trade.positionSide === 'SHORT' && trade.side !== 'SELL')) return fail('SIDE_MISMATCH');
  if (!Array.isArray(fills)) return fail('INVALID_FILL_HISTORY');
  const unique = new Map();
  for (const f of fills) {
    if (f.symbol !== trade.symbol) continue;
    if (!['BOTH', 'LONG', 'SHORT'].includes(f.positionSide)) return fail('MISSING_POSITION_SIDE');
    if (f.positionSide !== trade.positionSide) continue;
    if (!/^\d+$/.test(String(f.id)) || f.orderId == null || !finite(f.time)
        || !finite(f.qty) || !(Number(f.qty) > 0) || !finite(f.realizedPnl)
        || !finite(f.commission) || !['BUY', 'SELL'].includes(f.side)) return fail('INVALID_FILL');
    const key = String(f.id);
    const normalized = {id:key, orderId:String(f.orderId), time:Number(f.time), qty:Number(f.qty),
      realizedPnl:Number(f.realizedPnl), commission:Number(f.commission), commissionAsset:f.commissionAsset, side:f.side};
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(normalized)) return fail('CONFLICTING_DUPLICATE_FILL');
    unique.set(key, normalized);
  }
  const rows = [...unique.values()].sort((a,b) => a.time-b.time || (BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0));
  const entry = rows.filter(f => f.orderId === String(trade.entryOrderId));
  if (!entry.length) return fail('ENTRY_FILLS_MISSING');
  const qty = Number(trade.executedQty), tolerance = qty * 1e-9;
  if (Math.abs(entry.reduce((s,f)=>s+f.qty,0)-qty) > tolerance) return fail('ENTRY_QUANTITY_MISMATCH');
  if (entry.some(f=>f.side!==trade.side || f.realizedPnl!==0)) return fail('ENTRY_NOT_A_CLEAN_OPEN');
  let balance=0, realized=0, commission=0, entered=0;
  const attributed=[];
  for (const f of rows.slice(rows.indexOf(entry[0]))) {
    if (f.commissionAsset !== 'USDT' || f.commission < 0) return fail('COMMISSION_CONVERSION_REQUIRED');
    if (f.orderId === String(trade.entryOrderId)) {balance+=f.qty; entered+=f.qty;}
    else {
      if (f.side === trade.side) return fail('OVERLAPPING_ENTRY_OR_SCALE_IN');
      if (f.qty > balance+tolerance) return fail('REVERSAL_OR_MISSING_ENTRY');
      balance-=f.qty;
    }
    attributed.push(f.id); realized+=f.realizedPnl; commission+=f.commission;
    if (Math.abs(balance) <= tolerance) {
      if (Math.abs(entered-qty)>tolerance) return fail('ENTRY_AFTER_POSITION_FLAT');
      const net=realized-commission;
      return {status:'ATTRIBUTED', realized, commission, net, actualR:net/Number(trade.actualRisk),
        riskBasis:'FROZEN_ACTUAL_RISK', riskAmount:Number(trade.actualRisk), fillIds:attributed,
        openedAt:entry[0].time, closedAt:f.time, fundingIncluded:false,
        note:'Trade P&L after USDT commissions; funding and other account adjustments excluded.'};
    }
  }
  return fail('POSITION_NOT_FLAT_OR_EXIT_FILLS_MISSING');
}

module.exports={attributeSettlement};
