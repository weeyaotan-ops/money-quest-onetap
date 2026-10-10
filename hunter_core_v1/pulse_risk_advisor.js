'use strict';
// HTR Pulse advisory only. Every exchange request below is GET. No orders.
// The calculated liquidation headroom is a conservative model, NOT Binance's
// actual liquidation quote. Binance's displayed value must be checked manually.
const crypto=require('node:crypto');
const API=process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com';
const MAX_LEVERAGE=40,MAX_MARGIN=10;
const FEE_RATE=0.00075;           // conservative taker fee PER SIDE
const ENTRY_SLIPPAGE=0.002;      // worse entry by 0.20%
const EXIT_SLIPPAGE=0.002;       // worse stop fill by 0.20%
const LIQ_BUFFER=0.005;         // additional 0.50% price distance to SL
const EXTRA_EQUITY_BUFFER=0.007;// extra 0.70% notional above maintenance
const MAX_MARK_DRIFT=0.004;
const MAX_AGE_MS=3*60000;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const noTrade=(score,margin,reason)=>({
 status:'NO TRADE',score,margin,reason,estimatedLoss:null,leverage:null
});
function marginForScore(score){
 if(!Number.isFinite(score)||score<0||score>100)throw Error('Invalid setup quality score');
 return score>=82?10:score>=68?7:score>=54?5:3;
}
function qualityLabel(score){return score>=82?'HIGH':score>=68?'GOOD':score>=54?'NORMAL':'LOW';}
function scoreSetup(data){
 if(!data||!Number.isFinite(data.volumeRatio)||!Number.isFinite(data.bodyRatio)||
 !Number.isFinite(data.extensionAtr)||!Number.isFinite(data.trendSpread)||
 !Number.isFinite(data.netR))throw Error('Missing quality inputs');
 const norm=(x,lo,hi)=>clamp((x-lo)/(hi-lo),0,1);
 const score=100*(
   .27*norm(data.volumeRatio,1.2,2.8)+
   .26*norm(data.bodyRatio,.50,.85)+
   .19*norm(data.netR,1.5,1.85)+
   .16*(1-norm(data.extensionAtr,0,.7))+
   .12*norm(data.trendSpread,.001,.018));
 return Math.round(clamp(score,0,100));
}
function decimals(step){
 const s=String(step).toLowerCase();
 if(s.includes('e-'))return Number(s.split('e-')[1]);
 return (s.split('.')[1]||'').length;
}
function parseInfo(exchange,symbol){
 const item=exchange?.symbols?.find(x=>x.symbol===symbol);
 if(!item||item.status!=='TRADING'||item.contractType!=='PERPETUAL'||
    item.quoteAsset!=='USDT')throw Error('Binance USDT perpetual unavailable');
 const lot=item.filters?.find(x=>x.filterType==='MARKET_LOT_SIZE'&&Number(x.stepSize)>0)||
    item.filters?.find(x=>x.filterType==='LOT_SIZE');
 const normal=item.filters?.find(x=>x.filterType==='LOT_SIZE');
 const min=Math.max(Number(lot?.minQty||0),Number(normal?.minQty||0));
 const max=Number(lot?.maxQty),step=Number(lot?.stepSize);
 const minimumNotional=Number(item.filters?.find(x=>x.filterType==='MIN_NOTIONAL')?.notional);
 if(!(step>0&&max>0&&min>=0&&minimumNotional>0&&decimals(step)<=12))throw Error('Binance quantity/min-notional rules unavailable');
 return {step,min,max,minimumNotional};
}
function parseBrackets(payload,symbol){
 const row=Array.isArray(payload)?payload.find(x=>x.symbol===symbol):null;
 if(!Array.isArray(row?.brackets)||!row.brackets.length)throw Error('Signed Binance maintenance brackets unavailable');
 const parsed=row.brackets.map(b=>({
 floor:Number(b.notionalFloor),cap:Number(b.notionalCap),
 ratio:Number(b.maintMarginRatio),maxLeverage:Number(b.initialLeverage)
 })).sort((a,b)=>a.floor-b.floor);
 if(parsed.some(b=>!(b.floor>=0)||!(b.cap>b.floor)||!(b.ratio>=0&&b.ratio<1)||
    !Number.isInteger(b.maxLeverage)||b.maxLeverage<1))throw Error('Incomplete Binance maintenance brackets');
 return parsed;
}
function calculate(signal,market,now=Date.now()){
 const score=Number(signal?.setupScore);
 const margin=Number.isFinite(score)?marginForScore(score):null;
 if(margin===null)return noTrade(null,null,'Setup quality unavailable');
 const invalid=reason=>noTrade(score,margin,reason);
 const side=signal.side,dir=side==='LONG'?1:side==='SHORT'?-1:0;
 const entry=Number(signal.entry),stop=Number(signal.stop),mark=Number(market?.markPrice);
 if(!dir||!(entry>0)||!(stop>0)||!(mark>0)||
    !(dir*(entry-stop)>0))return invalid('Invalid signal or Binance mark price');
 if(!(Number.isFinite(signal.at)&&Number.isFinite(now))||now-signal.at>MAX_AGE_MS||now<signal.at)
   return invalid('Signal is stale (over 3 minutes); await a new entry');
 if(Number.isFinite(market?.markTime)&&now-market.markTime>30000)
   return invalid('Binance mark price is stale');
 if(Math.abs(mark/entry-1)>MAX_MARK_DRIFT)
   return invalid('Live mark moved >0.4% from signal Entry');
 if(dir*(mark-stop)<=0||dir*(signal.tp1-mark)<=0)
   return invalid('SL already crossed or TP1 already reached');
 let info,brackets;
 try{info=parseInfo(market.exchange,signal.symbol);
   brackets=parseBrackets(market.brackets,signal.symbol);}
 catch(e){return invalid(String(e.message||e));}
 // Entry model includes adverse 0.20% fill. Quantity is sized with an even
 // higher price bound to keep initial margin under its budget.
 const adverseEntry=dir>0?Math.max(entry,mark)*(1+ENTRY_SLIPPAGE):
   Math.min(entry,mark)*(1-ENTRY_SLIPPAGE);
 const sizingPrice=Math.max(entry,mark)*(1+ENTRY_SLIPPAGE);
 const stopFill=stop*(1-dir*EXIT_SLIPPAGE);
 const threshold=stop*(1-dir*LIQ_BUFFER);
 const stopDistance=dir*(adverseEntry-stopFill);
 if(!(stopDistance>0))return invalid('Stop is invalid after adverse fill buffer');
 for(let leverage=MAX_LEVERAGE;leverage>=1;leverage--){
   const rawQty=Math.floor((margin*leverage/sizingPrice)/info.step+1e-9)*info.step;
   const qty=Number(rawQty.toFixed(decimals(info.step)));
   const openNotional=qty*adverseEntry;
   const stopNotional=qty*stopFill;
   const worstNotional=Math.max(openNotional,stopNotional);
   if(!(qty>=info.min&&qty<=info.max&&qty*sizingPrice>=info.minimumNotional&&
      qty*sizingPrice<=margin*leverage+1e-7))continue;
   // Fee/slippage budget is applied at the adverse entry and stressed stop.
   const priceLoss=qty*stopDistance;
   const estimatedFees=(openNotional+stopNotional)*FEE_RATE;
   const estimatedLoss=priceLoss+estimatedFees;
   // Check maintenance bracket at both entry and stress-stop notionals,
   // ignoring maintenance deduction (conservative).
   const bracket=brackets.find(b=>worstNotional>=b.floor&&worstNotional<b.cap);
   if(!bracket||leverage>bracket.maxLeverage)continue;
   const initialMargin=openNotional/leverage;
   const maintenance=worstNotional*bracket.ratio;
   const extra=worstNotional*EXTRA_EQUITY_BUFFER;
   const equityAtStop=initialMargin-estimatedLoss;
   const bufferUSDT=equityAtStop-maintenance-extra;
   if(!(bufferUSDT>0))continue;
   // This is a model-based PASS, not a verified exchange liquidation price.
   return {status:'CHECK BINANCE',score,quality:qualityLabel(score),
     margin,leverage,quantity:qty,notional:openNotional,estimatedLoss,
     fees:estimatedFees,lossBeforeFees:priceLoss,
     stopRiskPct:100*estimatedLoss/Math.max(initialMargin,1e-9),
     modelBuffer:bufferUSDT,liqCheckThreshold:threshold,side,
     reason:'Model passes. Verify the ACTUAL Binance isolated liquidation price and order quantity before entering.'};
 }
 return invalid('No Binance-valid size/leverage 1–40x passes conservative SL/liquidation buffer');
}
let infoCache=null,infoCacheAt=0;
async function getJson(path,headers={}){
 const r=await fetch(API+path,{method:'GET',headers,signal:AbortSignal.timeout(6500)});
 const j=await r.json();
 if(!r.ok||(typeof j?.code==='number'&&j.code<0))
  throw Error('Binance read-only request failed '+String(j?.code||r.status));
 return j;
}
function signedHeaders(path,params){
 const pem=(process.env.BINANCE_ED25519_PRIVATE_KEY_PEM||'').replace(/\\n/g,'\n');
 const key=process.env.BINANCE_API_KEY;
 if(!pem||!key)throw Error('Signed maintenance data credentials unavailable');
 const query=new URLSearchParams({...params,recvWindow:'5000',timestamp:String(Date.now())}).toString();
 const signature=crypto.sign(null,Buffer.from(query),crypto.createPrivateKey(pem)).toString('base64');
 return {url:path+'?'+query+'&signature='+encodeURIComponent(signature),
   headers:{'X-MBX-APIKEY':key}};
}
async function marketData(symbol){
 const now=Date.now();
 if(!infoCache||now-infoCacheAt>10*60000){
  infoCache=await getJson('/fapi/v1/exchangeInfo');infoCacheAt=Date.now();
 }
 const signed=signedHeaders('/fapi/v1/leverageBracket',{symbol});
 const [mark,brackets]=await Promise.all([
  getJson('/fapi/v1/premiumIndex?symbol='+encodeURIComponent(symbol)),
  getJson(signed.url,signed.headers)
 ]);
 return {exchange:infoCache,markPrice:Number(mark.markPrice),
   markTime:Number(mark.time)||0,brackets};
}
async function advise(signal){
 const score=Number(signal?.setupScore);
 const margin=Number.isFinite(score)&&score>=0&&score<=100?marginForScore(score):null;
 try{return calculate(signal,await marketData(signal.symbol));}
 catch(e){return noTrade(score,margin,'Binance risk data unavailable: '+String(e.message||e).slice(0,110));}
}
module.exports={MAX_MARGIN,MAX_LEVERAGE,FEE_RATE,ENTRY_SLIPPAGE,EXIT_SLIPPAGE,
 LIQ_BUFFER,EXTRA_EQUITY_BUFFER,MAX_MARK_DRIFT,scoreSetup,marginForScore,
 parseInfo,parseBrackets,calculate,advise};
