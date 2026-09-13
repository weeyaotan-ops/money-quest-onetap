const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8080);
const ONETAP = process.env.ONETAP_STATUS_URL || 'http://crypto-signal-publisher.railway.internal:18093/status';
const TRACKER = process.env.TRACKER_STATUS_URL || 'http://crypto-signal-publisher.railway.internal:18091/status';
const ANALYTICS = process.env.ANALYTICS_STATUS_URL || '';

async function getJson(url, timeoutMs = 2500) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) return { _error: `HTTP ${r.status}`, _text: text.slice(0, 300) };
    try { return JSON.parse(text); } catch { return { _error: 'NOT_JSON', _text: text.slice(0, 300) }; }
  } catch (e) {
    return { _error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEvents(tracker) {
  const raw = Array.isArray(tracker?.events) ? tracker.events :
    Array.isArray(tracker?.latestEvents) ? tracker.latestEvents : [];
  return raw.filter(x => x && (x.reason === 'TP' || x.reason === 'SL' || x.type?.includes('RESULT'))).slice(0, 20);
}

async function snapshot() {
  const [onetap, tracker, analytics] = await Promise.all([
    getJson(ONETAP), getJson(TRACKER), ANALYTICS ? getJson(ANALYTICS) : Promise.resolve(null)
  ]);

  const events = normalizeEvents(tracker);
  const tp = events.filter(x => x.reason === 'TP').length;
  const sl = events.filter(x => x.reason === 'SL').length;
  const ev = onetap?.evGate || onetap?.executionGate || {};
  const shadow = onetap?.shadowLab || {};
  const live = !!onetap?.live;
  const pending = Number(onetap?.pending || 0);
  const liveTrades = Number(onetap?.liveTrades || 0);
  const matched = Number(shadow?.matched || 0);
  const target = 20;

  let action = '等待合格机会，不需要操作';
  let actionTone = 'wait';
  if (!live) { action = 'LIVE 目前关闭'; actionTone = 'warn'; }
  else if (liveTrades > 0) { action = `有 ${liveTrades} 个真钱仓位正在运行`; actionTone = 'live'; }
  else if (pending > 0) { action = `有 ${pending} 张 LIVE ticket 等你在 Telegram 决定`; actionTone = 'live'; }
  else if (matched >= target) { action = 'Shadow Lab 已到复盘点，可以评估下一次升级'; actionTone = 'review'; }

  return {
    ok: !onetap?._error,
    ts: new Date().toISOString(),
    engine: { name: 'Combined Edge', locked: true, role: '负责方向、Entry、SL、TP' },
    adapter: {
      version: onetap?.version || 'EV_V2', live, pending, liveTrades,
      minNetEVR: ev.minNetEVR ?? null,
      minNetRRFloor: ev.minNetRRFloor ?? ev.minNetRR ?? null,
      priorWinRate: ev.priorWinRate ?? null,
      riskPct: onetap?.riskPct ?? null,
      maxOpenPositions: onetap?.maxOpenPositions ?? null
    },
    shadow: {
      open: Number(shadow?.open || 0), matched,
      wins: Number(shadow?.wins || 0), losses: Number(shadow?.losses || 0),
      adaptiveWinProb: shadow?.adaptiveWinProb ?? null,
      reviewTarget: target,
      progressPct: Math.min(100, matched / target * 100)
    },
    tracker: {
      ok: !tracker?._error,
      wsConnected: tracker?.wsConnected ?? null,
      tracked: tracker?.tracked ?? tracker?.trackedOpen ?? null,
      terminal: tracker?.terminal ?? null,
      recentTP: tp, recentSL: sl, events
    },
    action: { text: action, tone: actionTone },
    analytics,
    diagnostics: {
      onetapError: onetap?._error || null,
      trackerError: tracker?._error || null,
      analyticsError: analytics?._error || null
    }
  };
}

const html = `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#071018"><title>Money Hunter Live</title>
<style>
:root{--bg:#071018;--card:#0e1a25;--card2:#111f2c;--line:#203240;--text:#eef7ff;--muted:#8fa7ba;--good:#2ee6a6;--bad:#ff6680;--warn:#ffc857;--blue:#64b5ff;--purple:#b79cff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#102536 0,#071018 38%);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:980px;margin:auto;padding:18px 14px 60px}.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:16px}.eyebrow{color:var(--blue);font-weight:800;font-size:12px;letter-spacing:.12em}.title{font-size:28px;font-weight:900;margin:2px 0}.sub{color:var(--muted);font-size:13px}.pill{padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:#0b1721;color:var(--muted);white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}.card{grid-column:span 4;background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 12px 35px #0004}.wide{grid-column:span 8}.full{grid-column:1/-1}.label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.big{font-size:24px;font-weight:900;margin-top:5px}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.blue{color:var(--blue)}.purple{color:var(--purple)}.row{display:flex;justify-content:space-between;gap:12px;margin-top:9px}.v{font-weight:800}.action{font-size:20px;font-weight:900;margin-top:7px}.bar{height:9px;background:#071018;border-radius:99px;overflow:hidden;margin-top:12px;border:1px solid var(--line)}.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--blue),var(--good));transition:.4s}.pipe{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;align-items:center;gap:8px;margin-top:12px}.step{background:#09141d;border:1px solid var(--line);border-radius:14px;padding:12px;text-align:center;font-weight:800}.arrow{color:var(--muted);font-size:20px}.table{margin-top:10px;overflow:auto;border:1px solid var(--line);border-radius:14px}.tr{display:grid;grid-template-columns:1.1fr .7fr .7fr 1fr;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);min-width:520px}.tr:last-child{border-bottom:0}.th{color:var(--muted);font-size:11px;text-transform:uppercase}.status{font-weight:900}.tiny{font-size:11px;color:var(--muted)}button{background:#132b3c;color:#fff;border:1px solid #2a485e;border-radius:12px;padding:9px 12px;font-weight:800}.footer{color:var(--muted);font-size:11px;margin-top:14px;text-align:center}
@media(max-width:720px){.card,.wide{grid-column:1/-1}.title{font-size:24px}.top{align-items:flex-start;flex-direction:column}.pipe{grid-template-columns:1fr}.arrow{transform:rotate(90deg);text-align:center}.big{font-size:22px}}
</style></head><body><main class="wrap">
<div class="top"><div><div class="eyebrow">MONEY HUNTER</div><div class="title">Live Control Room</div><div class="sub">看懂一件事：发动机有没有机会、真钱适不适合做、你现在需不需要行动。</div></div><div class="pill" id="updated">Loading…</div></div>
<div class="grid">
<section class="card"><div class="label">发动机</div><div class="big good">Combined Edge</div><div class="row"><span>核心逻辑</span><span class="v">LOCKED</span></div><div class="sub">方向 / Entry / SL / TP 不乱改</div></section>
<section class="card"><div class="label">真钱适配层</div><div class="big blue" id="version">EV V2</div><div class="row"><span>状态</span><span class="v" id="live">—</span></div><div class="sub">只负责 Binance 成本与执行质量</div></section>
<section class="card"><div class="label">现在我要做什么？</div><div class="action" id="action">读取中…</div><div class="sub" id="pendingText">—</div></section>

<section class="card wide"><div class="label">Shadow Lab 学习进度</div><div class="big"><span id="matched">0</span> / <span id="target">20</span> 已结算</div><div class="bar"><i id="progress"></i></div><div class="row"><span>TP <b class="good" id="wins">0</b></span><span>SL <b class="bad" id="losses">0</b></span><span>当前学习胜率 <b id="wp">—</b></span></div><div class="sub">到 20 单才复盘，不因几单结果乱改系统。</div></section>
<section class="card"><div class="label">LIVE 风控</div><div class="row"><span>每单目标风险</span><span class="v" id="risk">—</span></div><div class="row"><span>最多同时仓位</span><span class="v" id="maxopen">—</span></div><div class="row"><span>最低 Net EV</span><span class="v" id="minev">—</span></div><div class="row"><span>安全 RR floor</span><span class="v" id="minrr">—</span></div></section>

<section class="card full"><div class="label">整套系统其实只有这 4 步</div><div class="pipe"><div class="step">① Combined Edge<br><span class="tiny">找机会</span></div><div class="arrow">→</div><div class="step">② EV Adapter<br><span class="tiny">真钱值得吗？</span></div><div class="arrow">→</div><div class="step">③ 你按 Confirm<br><span class="tiny">最后决定</span></div><div class="arrow">→</div><div class="step">④ Binance LIVE<br><span class="tiny">结果再喂回来学习</span></div></div></section>

<section class="card full"><div class="row" style="margin-top:0"><div><div class="label">最近 Binance Realtime 结果</div><div class="sub">这是 Combined Edge tracker，不等于每一单都真钱成交。</div></div><button onclick="load()">刷新</button></div><div class="table" id="table"><div class="tr th"><span>币</span><span>方向</span><span>结果</span><span>时间</span></div></div></section>
</div><div class="footer">Auto refresh every 5 seconds · Money Hunter dashboard</div></main>
<script>
const $=id=>document.getElementById(id);function pct(v){return Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+'%':'—'}
function time(v){if(!v)return'—';const d=new Date(v);return isNaN(d)?'—':d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}
async function load(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();$('updated').textContent='Updated '+new Date(d.ts).toLocaleTimeString();$('version').textContent=d.adapter.version||'EV V2';$('live').textContent=d.adapter.live?'LIVE ON':'OFF';$('live').className='v '+(d.adapter.live?'good':'bad');$('action').textContent=d.action.text;$('action').className='action '+(d.action.tone==='live'?'good':d.action.tone==='warn'?'bad':d.action.tone==='review'?'purple':'warn');$('pendingText').textContent='Pending '+d.adapter.pending+' · Open LIVE '+d.adapter.liveTrades;$('matched').textContent=d.shadow.matched;$('target').textContent=d.shadow.reviewTarget;$('progress').style.width=d.shadow.progressPct+'%';$('wins').textContent=d.shadow.wins;$('losses').textContent=d.shadow.losses;$('wp').textContent=pct(d.shadow.adaptiveWinProb);$('risk').textContent=(d.adapter.riskPct??'—')+(d.adapter.riskPct!=null?'%':'');$('maxopen').textContent=d.adapter.maxOpenPositions??'—';$('minev').textContent=d.adapter.minNetEVR!=null?'+'+Number(d.adapter.minNetEVR).toFixed(2)+'R':'—';$('minrr').textContent=d.adapter.minNetRRFloor!=null?Number(d.adapter.minNetRRFloor).toFixed(2):'—';const t=$('table');t.innerHTML='<div class="tr th"><span>币</span><span>方向</span><span>结果</span><span>时间</span></div>';for(const e of d.tracker.events||[]){const row=document.createElement('div');row.className='tr';const res=e.reason||'—';row.innerHTML='<span class="v">'+String(e.symbol||'—').replace('USDT','')+'</span><span>'+String(e.side||'—')+'</span><span class="status '+(res==='TP'?'good':res==='SL'?'bad':'')+'">'+res+'</span><span class="tiny">'+time(e.closedAt||e.receivedAt||e.tickTs)+'</span>';t.appendChild(row)}if((d.tracker.events||[]).length===0){const row=document.createElement('div');row.className='tr';row.innerHTML='<span class="sub">暂无最近结果</span><span></span><span></span><span></span>';t.appendChild(row)}}catch(e){$('updated').textContent='Connection error'}}
load();setInterval(load,5000);
</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/health') {
    const s = await snapshot();
    res.writeHead(s.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: s.ok, service: 'money-hunter-dashboard', onetap: !s.diagnostics.onetapError, tracker: !s.diagnostics.trackerError }));
  }
  if (u.pathname === '/api/status') {
    const s = await snapshot();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(s));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}).listen(PORT, '0.0.0.0', () => console.log('MONEY_HUNTER_DASHBOARD_READY', PORT));
