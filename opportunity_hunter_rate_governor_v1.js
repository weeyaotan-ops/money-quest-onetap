'use strict';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

class BinanceIpWeightGovernor {
  constructor(opts={}){
    this.softLimit=Math.max(100,Number(opts.softLimit||process.env.HUNTER_BINANCE_WEIGHT_SOFT_LIMIT||1500));
    this.reserve=Math.max(0,2400-this.softLimit);
    this.pauseBufferMs=Math.max(500,Number(opts.pauseBufferMs||process.env.HUNTER_BINANCE_WEIGHT_PAUSE_BUFFER_MS||2500));
    this.maxPauseMs=Math.max(60000,Number(opts.maxPauseMs||5*60*1000));
    this.usedWeight=0;
    this.pauseUntil=0;
    this.lastHeaderAt=0;
    this.lastStatus=0;
    this.pauseEvents=0;
  }
  nextMinute(now=Date.now()){
    return (Math.floor(now/60000)+1)*60000+this.pauseBufferMs;
  }
  retryAfterMs(headers,now=Date.now()){
    const raw=String(headers?.get?.('retry-after')||'').trim();
    if(!raw)return 0;
    const sec=Number(raw);
    if(Number.isFinite(sec)&&sec>=0)return now+sec*1000;
    const d=Date.parse(raw);
    return Number.isFinite(d)?d:0;
  }
  observe(response,now=Date.now()){
    const raw=response?.headers?.get?.('x-mbx-used-weight-1m')??response?.headers?.get?.('X-MBX-USED-WEIGHT-1M');
    const weight=Number(raw);
    if(Number.isFinite(weight)&&weight>=0){
      this.usedWeight=weight;
      this.lastHeaderAt=now;
    }
    this.lastStatus=Number(response?.status||0);
    let until=0;
    if(response?.status===418||response?.status===429){
      until=Math.max(this.retryAfterMs(response.headers,now),this.nextMinute(now));
    }else if(Number.isFinite(weight)&&weight>=this.softLimit){
      until=this.nextMinute(now);
    }
    if(until>this.pauseUntil){
      this.pauseUntil=Math.min(now+this.maxPauseMs,until);
      this.pauseEvents++;
    }
    return this.snapshot(now);
  }
  async waitIfNeeded(){
    while(Date.now()<this.pauseUntil){
      await sleep(Math.min(5000,Math.max(50,this.pauseUntil-Date.now())));
    }
  }
  snapshot(now=Date.now()){
    return {
      softLimit:this.softLimit,
      reserve:this.reserve,
      usedWeight:this.usedWeight,
      paused:now<this.pauseUntil,
      pauseRemainingMs:Math.max(0,this.pauseUntil-now),
      pauseEvents:this.pauseEvents,
      lastHeaderAt:this.lastHeaderAt||null,
      lastStatus:this.lastStatus||null
    };
  }
}
module.exports={BinanceIpWeightGovernor};
