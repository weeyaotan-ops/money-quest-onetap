const http = require("http");
const { URL } = require("url");
const PORT = process.env.PORT || 8080;

function esc(s="") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function render(params) {
  const symbol = (params.get("symbol") || "").toUpperCase();
  const side = (params.get("side") || "").toUpperCase();
  const entry = num(params.get("entry"));
  const sl = num(params.get("sl"));
  const tp = num(params.get("tp"));
  const contracts = num(params.get("contracts"));
  const leverage = num(params.get("leverage"));
  const margin = num(params.get("margin"));
  const equity = num(params.get("equity"));
  const targetRisk = num(params.get("targetRisk"));
  const actualMaxLoss = num(params.get("actualMaxLoss"));
  const riskUtil = targetRisk && actualMaxLoss != null ? (actualMaxLoss / targetRisk) * 100 : null;

  const ticket = [
    `SYMBOL: ${symbol || "-"}`,
    `SIDE: ${side || "-"}`,
    `ENTRY: ${entry ?? "-"}`,
    `SL: ${sl ?? "-"}`,
    `TP: ${tp ?? "-"}`,
    `CONTRACTS: ${contracts ?? "-"}`,
    `LEVERAGE: ${leverage != null ? leverage + "x" : "-"}`,
    `MARGIN: ${margin ?? "-"}`,
    `EQUITY: ${equity ?? "-"}`,
    `TARGET RISK: ${targetRisk ?? "-"}`,
    `ACTUAL MAX LOSS: ${actualMaxLoss ?? "-"}`,
    `RISK UTILIZATION: ${riskUtil != null ? riskUtil.toFixed(1) + "%" : "-"}`
  ].join("\n");

  const okxSymbol = symbol.replace("-USDT-SWAP", "-USDT");
  const okxUrl = okxSymbol
    ? `https://www.okx.com/trade-swap/${encodeURIComponent(okxSymbol.toLowerCase())}-swap`
    : "https://www.okx.com/";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Money Quest Ticket Helper</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:30px auto;padding:0 16px}
.card{border:1px solid #ddd;border-radius:14px;padding:18px}
pre{white-space:pre-wrap;background:#f6f6f6;padding:14px;border-radius:10px}
button,a.btn{display:inline-block;padding:12px 16px;margin:6px 6px 0 0;border-radius:10px;border:0;text-decoration:none;background:#111;color:#fff;font-weight:600}
.small{color:#666;font-size:13px}
</style></head><body>
<div class="card">
<h2>Money Quest Trade Ticket</h2>
<pre id="ticket">${esc(ticket)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('ticket').innerText)">Copy full ticket</button>
<a class="btn" href="${esc(okxUrl)}" target="_blank" rel="noopener">Open OKX</a>
<p class="small">No order is submitted. Final trade entry remains manual.</p>
</div></body></html>`;
}
http.createServer((req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (u.pathname === "/health") {
    res.writeHead(200, {"content-type":"application/json"});
    return res.end(JSON.stringify({ok:true, mode:"manual-confirmation-only"}));
  }
  if (u.pathname === "/ticket") {
    res.writeHead(200, {"content-type":"text/html; charset=utf-8"});
    return res.end(render(u.searchParams));
  }
  res.writeHead(200, {"content-type":"text/plain; charset=utf-8"});
  res.end("Money Quest safe helper");
}).listen(PORT, ()=>console.log(`SAFE_HELPER_LISTEN ${PORT}`));
