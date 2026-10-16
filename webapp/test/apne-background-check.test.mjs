import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {nextApneCheckTime, createApneBackgroundCheck} from '../src/lib/apne-background-check.js';

const makeDir=()=>fs.mkdtemp(path.join(os.tmpdir(),'apne-background-test-'));
const silent=()=>{};

test('next scheduled APNE checks align to midnight, 6 AM, noon, and 6 PM in Mac local time',()=>{
 for (const [hour,minute,nextHour] of [[0,0,6],[2,21,6],[6,0,12],[11,59,12],[12,0,18],[17,54,18]]){
  const now=new Date(2026,9,14,hour,minute,0);
  const next=nextApneCheckTime(now);
  assert.equal(next.getHours(),nextHour);
  assert.equal(next.getMinutes(),0);
  assert.ok(next>now);
 }
 const next=nextApneCheckTime(new Date(2026,9,14,20,15));
 assert.equal(next.getHours(),0);assert.equal(next.getDate(),15);
});

test('service scheduler is one-process, non-overlapping, and schedules four daily wall-clock slots',async()=>{
 const dir=await makeDir(),timers=[],released=[];
 try{
  const clock=()=>new Date(2026,9,14,17,52);
  const setTimer=(fn,ms)=>{const token={fn,ms,unref(){}};timers.push(token);return token};
  const service=createApneBackgroundCheck({dataDir:dir,scan:async()=>({shows:{},checkedShows:5}),clock,setTimer,clearTimer:t=>released.push(t),log:silent});
  service.start();service.start();
  assert.equal(service.status().enabled,true);
  assert.equal(service.status().localHours.join(','),'0,6,12,18');
  assert.equal(new Date(service.status().nextAt).getHours(),18);
  assert.equal(timers.length,1); // startup catchup avoided near the 18:00 slot
  service.stop();assert.equal(released.length,1);assert.equal(service.status().enabled,false);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('background check persists latest dates and resumes existing state after restart',async()=>{
 const dir=await makeDir();const calls=[];
 try{
  const scan=async old=>{calls.push(old);return {shows:{anupamaa:{dateKey:'2026-10-14',source:'available'}},checkedShows:5,newEpisodes:1,validatedSources:2,errors:[]}};
  const service=createApneBackgroundCheck({dataDir:dir,scan,log:silent});
  const result=await service.run('test');
  assert.equal(result.checkedShows,5);assert.equal(result.newEpisodes,1);
  const stored=JSON.parse(await fs.readFile(path.join(dir,'apne-background-check-state.json')));
  assert.equal(stored.version,1);assert.equal(stored.trigger,'test');
  assert.equal(stored.shows.anupamaa.dateKey,'2026-10-14');
  assert.ok(stored.lastFinishedAt);
  const resumed=createApneBackgroundCheck({dataDir:dir,scan,log:silent});
  await resumed.run('scheduled');
  assert.equal(calls.length,2);assert.deepEqual(calls[1],stored.shows);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('source scan failure is recorded without disabling future scheduled attempts',async()=>{
 const dir=await makeDir();let count=0;
 try{
  const service=createApneBackgroundCheck({dataDir:dir,log:silent,scan:async()=>{count++;if(count===1)throw Error('temporary upstream error');return{shows:{seher:{dateKey:'2026-10-14',source:'saved'}},checkedShows:1,newEpisodes:1,validatedSources:0,errors:[]}}});
  const first=await service.run('test');assert.match(first.errors[0],/temporary upstream/);
  const second=await service.run('test');assert.equal(second.errors.length,0);assert.equal(count,2);
  assert.equal(service.status().lastSummary.checkedShows,1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('concurrent background checks share one scan and never start duplicate work',async()=>{
 const dir=await makeDir();let resolve=null,calls=0;
 try{
  const service=createApneBackgroundCheck({dataDir:dir,log:silent,scan:async()=>{calls++;await new Promise(r=>resolve=r);return{shows:{},checkedShows:5}}});
  const first=service.run('test');
  for(let i=0;i<40&&!resolve;i++)await new Promise(r=>setTimeout(r,3));
  assert.ok(resolve);
  const concurrent=await service.run('scheduled');assert.equal(concurrent.skipped,'already-running');
  resolve();await first;assert.equal(calls,1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
