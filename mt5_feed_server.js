'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = String(process.env.MT5_INGEST_TOKEN || '');
const ALLOWED = new Set((process.env.MT5_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD,NZDUSD')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

const MAX_BODY = 4 * 1024 * 1024;
const MAX_M15 = 320;
const MAX_H4 = 140;
const state = { updatedAt: null, symbols: {} };

function send(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(body));
}

function authOk(req) {
  if (!TOKEN) return false;
  const h = String(req.headers.authorization || '');
  return h === 'Bearer ' + TOKEN;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(c) {
  const openTime = num(c.openTime ?? c.time ?? c.timestamp);
  const open = num(c.open), high = num(c.high), low = num(c.low), close = num(c.close);
  const volume = num(c.volume ?? c.tickVolume ?? 0) ?? 0;
  if (![openTime, open, high, low, close].every(Number.isFinite)) return null;
  if (!(high >= low && high >= open && high >= close && low <= open && low <= close)) return null;
  return { openTime, open, high, low, close, volume };
}

function normalizeSeries(xs, limit) {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    const c = normalizeCandle(x);
    if (c) out.push(c);
  }
  out.sort((a,b) => a.openTime - b.openTime);
  return out.slice(-limit);
}

function mergePayload(body) {
  const incoming = body && body.symbols ? body.symbols : (
    body && body.symbol ? { [String(body.symbol).toUpperCase()]: body } : {}
  );
  let accepted = 0;
  for (const [rawSymbol, row] of Object.entries(incoming || {})) {
    const symbol = String(rawSymbol).toUpperCase();
    if (!ALLOWED.has(symbol)) continue;
    const candles15m = normalizeSeries(row.candles15m || row.m15, MAX_M15);
    const candles4h = normalizeSeries(row.candles4h || row.h4, MAX_H4);
    if (candles15m.length < 20 || candles4h.length < 51) continue;
    state.symbols[symbol] = {
      symbol,
      source: 'MT5',
      receivedAt: new Date().toISOString(),
      candles15m,
      candles4h
    };
    accepted += 1;
  }
  if (accepted) state.updatedAt = new Date().toISOString();
  return accepted;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    return send(res, 200, {
      ok: true,
      service: 'mt5-session-feed',
      updatedAt: state.updatedAt,
      symbols: Object.keys(state.symbols),
      allowed: [...ALLOWED]
    });
  }

  if (req.method === 'GET' && req.url.startsWith('/feed')) {
    return send(res, 200, {
      ok: true,
      source: 'MT5',
      updatedAt: state.updatedAt,
      symbols: state.symbols
    });
  }

  if (req.method === 'POST' && req.url.startsWith('/ingest')) {
    if (!authOk(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return send(res, 413, { ok: false, error: 'payload_too_large' });
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const accepted = mergePayload(body);
        return send(res, accepted ? 200 : 422, {
          ok: accepted > 0,
          accepted,
          updatedAt: state.updatedAt,
          symbols: Object.keys(state.symbols)
        });
      } catch (e) {
        return send(res, 400, { ok: false, error: 'bad_json', detail: String(e.message || e) });
      }
    });
    return;
  }

  send(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    service: 'mt5-session-feed',
    status: 'READY',
    port: PORT,
    auth: TOKEN ? 'BEARER_REQUIRED' : 'MISSING_TOKEN',
    allowed: [...ALLOWED]
  }));
});
