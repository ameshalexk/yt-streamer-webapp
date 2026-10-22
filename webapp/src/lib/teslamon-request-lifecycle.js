// A response may close after the request body was already fully received.
// Watch both directions; normal successful response closure is not cancellation.
export function createTeslaMonRequestLifecycle(req,res,{timeoutMs=60000}={}){
  const controller=new AbortController();
  const abort=()=>controller.abort();
  const closed=()=>{if(!res.writableEnded)abort();};
  const timer=setTimeout(abort,timeoutMs);
  timer.unref?.();
  req.once('aborted',abort);res.once('close',closed);
  if(req.aborted||res.destroyed)abort();
  return {signal:controller.signal,dispose(){
    clearTimeout(timer);req.removeListener('aborted',abort);res.removeListener('close',closed);
  }};
}
