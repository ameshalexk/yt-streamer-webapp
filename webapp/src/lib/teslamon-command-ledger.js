// TeslaMon isolated TM-104: crash-conservative mutation journal.
// Never records audio, titles, URLs, credentials or command arguments.
// Not connected to live YT Streamer. The caller MUST supply a verified
// selected-browser binding and enforce per-command authorization/expiry.
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=new Set(['play_media','pause','resume','request_fullscreen','exit_fullscreen']);
const MAX_BYTES=8*1024*1024;
const OUTCOMES=new Set(['observed','accepted','failed','offline','unsupported',
  'needs_user_gesture','uncertain','cancelled']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const error=(code)=>Object.assign(new Error(code),{code});
const denied=(code)=>Object.freeze({status:'failed',code});
const uncertain=(code)=>Object.freeze({status:'uncertain',code});
const sameOwner=(st)=>st.isFile()&&!st.isSymbolicLink()&&
  (st.mode&0o077)===0&&(typeof process.getuid!=='function'||st.uid===process.getuid());

function fingerprint(command){
  if(!isObject(command)||!UUID.test(command.commandId||'')||
    !ACTIONS.has(command.action)||!isObject(command.binding)||
    !Number.isSafeInteger(command.expiresAt))throw error('invalid_mutation');
  const b=command.binding;
  if(![b.subject,b.controllerId,b.deviceKey,b.connectionId,b.origin]
    .every(v=>typeof v==='string'&&v.length>0&&v.length<=256))
    throw error('invalid_binding');
  return hash([command.action,b.subject,b.controllerId,b.deviceKey,
    b.connectionId,b.origin,command.expiresAt,command.args||{}]);
}

/** Only one process may hold this ledger; stale locks fail closed. */
export async function openTeslaMonCommandLedger({
  dir,now=Date.now,maxCommands=4096,timeoutMs=20000
}={}){
  if(!path.isAbsolute(dir||'')||typeof now!=='function'||
    !Number.isSafeInteger(maxCommands)||maxCommands<1||maxCommands>20000||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>30000)
    throw error('invalid_ledger_configuration');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const folder=await fs.lstat(dir);
  if(!folder.isDirectory()||folder.isSymbolicLink()||
    (folder.mode&0o077)!==0||
    (typeof process.getuid==='function'&&folder.uid!==process.getuid()))
    throw error('unsafe_ledger_directory');
  const lockPath=path.join(dir,'teslamon-commands.lock');
  const journalPath=path.join(dir,'teslamon-commands.jsonl');
  let lock,file,locked=false,closed=false;
  const commands=new Map(),activeTargets=new Set();
  let pending=0,writeTail=Promise.resolve(),reservationTail=Promise.resolve();
  try{
    // Deliberate fail-closed behavior after a process crash. An operator
    // must inspect a stale lock; do not silently unlink an active peer's lock.
    lock=await fs.open(lockPath,'wx',0o600);
    locked=true;
    file=await fs.open(journalPath,constants.O_RDWR|constants.O_APPEND|
      constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    const stat=await file.stat();
    if(!sameOwner(stat)||stat.size>MAX_BYTES)throw error('unsafe_journal');
    const journal=await file.readFile('utf8');
    if(journal.length&&(!journal.endsWith('\n')||Buffer.byteLength(journal)>MAX_BYTES))
      throw error('partial_or_oversize_journal');
    for(const line of journal.split('\n').filter(Boolean)){
      let record;
      try{record=JSON.parse(line);}catch{throw error('malformed_journal');}
      if(!isObject(record)||record.v!==1||!UUID.test(record.id||'')||
        !/^[0-9a-f]{64}$/.test(record.fp||'')||
        !['start','finish'].includes(record.op)||
        !Number.isSafeInteger(record.at))throw error('invalid_journal_record');
      const existing=commands.get(record.id);
      if(record.op==='start'){
        if(existing)throw error('duplicate_journal_start');
        commands.set(record.id,{fp:record.fp,status:'uncertain',startedAt:record.at,finished:false});
      }else{
        if(!existing||existing.fp!==record.fp||existing.finished===true||
          !OUTCOMES.has(record.status))throw error('invalid_journal_finish');
        commands.set(record.id,{...existing,status:record.status,finished:true});
      }
    }
  }catch(ex){
    await file?.close().catch(()=>{});
    if(locked){
      await lock?.close().catch(()=>{});
      await fs.unlink(lockPath).catch(()=>{});
    }
    throw ex;
  }
  async function append(entry){
    const line=JSON.stringify({v:1,...entry})+'\n';
    const next=writeTail.then(async()=>{
      if(closed)throw error('closed_ledger');
      const st=await file.stat();
      if(st.size+Buffer.byteLength(line)>MAX_BYTES)
        throw error('journal_capacity_exceeded');
      await file.writeFile(line,'utf8');
      await file.sync(); // Reservation is durable BEFORE caller dispatches.
    });
    writeTail=next.catch(()=>{});
    return next;
  }
  async function reserve(command){
    // Serialize the *lookup + durable start record + map insert* as a unit.
    // File append serialization alone does not prevent two racing calls from
    // both seeing a missing ID before either insert completes.
    const task=reservationTail.then(async()=>{
      const fp=fingerprint(command);
      const current=commands.get(command.commandId);
      if(current){
        return current.fp===fp?uncertain('duplicate_suppressed'):
          denied('reused_id_with_different_command');
      }
      if(commands.size>=maxCommands)return denied('ledger_capacity_exceeded');
      await append({op:'start',id:command.commandId,fp,at:now()});
      commands.set(command.commandId,{
        fp,status:'uncertain',startedAt:now(),finished:false
      });
      return null;
    });
    reservationTail=task.catch(()=>{});
    return task;
  }
  async function finish(command,status){
    const item=commands.get(command.commandId);
    if(!item||item.finished===true)return false;
    try{
      await append({op:'finish',id:command.commandId,fp:item.fp,
        at:now(),status});
      commands.set(command.commandId,{...item,status,finished:true});
      return true;
    }catch{return false;}
  }
  async function run(command,execute,{signal}={}){
    if(closed)return denied('closed_ledger');
    if(typeof execute!=='function')return denied('invalid_dispatch');
    let fp;
    try{fp=fingerprint(command);}catch{return denied('invalid_mutation');}
    if(command.expiresAt<=now())return denied('expired_command');
    if(signal?.aborted)return Object.freeze({status:'cancelled',code:'cancelled_before_reserve'});
    // Serialize per selected owner+tab+generation, independent of command UUID.
    const target=hash([command.binding.subject,command.binding.deviceKey,
      command.binding.connectionId]);
    if(activeTargets.has(target))return denied('target_busy');
    activeTargets.add(target);
    pending++;
    try{
      const reserved=await reserve(command);
      if(reserved)return reserved;
      if(signal?.aborted||command.expiresAt<=now()){
        await finish(command,'cancelled');
        return Object.freeze({status:'cancelled',code:'cancelled_after_reserve'});
      }
      let timer;
      const work=Promise.resolve().then(()=>execute(command,{signal}));
      const timed=new Promise(resolve=>{
        timer=setTimeout(()=>resolve(uncertain('deadline_uncertain')),
          Math.min(timeoutMs,Math.max(1,command.expiresAt-now())));
      });
      let response;
      try{response=await Promise.race([work,timed]);}
      catch{response=uncertain('dispatch_error_uncertain');}
      finally{clearTimeout(timer);}
      if(signal?.aborted)response=uncertain('cancelled_after_dispatch');
      const safeStatus=OUTCOMES.has(response?.status)?response.status:'uncertain';
      if(!await finish(command,safeStatus))
        return uncertain('journal_finalization_failed');
      return Object.freeze({
        status:safeStatus,
        ...(response?.code&&typeof response.code==='string'?
          {code:response.code.slice(0,100)}:{})
      });
    }catch{
      // If reservation write fails, execute was never called. If finalization
      // failed, never claim rollback or retry; err toward uncertain.
      return uncertain('journal_io_error');
    }finally{
      activeTargets.delete(target);
      pending--;
    }
  }
  async function close(){
    if(closed)return;
    if(pending)throw error('active_mutations');
    closed=true;
    await writeTail;
    const before=await lock.stat();
    await file.close();await lock.close();
    const current=await fs.lstat(lockPath);
    if(current.ino!==before.ino||current.dev!==before.dev)
      throw error('lock_owner_changed');
    await fs.unlink(lockPath);
  }
  return Object.freeze({
    run,close,get size(){return commands.size;},
    get pending(){return pending;},
    get status(){return closed?'closed':'open';}
  });
}
