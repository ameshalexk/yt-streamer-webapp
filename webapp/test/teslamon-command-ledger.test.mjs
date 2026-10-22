import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {openTeslaMonCommandLedger} from '../src/lib/teslamon-command-ledger.js';

const binding=()=>({
  subject:'signed-owner',controllerId:'authorized-controller',
  origin:'https://stream.ameshalex.com',
  deviceKey:'11111111-1111-4111-8111-111111111111',
  connectionId:'22222222-2222-4222-8222-222222222222'
});
const command=(patch={})=>({
  commandId:randomUUID(),action:'resume',args:{},binding:binding(),
  expiresAt:Date.now()+25000,...patch
});
async function withLedger(fn,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-ledger-test-'));
  let ledger;
  try{
    ledger=await openTeslaMonCommandLedger({dir,timeoutMs:60,...options});
    return await fn(ledger,dir);
  }finally{
    if(ledger&&ledger.pending===0&&ledger.status==='open')
      await ledger.close().catch(()=>{});
    await fs.rm(dir,{recursive:true,force:true});
  }
}

test('reserve persists before dispatch, stores no titles or raw target identity',async()=>{
  await withLedger(async(ledger,dir)=>{
    const c=command({action:'play_media',args:{media_id:'AAAaa00000_'}});
    let seen='';
    const out=await ledger.run(c,async()=>{
      seen=await fs.readFile(path.join(dir,'teslamon-commands.jsonl'),'utf8');
      assert.ok(seen.includes('"op":"start"'));
      assert.equal(seen.includes('signed-owner'),false);
      assert.equal(seen.includes('AAAaa00000_'),false);
      assert.equal(seen.includes('authorized-controller'),false);
      return {status:'accepted'};
    });
    assert.equal(out.status,'accepted');
    assert.equal(ledger.size,1);
    const saved=await fs.readFile(path.join(dir,'teslamon-commands.jsonl'),'utf8');
    assert.ok(saved.includes('"op":"finish"'));
  });
});

test('same ID suppressed after normal completion, including restart',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-ledger-restart-'));
  const c=command();
  let effects=0;
  try{
    let first=await openTeslaMonCommandLedger({dir});
    assert.equal((await first.run(c,async()=>{
      effects++;return {status:'observed'};
    })).status,'observed');
    await first.close();
    let next=await openTeslaMonCommandLedger({dir});
    const again=await next.run(c,async()=>{effects++;return {status:'observed'};});
    assert.equal(again.status,'uncertain');
    assert.equal(again.code,'duplicate_suppressed');
    assert.equal(effects,1);
    await next.close();
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('same UUID different arguments/target blocked rather than treated as replay',async()=>{
  await withLedger(async ledger=>{
    const c=command();
    assert.equal((await ledger.run(c,async()=>({status:'accepted'}))).status,'accepted');
    const tampered={...c,action:'pause'};
    const replay=await ledger.run(tampered,async()=>{throw Error('must not run');});
    assert.equal(replay.code,'reused_id_with_different_command');
  });
});

test('duplicate UUID raced across different tabs executes only once',async()=>{
  await withLedger(async ledger=>{
    const c=command();
    const other={...c,binding:{...c.binding,
      deviceKey:'99999999-9999-4999-8999-999999999999',
      connectionId:'88888888-8888-4888-8888-888888888888'
    }};
    let sends=0;
    const run=x=>ledger.run(x,async()=>{sends++;return {status:'accepted'};});
    const result=await Promise.all([run(c),run(other)]);
    assert.equal(sends,1);
    assert.ok(result.some(x=>x.code==='reused_id_with_different_command'));
  });
});

test('simultaneous same-tab commands do not overlap sends',async()=>{
  await withLedger(async ledger=>{
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    let sends=0;
    const first=ledger.run(command(),async()=>{
      sends++;await gate;return {status:'accepted'};
    });
    await new Promise(resolve=>setImmediate(resolve));
    const second=await ledger.run(command(),async()=>{
      sends++;return {status:'accepted'};
    });
    assert.equal(second.code,'target_busy');
    release();
    assert.equal((await first).status,'accepted');
    assert.equal(sends,1);
  });
});

test('timeout is uncertain, no automatic resend, after-return execute may still finish',async()=>{
  await withLedger(async ledger=>{
    const c=command();
    let sends=0;
    const answer=await ledger.run(c,async()=>{
      sends++;await new Promise(r=>setTimeout(r,120));
      return {status:'observed'};
    });
    assert.equal(answer.status,'uncertain');
    assert.equal(answer.code,'deadline_uncertain');
    const repeat=await ledger.run(c,async()=>{sends++;return {status:'observed'};});
    assert.equal(repeat.code,'duplicate_suppressed');
    assert.equal(sends,1);
  });
});

test('cancellation before reservation executes nothing',async()=>{
  await withLedger(async ledger=>{
    const ctrl=new AbortController();ctrl.abort();
    let sends=0;
    const outcome=await ledger.run(command(),async()=>{sends++;},
      {signal:ctrl.signal});
    assert.equal(outcome.status,'cancelled');
    assert.equal(sends,0);
    assert.equal(ledger.size,0);
  });
});

test('cancellation after dispatch is uncertain, not proof of rollback',async()=>{
  await withLedger(async ledger=>{
    const c=command();
    const controller=new AbortController();
    const response=await ledger.run(c,async()=>{
      controller.abort();return {status:'observed'};
    },{signal:controller.signal});
    assert.equal(response.status,'uncertain');
    assert.equal(response.code,'cancelled_after_dispatch');
    assert.equal(ledger.size,1);
  });
});

test('expired command cannot dispatch, even when ID is valid',async()=>{
  await withLedger(async ledger=>{
    const c=command({expiresAt:Date.now()-50});
    let calls=0;
    const result=await ledger.run(c,async()=>{calls++;return {status:'observed'};});
    assert.equal(result.code,'expired_command');
    assert.equal(calls,0);
  });
});

test('single-owner lock forbids simultaneous ledger processes',async()=>{
  await withLedger(async(ledger,dir)=>{
    await assert.rejects(
      openTeslaMonCommandLedger({dir}),
      err=>err.code==='EEXIST'
    );
    assert.equal(ledger.status,'open');
    assert.equal(ledger.size,0);
  });
});

test('stale lock after crash requires explicit recovery, never blindly unlinks',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-stale-lock-'));
  try{
    const p=path.join(dir,'teslamon-commands.lock');
    await fs.writeFile(p,'stale',{mode:0o600});
    await assert.rejects(openTeslaMonCommandLedger({dir}),x=>x.code==='EEXIST');
    assert.equal(await fs.readFile(p,'utf8'),'stale');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('partial/corrupt journal fails closed without attempting replay',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-corrupt-'));
  try{
    const file=path.join(dir,'teslamon-commands.jsonl');
    await fs.writeFile(file,'{"unfinished":true',{mode:0o600});
    await assert.rejects(openTeslaMonCommandLedger({dir}),x=>x.code==='partial_or_oversize_journal');
    await assert.rejects(fs.stat(path.join(dir,'teslamon-commands.lock')),
      x=>x.code==='ENOENT');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('untrusted world-readable journal is refused',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-open-ledger-'));
  try{
    const file=path.join(dir,'teslamon-commands.jsonl');
    await fs.writeFile(file,'',{mode:0o644});
    await assert.rejects(openTeslaMonCommandLedger({dir}),x=>x.code==='unsafe_journal');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('capacity reached fails closed rather than dropping older command IDs',async()=>{
  await withLedger(async ledger=>{
    const one=await ledger.run(command(),async()=>({status:'accepted'}));
    assert.equal(one.status,'accepted');
    const second=await ledger.run(command(),async()=>({status:'observed'}));
    assert.equal(second.code,'ledger_capacity_exceeded');
  },{maxCommands:1});
});

test('refuses closing while dispatch is in flight',async()=>{
  await withLedger(async ledger=>{
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const pending=ledger.run(command(),async()=>{await gate;return {status:'accepted'};});
    await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(ledger.close(),x=>x.code==='active_mutations');
    release();
    assert.equal((await pending).status,'accepted');
    await ledger.close();
    assert.equal(ledger.status,'closed');
  });
});

test('uncertain timeout quarantines subsequent new mutations until reconciliation',async()=>{
  await withLedger(async ledger=>{
    const first=await ledger.run(command(),async()=>new Promise(()=>{}));
    assert.equal(first.status,'uncertain');
    assert.equal(ledger.quarantined,true);
    let executed=0;
    const second=await ledger.run(command(),async()=>{executed++;return {status:'observed'};});
    assert.equal(second.code,'unreconciled_prior_mutation');
    assert.equal(executed,0);
  });
});

test('reopening a journal with uncertain final outcome stays quarantined',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-uncertain-reopen-'));
  try{
    const ledger=await openTeslaMonCommandLedger({dir,timeoutMs:50});
    const c=command();
    const answer=await ledger.run(c,async()=>new Promise(()=>{}));
    assert.equal(answer.status,'uncertain');
    await ledger.close();
    const again=await openTeslaMonCommandLedger({dir,timeoutMs:50});
    assert.equal(again.quarantined,true);
    let effects=0;
    const blocked=await again.run(command(),async()=>{effects++;return {status:'observed'};});
    assert.equal(blocked.code,'unreconciled_prior_mutation');
    assert.equal(effects,0);
    assert.equal((await again.run(c,async()=>{effects++;})).code,'duplicate_suppressed');
    await again.close();
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
