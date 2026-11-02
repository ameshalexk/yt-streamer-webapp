/**
 * Moonshine worker adapter matching the TeslaMon Whisper VoiceEngine contract.
 * Experimental opt-in model in the shared transcription-model picker.
 */
function abortError() {
  const error = new Error('Moonshine transcription was canceled.');
  error.name = 'AbortError';
  return error;
}
function withAbort(promise,signal,onAbort) {
  if(!signal)return promise;
  if(signal.aborted){onAbort();return Promise.reject(abortError());}
  return new Promise((resolve,reject)=>{
    const cancel=()=>{cleanup();onAbort();reject(abortError());};
    const cleanup=()=>signal.removeEventListener('abort',cancel);
    signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
export class MoonshineVoiceEngine {
  constructor() {
    this.worker=null;
    this.loaded=false;
    this.modelInfo=null;
    this.pending=new Map();
    this.nextId=0;
    this.loading=null;
    this.busy=false;
    this.disposed=false;
    this.onProgress=new Set();
  }
  _worker() {
    if(this.disposed)throw new Error('Moonshine engine disposed.');
    if(!globalThis.crossOriginIsolated || typeof SharedArrayBuffer==='undefined') {
      throw new Error('Moonshine WASM needs cross-origin isolation. Select Moonshine in the transcription model picker to open isolated mode.');
    }
    if(!this.worker) {
      this.worker=new Worker(new URL('./teslamon-moonshine-worker.js',import.meta.url),{type:'module'});
      this.worker.onmessage=event=>this._handle(event.data||{});
      this.worker.onerror=event=>this._reset(new Error(event?.message||'Moonshine worker crashed.'));
      this.worker.onmessageerror=()=>this._reset(new Error('Moonshine worker returned invalid data.'));
    }
    return this.worker;
  }
  _handle(data) {
    const entry=this.pending.get(data.id);
    if(!entry)return;
    if(data.type==='progress') {
      if(entry.type==='load')for(const callback of this.onProgress) {
        try{callback(data);}catch{}
      }
      return;
    }
    if(data.type==='error') {
      this._reset(new Error(data.message||'Moonshine transcription failed.'));
      return;
    }
    if(data.type==='ready') {
      this.loaded=true;
      this.modelInfo=data.modelInfo;
      entry.resolve(this.modelInfo);
      return;
    }
    if(data.type==='result')entry.resolve({text:data.text,elapsedMs:data.elapsedMs});
  }
  _request(type,payload={},timeoutMs=30000) {
    const worker=this._worker();
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const entry={id,type,timer:null,
        resolve:value=>{this.pending.delete(id);clearTimeout(entry.timer);resolve(value);},
        reject:error=>{this.pending.delete(id);clearTimeout(entry.timer);reject(error);}
      };
      entry.timer=setTimeout(()=>{
        this._reset(new Error(type==='load'?'Moonshine model loading timed out.':'Moonshine transcription timed out.'));
      },timeoutMs);
      this.pending.set(id,entry);
      try {
        if(type==='transcribe')worker.postMessage({id,type,...payload},[payload.audio.buffer]);
        else worker.postMessage({id,type,...payload});
      } catch(error) {entry.reject(error);}
    });
  }
  _reset(error) {
    const previous=this.worker;
    this.worker=null;
    this.loaded=false;
    this.modelInfo=null;
    this.loading=null;
    this.busy=false;
    this.onProgress.clear();
    if(previous){previous.onmessage=null;previous.onerror=null;previous.onmessageerror=null;previous.terminate();}
    for(const entry of [...this.pending.values()])entry.reject(error);
    this.pending.clear();
  }
  async load({signal,onProgress}={}) {
    if(this.disposed)throw new Error('Moonshine engine disposed.');
    if(signal?.aborted)throw abortError();
    if(this.loaded)return this.modelInfo;
    if(onProgress)this.onProgress.add(onProgress);
    if(!this.loading) {
      this.loading=this._request('load',{},120000)
        .finally(()=>{this.loading=null;this.onProgress.clear();});
      this.loading.catch(()=>{});
    }
    try {return await withAbort(this.loading,signal,()=>this._reset(abortError()));}
    finally {if(onProgress)this.onProgress.delete(onProgress);}
  }
  async transcribe(audio,{signal}={}) {
    if(this.disposed)throw new Error('Moonshine engine disposed.');
    if(signal?.aborted)throw abortError();
    if(this.busy)throw new Error('A Moonshine transcription is already in progress.');
    await this.load({signal});
    if(signal?.aborted)throw abortError();
    const samples=audio instanceof Float32Array?audio:Float32Array.from(audio||[]);
    if(!samples.length||samples.length>16*16000)throw new Error('Invalid Moonshine clip length.');
    this.busy=true;
    try {return await withAbort(this._request('transcribe',{audio:samples},35000),signal,()=>this._reset(abortError()));}
    finally {this.busy=false;}
  }
  cancelPending() {
    if(!this.loading&&!this.busy)return false;
    this._reset(abortError());
    return true;
  }
  dispose() {
    if(this.disposed)return;
    this.disposed=true;
    this._reset(new Error('Moonshine engine disposed.'));
  }
}
