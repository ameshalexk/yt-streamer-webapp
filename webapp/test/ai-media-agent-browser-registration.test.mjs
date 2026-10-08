import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {AuthenticatedBrowserRegistrationRegistry} from "../src/lib/ai-media-agent-browser-registration.js";

test("one-time authenticated browser registration binds origin, identity, device, connection and action",()=>{
  let now=1000;
  const reg=new AuthenticatedBrowserRegistrationRegistry({
    allowedOrigins:["https://player.example.test"],now:()=>now});
  const identity={issuer:"https://example.cloudflareaccess.com",subject:"owner-1"};
  const other={...identity,subject:"intruder"};
  const deviceId=randomUUID(),connectionId=randomUUID(),origin="https://player.example.test";
  const input={verifiedBrowserIdentity:identity,deviceId,connectionId,origin,
    actions:["get_player_state","pause"]};
  const {registration_nonce:nonce}=reg.issue(input);
  assert.equal(reg.redeem({...input,verifiedBrowserIdentity:other,registrationNonce:nonce}),null);
  assert.equal(reg.redeem({...input,connectionId:randomUUID(),registrationNonce:nonce}),null);
  assert.equal(reg.redeem({...input,deviceId:randomUUID(),registrationNonce:nonce}),null);
  assert.throws(()=>reg.redeem({...input,origin:"https://evil.test",registrationNonce:nonce}),/denied/);
  const grant=reg.redeem({...input,registrationNonce:nonce});
  assert.ok(grant.registration_id);
  assert.equal(reg.redeem({...input,registrationNonce:nonce}),null,"nonce is single-use");
  const authorize=extra=>reg.authorize({registrationId:grant.registration_id,
    verifiedBrowserIdentity:identity,deviceId,connectionId,action:"pause",...extra});
  assert.equal(authorize(),true);
  assert.equal(authorize({action:"play_media"}),false);
  assert.equal(authorize({verifiedBrowserIdentity:other}),false);
  assert.equal(authorize({connectionId:randomUUID()}),false);
  assert.equal(authorize({deviceId:randomUUID()}),false);
  assert.equal(reg.revoke({registrationId:grant.registration_id,verifiedBrowserIdentity:other}),false);
  assert.equal(reg.revoke({registrationId:grant.registration_id,verifiedBrowserIdentity:identity}),true);
  assert.equal(authorize(),false);
});
test("registration expires, disconnect revokes, and reconnect invalidates former registration",()=>{
  let now=1000;
  const reg=new AuthenticatedBrowserRegistrationRegistry({allowedOrigins:["http://127.0.0.1:18000"],now:()=>now});
  const verifiedBrowserIdentity={subject:"owner-1",issuer:"https://example.cloudflareaccess.com"};
  const deviceId=randomUUID(),connectionId=randomUUID(),origin="http://127.0.0.1:18000";
  const input={verifiedBrowserIdentity,deviceId,connectionId,origin,actions:["get_player_state"]};
  let nonce=reg.issue(input).registration_nonce;
  now+=60001;
  assert.equal(reg.redeem({...input,registrationNonce:nonce}),null,"stale registration nonce");
  nonce=reg.issue(input).registration_nonce;
  const first=reg.redeem({...input,registrationNonce:nonce});
  assert.ok(first);
  const connected={...input,connectionId:randomUUID()};
  const second=reg.redeem({...connected,registrationNonce:reg.issue(connected).registration_nonce});
  assert.ok(second);
  assert.equal(reg.authorize({registrationId:first.registration_id,
    verifiedBrowserIdentity,deviceId,connectionId,action:"get_player_state"}),false,"old connection revoked by re-pair");
  assert.equal(reg.authorize({registrationId:second.registration_id,
    verifiedBrowserIdentity,deviceId,connectionId:connected.connectionId,action:"get_player_state"}),true);
  reg.revokeConnection({deviceId,connectionId:connected.connectionId});
  assert.equal(reg.authorize({registrationId:second.registration_id,
    verifiedBrowserIdentity,deviceId,connectionId:connected.connectionId,action:"get_player_state"}),false);
  const newNonce=reg.issue(input).registration_nonce;
  const third=reg.redeem({...input,registrationNonce:newNonce});
  now+=600001;
  assert.equal(reg.authorize({registrationId:third.registration_id,
    verifiedBrowserIdentity,deviceId,connectionId,action:"get_player_state"}),false,"active registration expired");
});
test("registration rejects origin spoof, unknown action and unverified principal",()=>{
  const reg=new AuthenticatedBrowserRegistrationRegistry({allowedOrigins:["https://player.example.test"]});
  const valid={verifiedBrowserIdentity:{issuer:"https://example.cloudflareaccess.com",subject:"owner-1"},
    deviceId:randomUUID(),connectionId:randomUUID(),origin:"https://player.example.test",
    actions:["get_player_state"]};
  assert.throws(()=>reg.issue({...valid,origin:"https://evil.test"}),/denied/);
  assert.throws(()=>reg.issue({...valid,actions:["shell"]}),/actions/);
  assert.throws(()=>reg.issue({...valid,actions:["pause","pause"]}),/actions/);
  assert.throws(()=>reg.issue({...valid,verifiedBrowserIdentity:null}),/denied/);
  assert.throws(()=>new AuthenticatedBrowserRegistrationRegistry({allowedOrigins:["*"]}),/configuration/);
});
