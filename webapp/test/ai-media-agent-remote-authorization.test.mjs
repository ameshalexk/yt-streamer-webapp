import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {verifyAccessJwt,BrowserApprovalRegistry} from "../src/lib/ai-media-agent-remote-authorization.js";
const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const {n,e}=publicKey.export({format:"jwk"});
const jwks={keys:[{kid:"key-1",kty:"RSA",use:"sig",alg:"RS256",n,e}]};
const now=1791490000,issuer="https://example.cloudflareaccess.com",audience="test-aud";
const makeJwt=(claims={},header={})=>{
  const h=Buffer.from(JSON.stringify({alg:"RS256",kid:"key-1",typ:"JWT",...header})).toString("base64url");
  const p=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:"owner-1",iat:now-10,exp:now+300,...claims})).toString("base64url");
  return h+"."+p+"."+sign("RSA-SHA256",Buffer.from(h+"."+p),privateKey).toString("base64url");
};
const opts={jwks,issuer,audience,nowSeconds:now};
test("verified RS256 token provides only bounded provider identity",()=>{
 const identity=verifyAccessJwt(makeJwt(),opts);
 assert.deepEqual(identity,{subject:"owner-1",issuer,audience});
 assert.equal(Object.hasOwn(identity,"email"),false);
});
test("rejects forgery, wrong issuer/audience, expiry, future or none algorithm",()=>{
 const good=makeJwt();
 const forged=good.slice(0,-3)+"abc";
 for(const token of [forged,makeJwt({iss:"https://evil.invalid"}),makeJwt({aud:"wrong"}),
   makeJwt({exp:now}),makeJwt({iat:now+120}),makeJwt({sub:""}),makeJwt({}, {alg:"none"}),
   "a.b.c","",makeJwt({exp:now+90000})]){
   assert.throws(()=>verifyAccessJwt(token,opts),/unauthorized/);
 }
 assert.throws(()=>verifyAccessJwt(good,{...opts,jwks:{keys:[]}}),/unauthorized/);
});
test("approvals scoped to verified principal, exact browser connection, action, expiry",()=>{
 let clock=1000;
 const registry=new BrowserApprovalRegistry({now:()=>clock});
 const one=verifyAccessJwt(makeJwt(),opts),other={...one,subject:"other-user"};
 const grant=registry.approve({identity:one,deviceId:"device-1",connectionId:"session-1",actions:["pause","seek"],ttlMs:1500});
 const request={identity:one,approvalId:grant.approval_id,deviceId:"device-1",connectionId:"session-1",action:"pause"};
 assert.equal(registry.authorize(request),true);
 assert.equal(registry.authorize({...request,identity:other}),false);
 assert.equal(registry.authorize({...request,deviceId:"device-2"}),false);
 assert.equal(registry.authorize({...request,connectionId:"session-2"}),false);
 assert.equal(registry.authorize({...request,action:"play_media"}),false);
 clock+=1500;
 assert.equal(registry.authorize(request),false);
});
test("disconnect and explicit revoke invalidate even a previously authorized action",()=>{
 const registry=new BrowserApprovalRegistry();
 const identity=verifyAccessJwt(makeJwt(),opts);
 const newGrant=()=>registry.approve({identity,deviceId:"device-1",connectionId:"session-1",actions:["play_media"]});
 const one=newGrant();registry.revoke(one.approval_id);
 assert.equal(registry.authorize({identity,approvalId:one.approval_id,deviceId:"device-1",connectionId:"session-1",action:"play_media"}),false);
 const two=newGrant();registry.revokeConnection("device-1","session-1");
 assert.equal(registry.authorize({identity,approvalId:two.approval_id,deviceId:"device-1",connectionId:"session-1",action:"play_media"}),false);
 assert.throws(()=>registry.approve({identity,deviceId:"device-1",connectionId:"session-1",actions:["shell"],ttlMs:1000}),/unauthorized/);
});
