// Small request registry for TeslaMon's pre-dispatch UI work. Each named
// operation supersedes its previous request; callers must still check current().
export function createTeslaMonPetLifecycle(){
  const slots=new Map();
  function begin(name){
    const previous=slots.get(name);
    previous?.controller.abort();
    const slot={version:(previous?.version||0)+1,controller:new AbortController()};
    slots.set(name,slot);
    return {signal:slot.controller.signal,
      current:()=>slots.get(name)===slot&&!slot.controller.signal.aborted,
      finish:()=>{if(slots.get(name)===slot)slots.delete(name);}};
  }
  function cancel(name){
    const slot=slots.get(name);
    if(!slot)return;
    slots.delete(name);slot.controller.abort();
  }
  function cancelAll(){for(const name of slots.keys())cancel(name);}
  return {begin,cancel,cancelAll};
}
