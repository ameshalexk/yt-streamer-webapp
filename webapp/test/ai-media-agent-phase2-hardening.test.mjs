import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {TrustedBrowserRegistrationFlow} from '../src/lib/ai-media-agent-trusted-browser-flow.js';
import {BrowserApprovalRegistry} from '../src/lib/ai-media-agent-remote-authorization.js';
import {AuthenticatedBrowserRegistrationRegistry} from '../src/lib/ai-media-agent-browser-registration.js';
import {validateMediaCommand} from '../src/lib/ai-media-agent-session-registry.js';
import {devMcpTools} from '../scripts/ai-agent-dev-mcp.mjs';
import {startLocalRemoteMcpGateway} from '../scripts/ai-agent-remote-mcp.mjs';

const issuer='https://phase2-test.cloudflareaccess.com';
const audience='yt-streamer-phase2-test';
const origin='https://streamer.example.test';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const publicJwk=publicKey.export({format:'jwk'});
const trustedKey={...publicJwk,kid:'trusted-2026',alg:'RS256',use:'sig'};
const staleKey={...publicJwk,kid:'previous-2026',alg:'RS256',use:'sig'};
const nowSec=2000000000;
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function token({kid='trusted-2026',aud=audience,exp=nowSec+300,sub='owner'}={}){
  const header=encode({alg:'RS256',kid});
  const body=encode({iss:issuer,aud,sub,iat:nowSec-10,exp});
  return header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),privateKey).toString('base64url');
}
const upgrade=jwt=>({headers:{
  origin,connection:'Upgrade',upgrade:'websocket',
  'cf-access-jwt-assertion':jwt
}});

test('browser JWT verifier refreshes pinned JWKS exactly once on unknown kid', async()=>{
  let refreshes=0;
  const source={issuer,get:async()=>({keys:[staleKey]}),
    refresh:async()=>{refreshes++;return {keys:[trustedKey]};}};
  const flow=new TrustedBrowserRegistrationFlow({
    jwksProvider:source,audience,allowedSubjects:['owner'],allowedOrigins:[origin],
    now:()=>nowSec*1000
  });
  const accepted=await flow.connect(upgrade(token()));
  assert.ok(accepted.device_id);
  assert.equal(refreshes,1);
  const registration=flow.issue(accepted.handle,['get_player_state','stop']);
  const grant=flow.redeem(accepted.handle,registration.registration_nonce);
  assert.equal(flow.authorize(accepted.handle,grant.registration_id,'stop'),true);
  flow.disconnect(accepted.handle);
  await assert.rejects(flow.connect(upgrade(token({kid:'unknown-again'}))),/trusted_browser_denied/);
  assert.equal(refreshes,1,'unknown-kid flood must not repeatedly fetch pinned keys');
});

test('browser JWT verifier does not refetch for invalid signature with known signing kid',async()=>{
  let refreshes=0;
  const flow=new TrustedBrowserRegistrationFlow({
    jwksProvider:{issuer,get:async()=>({keys:[trustedKey]}),
      refresh:async()=>{refreshes++;return {keys:[trustedKey]};}},
    audience,allowedSubjects:['owner'],allowedOrigins:[origin],
    now:()=>nowSec*1000
  });
  const original=token();
  const [header,claims]=original.split('.');
  const {privateKey:otherPrivate}=generateKeyPairSync('rsa',{modulusLength:2048});
  const forged=header+'.'+claims+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+claims),otherPrivate).toString('base64url');
  await assert.rejects(flow.connect(upgrade(forged)),/trusted_browser_denied/);
  assert.equal(refreshes,0);
});

test('stop is a bounded allowlisted action throughout gateway/relay/browser approvals',()=>{
  assert.deepEqual(validateMediaCommand('stop',{}),{});
  assert.throws(()=>validateMediaCommand('stop',{arbitrary_command:'not_allowed'}),/unknown_argument/);
  assert.ok(devMcpTools.some(t=>t.name==='stop'&&t.inputSchema.required.includes('device_id')));
  const approvals=new BrowserApprovalRegistry();
  const identity={issuer,subject:'owner'};
  const approved=approvals.approve({identity,deviceId:'device-1',connectionId:'session-1',actions:['stop']});
  assert.equal(approvals.authorize({identity,approvalId:approved.approval_id,deviceId:'device-1',connectionId:'session-1',action:'stop'}),true);
  assert.equal(approvals.authorize({identity,approvalId:approved.approval_id,deviceId:'device-1',connectionId:'session-1',action:'play_media'}),false);
  const registry=new AuthenticatedBrowserRegistrationRegistry({allowedOrigins:[origin]});
  const input={verifiedBrowserIdentity:identity,deviceId:randomUUID(),connectionId:randomUUID(),origin,actions:['stop']};
  const one=registry.issue(input);
  const grant=registry.redeem({...input,registrationNonce:one.registration_nonce});
  assert.equal(registry.authorize({registrationId:grant.registration_id,verifiedBrowserIdentity:identity,deviceId:input.deviceId,connectionId:input.connectionId,action:'stop'}),true);
});

test('remote MCP listener refuses public bind before opening any server',async()=>{
  const fakeRelay={registry:{},approvals:{},remoteHooks:{}};
  await assert.rejects(startLocalRemoteMcpGateway({
    relay:fakeRelay,audience,allowedSubjects:['owner'],
    jwksProvider:{issuer,get:async()=>({keys:[trustedKey]})},
    host:'0.0.0.0',
  }),/invalid_remote_mcp_configuration/);
});

test('approval registry bounds active grants and frees capacity after expiry',()=>{
  let t=1000;
  const approvals=new BrowserApprovalRegistry({now:()=>t,maxTtlMs:3000});
  const identity={issuer,subject:'owner'};
  for(let i=0;i<128;i++){
    approvals.approve({identity,deviceId:'d',connectionId:'c',actions:['pause'],ttlMs:1000});
  }
  assert.throws(()=>approvals.approve({
    identity,deviceId:'d',connectionId:'c',actions:['pause'],ttlMs:1000
  }),/unauthorized/);
  t+=1001;
  assert.ok(approvals.approve({
    identity,deviceId:'d',connectionId:'c',actions:['pause'],ttlMs:1000
  }).approval_id);
});
