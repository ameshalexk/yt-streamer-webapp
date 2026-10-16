import crypto from 'node:crypto';

// In-memory, input-only, short-lived relay. Never stores a guest frame or disk sector.
const token=()=>crypto.randomBytes(24).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const error=(status,message)=>({status,body:{error:message}});
const ok=(body,status=200)=>({status,body});
const bounded=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
function commandValid(c){
 if(!c||typeof c!=='object'||Array.isArray(c))return false;
 if(c.type==='key')return Array.isArray(c.codes)&&c.codes.length>0&&c.codes.length<=24&&c.codes.every(v=>bounded(v,0,255));
 if(c.type==='text')return typeof c.value==='string'&&c.value.length>=1&&c.value.length<=120&&/^[\x20-\x7e]*$/.test(c.value);
 if(c.type==='move')return bounded(c.dx,-100,100)&&bounded(c.dy,-100,100);
 if(c.type==='click')return ['left','right','middle'].includes(c.button);
 if(c.type==='wheel')return bounded(c.delta,-3,3);
 return false;
}
export class RetroRemoteRelay {
 constructor({now=Date.now,maxSessions=20}={}){this.sessions=new Map();this.now=now;this.maxSessions=maxSessions;}
 sweep(){
  const t=this.now();
  for(const [id,s] of this.sessions){
   if(t-s.hostSeen>35000||(s.controllerToken&&t-s.lastControl>20*60_000)||(!s.controllerToken&&t>s.pairUntil))this.remove(id);
  }
 }
 remove(id){const s=this.sessions.get(id);if(!s)return;this.sessions.delete(id);for(const w of s.waiters){clearTimeout(w.timer);w.finish(ok({commands:[],closed:true}));}s.waiters.clear();}
 create(owner){
  this.sweep();if(this.sessions.size>=this.maxSessions)return error(429,'Remote session limit reached');
  if([...this.sessions.values()].filter(s=>s.owner===owner).length>=2)return error(429,'Close an existing remote session first');
  const id=crypto.randomBytes(12).toString('base64url');
  const s={id,owner,hostToken:token(),pairSecret:token(),controllerToken:null,hostSeen:this.now(),pairUntil:this.now()+5*60_000,lastControl:this.now(),commands:[],waiters:new Set(),rateTime:this.now(),rateCount:0};
  this.sessions.set(id,s);
  return ok({id,hostToken:s.hostToken,pairSecret:s.pairSecret,pairUntil:s.pairUntil},201);
 }
 session(id,owner){const s=this.sessions.get(id);return s?.owner===owner?s:null;}
 join(id,owner,secret){
  this.sweep();const s=this.session(id,owner);
  if(!s||!equal(s.pairSecret,secret)||this.now()>s.pairUntil||s.controllerToken)return error(403,'Pairing unavailable or expired');
  s.controllerToken=token();s.pairSecret=null;s.lastControl=this.now();
  return ok({controllerToken:s.controllerToken});
 }
 send(id,owner,key,command){
  this.sweep();const s=this.session(id,owner);
  if(!s||!equal(s.controllerToken,key))return error(403,'Remote control not paired');
  if(!commandValid(command))return error(400,'Invalid control command');
  const t=this.now();if(t-s.rateTime>=1000){s.rateTime=t;s.rateCount=0;}
  if(++s.rateCount>35)return error(429,'Too many remote inputs');
  if(s.commands.length>=80)return error(429,'Remote input queue full');
  s.lastControl=t;s.commands.push(command);
  this.notify(s);
  return ok({accepted:true});
 }
 notify(s){
  if(!s.waiters.size)return;
  const commands=s.commands.splice(0,40);
  for(const w of s.waiters){clearTimeout(w.timer);w.finish(ok({commands,closed:false}));}
  s.waiters.clear();
 }
 poll(id,owner,key){
  this.sweep();const s=this.session(id,owner);
  if(!s||!equal(s.hostToken,key))return Promise.resolve(error(403,'Host session expired'));
  s.hostSeen=this.now();
  if(s.commands.length)return Promise.resolve(ok({commands:s.commands.splice(0,40),closed:false,paired:!!s.controllerToken}));
  if(s.waiters.size)return Promise.resolve(error(409,'Host already polling'));
  return new Promise(finish=>{
   const w={finish,timer:null};w.timer=setTimeout(()=>{s.waiters.delete(w);finish(ok({commands:[],closed:false,paired:!!s.controllerToken}));},9000);s.waiters.add(w);
  });
 }
 close(id,owner,key){const s=this.session(id,owner);if(!s||!equal(s.hostToken,key))return error(403,'Host session not found');this.remove(id);return ok({closed:true});}
 async dispatch({method,path,owner,body,key}){
  if(!owner)return error(401,'Sign in to Cloudflare Access first');
  if(method==='POST'&&path==='/sessions')return this.create(owner);
  const match=/^\/sessions\/([\w-]{16})(?:\/(join|command|poll))?$/.exec(path);
  if(!match)return error(404,'Remote endpoint not found');
  const [,id,op]=match;
  if(method==='POST'&&op==='join')return this.join(id,owner,body?.secret);
  if(method==='POST'&&op==='command')return this.send(id,owner,key,body);
  if(method==='GET'&&op==='poll')return await this.poll(id,owner,key);
  if(method==='DELETE'&&!op)return this.close(id,owner,key);
  return error(405,'Unsupported method');
 }
}

export function createRetroRemoteHTTP({authenticate,hostname='stream.ameshalex.com',relay=new RetroRemoteRelay()}={}){
 return async (req,res)=>{
  res.set('Cache-Control','no-store, max-age=0');res.set('X-Content-Type-Options','nosniff');
  try{
   if(req.hostname!==hostname)return res.status(404).json({error:'Unknown hostname'});
   // Prevent cross-site browser submissions even if cookies accompany the request.
   if(req.method!=='GET'&&req.get('origin')!==`https://${hostname}`)return res.status(403).json({error:'Same-origin request required'});
   const owner=await authenticate(req);
   const pathname=new URL(req.originalUrl,`https://${hostname}`).pathname;
   const result=await relay.dispatch({method:req.method,path:pathname.replace(/^\/api\/retro-pc\/remote/,''),owner,body:req.body,key:req.get('x-retro-token')});
   return res.status(result.status).json(result.body);
  }catch{return res.status(503).json({error:'Remote control temporarily unavailable'});}
 };
}
