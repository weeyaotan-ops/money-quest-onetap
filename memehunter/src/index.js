import http from 'node:http';
import { C } from './config.js';
import { migrate, event, pool } from './db.js';
import { MemeHunter } from './engine.js';
import { notify } from './telegram.js';

let hunter;
let ready = false;
let fatal = '';

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return !!C.ADMIN_TOKEN && req.headers['x-admin-token'] === C.ADMIN_TOKEN;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, ready ? 200 : 503, { ok: ready, fatal: fatal || undefined });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!ready) return json(res, 503, { ok: false, fatal });
      return json(res, 200, await hunter.status());
    }
    if (req.method === 'POST' && url.pathname === '/pause') {
      if (!authorized(req)) return json(res, 403, { ok: false });
      await hunter.pause('ADMIN_HTTP');
      await notify('🛑 MEMEHUNTER PAUSED BY ADMIN');
      return json(res, 200, { ok: true, paused: true });
    }
    if (req.method === 'POST' && url.pathname === '/resume') {
      if (!authorized(req)) return json(res, 403, { ok: false });
      await hunter.resume('ADMIN_HTTP');
      await notify('▶️ MEMEHUNTER RESUMED BY ADMIN');
      return json(res, 200, { ok: true, paused: false });
    }
    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    console.error('HTTP_ERROR', e.stack || e.message);
    return json(res, 500, { ok: false, error: 'internal_error' });
  }
});

async function boot() {
  try {
    await migrate();
    hunter = new MemeHunter();
    await hunter.init();
    hunter.run();
    ready = true;
    await event('BOOT_OK', null, { live: C.LIVE_TRADING });
    console.log('MEMEHUNTER_READY', JSON.stringify({ live: C.LIVE_TRADING, port: C.PORT }));
  } catch (e) {
    fatal = e.message;
    ready = false;
    console.error('MEMEHUNTER_FATAL', e.stack || e.message);
  }
}

server.listen(C.PORT, '0.0.0.0', () => {
  console.log('HTTP_LISTEN', C.PORT);
  boot();
});

async function shutdown(signal) {
  console.log('SHUTDOWN', signal);
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
