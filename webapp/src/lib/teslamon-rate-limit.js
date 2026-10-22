// Bounded per-authenticated-controller token buckets; never key on request text
// or unverified headers. No timers, persistence or idle work.
export function createTeslaMonRateLimit({now=Date.now,capacity=30,refillMs=2000,maxControllers=256}={}){
  const buckets=new Map();
  return Object.freeze({
    consume(controller){
      const stamp=now();
      for(const [key,b] of buckets)if(stamp-b.at>=capacity*refillMs)buckets.delete(key);
      let b=buckets.get(controller);
      if(!b){
        if(typeof controller!=='string'||!controller||buckets.size>=maxControllers)return false;
        b={tokens:capacity,at:stamp};buckets.set(controller,b);
      }
      b.tokens=Math.min(capacity,b.tokens+Math.max(0,stamp-b.at)/refillMs);b.at=stamp;
      if(b.tokens<1)return false;b.tokens--;return true;
    }
  });
}
