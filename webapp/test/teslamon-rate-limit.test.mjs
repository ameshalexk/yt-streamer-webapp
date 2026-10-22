import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonRateLimit} from '../src/lib/teslamon-rate-limit.js';
test('authenticated controller budgets are independent and refill without polling',()=>{
 let now=0;const limit=createTeslaMonRateLimit({now:()=>now,capacity:2,refillMs:1000});
 assert.equal(limit.consume('A'),true);assert.equal(limit.consume('A'),true);
 assert.equal(limit.consume('A'),false);assert.equal(limit.consume('B'),true);
 now=1000;assert.equal(limit.consume('A'),true);assert.equal(limit.consume('A'),false);
});
test('controller memory is bounded and idle entries expire',()=>{
 let now=0;const limit=createTeslaMonRateLimit({now:()=>now,capacity:2,refillMs:1000,maxControllers:1});
 assert.equal(limit.consume('A'),true);assert.equal(limit.consume('B'),false);
 now=2000;assert.equal(limit.consume('B'),true);assert.equal(limit.consume(''),false);
});
