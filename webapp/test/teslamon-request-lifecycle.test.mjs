import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createTeslaMonRequestLifecycle} from '../src/lib/teslamon-request-lifecycle.js';

function setup(options){const req=new EventEmitter(),res=new EventEmitter();
 return {req,res,request:createTeslaMonRequestLifecycle(req,res,options)};}
test('body completion does not cancel processing but abandoned response does',()=>{
 const {req,res,request}=setup();
 req.emit('close');assert.equal(request.signal.aborted,false);
 res.emit('close');assert.equal(request.signal.aborted,true);request.dispose();
 assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('successful response close does not abort and disposal removes handlers',()=>{
 const {req,res,request}=setup();res.writableEnded=true;res.emit('close');
 assert.equal(request.signal.aborted,false);request.dispose();req.emit('aborted');
 assert.equal(request.signal.aborted,false);
});
test('aborted incoming request and bounded deadline stop pending work',async()=>{
 const first=setup();first.req.emit('aborted');assert.equal(first.request.signal.aborted,true);first.request.dispose();
 const next=setup({timeoutMs:5});
 await new Promise(r=>setTimeout(r,15));assert.equal(next.request.signal.aborted,true);next.request.dispose();
});
