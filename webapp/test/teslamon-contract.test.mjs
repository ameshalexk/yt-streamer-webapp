import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TESLAMON_TOOLS, validateTeslaMonIntent, bindTeslaMonCommand,
  validateTeslaMonObservation
} from '../src/lib/teslamon-contract.js';

const NOW = 1792670000000;
const deviceKey = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const authority = Object.freeze({
  origin: 'https://stream.ameshalex.com',
  subject: 'verified-subject',
  controllerId: 'authenticated-controller',
  deviceKey, connectionId,
  explicitSelection: true,
  tabConsent: true,
  authExpiresAt: NOW + 120000
});
const intent = name => validateTeslaMonIntent({tool: name, args: {}});
const bound = (name = 'pause', a = authority) =>
  bindTeslaMonCommand(intent(name), a, {commandId, now: NOW});
const observed = (command = bound()) => ({
  status: 'observed', commandId: command.commandId,
  subject: command.binding.subject, deviceKey: command.binding.deviceKey,
  connectionId: command.binding.connectionId,
  observedAt: NOW + 2000,
  playbackPhase: 'paused', fullscreenMode: 'none'
});

test('exactly six narrow playback tools, no shell/filesystem/device tools', () => {
  assert.deepEqual(TESLAMON_TOOLS, [
    'search_and_play','pause','resume','get_playback_state','request_fullscreen','exit_fullscreen'
  ]);
  for (const tool of TESLAMON_TOOLS.slice(1)) assert.equal(intent(tool).ok, true);
  for (const tool of ['shell', 'mac_control', 'tesla_unlock', 'file_write', 'seek', 'stop'])
    assert.equal(validateTeslaMonIntent({tool, args: {}}).ok, false);
});

test('search query canonicalizes without accepting an arbitrary URL or target', () => {
  assert.deepEqual(validateTeslaMonIntent({tool: 'search_and_play',
    args: {query: '  movie trailer  '}}).args, {query: 'movie trailer'});
  for (const args of [
    {}, {query: 'a'}, {query: 'x'.repeat(161)},
    {query: 'hello\nworld'}, {query: 'video', target: deviceKey},
    {query: 'video', candidate_token: 'A'.repeat(32)},
    {candidate_token: 'https://youtube.com/watch?v=abc'},
    {media_url: 'https://example.com'}
  ]) assert.equal(validateTeslaMonIntent({tool: 'search_and_play', args}).ok, false);
  assert.equal(validateTeslaMonIntent({tool: 'search_and_play',
    args: {candidate_token: 'A'.repeat(32)}}).ok, true);
});

test('non-search tools reject model-supplied owner, device or fullscreen flags', () => {
  for (const tool of TESLAMON_TOOLS.slice(1))
    for (const args of [{target: deviceKey}, {subject: authority.subject}, {force: true}])
      assert.equal(validateTeslaMonIntent({tool,args}).ok, false);
  assert.equal(validateTeslaMonIntent({tool:'pause',args:{},device_key:deviceKey}).ok, false);
});

test('binding cannot bypass intent validation with a forged ok flag', () => {
  const forged = {ok:true,tool:'pause',args:{target:deviceKey}};
  assert.equal(bindTeslaMonCommand(forged,authority,{commandId,now:NOW}).ok,false);
  const extra={ok:true,tool:'shell',args:{}};
  assert.equal(bindTeslaMonCommand(extra,authority,{commandId,now:NOW}).ok,false);
});

test('explicit same-origin authenticated selected tab is mandatory', () => {
  assert.equal(bound().ok, true);
  for (const change of [
    {origin: 'https://streamha.ameshalex.com'},
    {origin: 'http://127.0.0.1:3000'},
    {explicitSelection: false}, {tabConsent: false},
    {authExpiresAt: NOW}, {authExpiresAt: NOW - 1},
    {deviceKey: ''}, {deviceKey: 'other'}, {connectionId: ''},
    {subject: ''}, {controllerId: ''}
  ]) assert.equal(bound('pause', {...authority, ...change}).ok, false,
    JSON.stringify(change));
});

test('commands are immutable and deadline is capped to auth expiry', () => {
  const c = bindTeslaMonCommand(intent('resume'),
    {...authority, authExpiresAt: NOW + 5000}, {commandId, now: NOW});
  assert.equal(c.expiresAt, NOW + 5000);
  assert.equal(Object.isFrozen(c), true);
  assert.equal(Object.isFrozen(c.binding), true);
  assert.throws(() => { c.binding.deviceKey = 'evil'; }, TypeError);
  for (const opts of [
    {commandId: 'fake',now:NOW},
    {commandId,now:NOW,deadlineMs:40000},
    {commandId,now:NOW,deadlineMs:0}
  ]) assert.equal(bindTeslaMonCommand(intent('pause'),authority,opts).ok,false);
});

test('not observed means acknowledgement cannot be reported as playback truth', () => {
  const c = bound();
  for (const status of ['received', 'accepted', 'uncertain', 'offline',
    'cancelled', 'needs_user_gesture', 'unsupported', 'failed']) {
    const result = validateTeslaMonObservation({...observed(c),status}, c, NOW + 3000);
    assert.deepEqual({ok:result.ok,observed:result.observed},{ok:true,observed:false});
  }
});

test('readback requires same bound command, subject, target and connection generation', () => {
  const c = bound();
  assert.equal(validateTeslaMonObservation(observed(c),c,NOW+3000).observed,true);
  for (const change of [
    {commandId:'44444444-4444-4444-8444-444444444444'},
    {subject:'another-user'}, {deviceKey:'44444444-4444-4444-8444-444444444444'},
    {connectionId:'44444444-4444-4444-8444-444444444444'}
  ]) assert.equal(validateTeslaMonObservation({...observed(c),...change},c,NOW+3000).ok,false);
});

test('stale, future, pre-dispatch and invalid player readback is denied', () => {
  const c = bound();
  const base = observed(c);
  for (const change of [
    {observedAt:NOW - 1}, {observedAt:NOW + 20000},
    {observedAt:NOW + 1000}, {observedAt:null},
    {playbackPhase:'audibly_playing'}, {fullscreenMode:'really_fullscreen'},
    {status:'success'}
  ]) {
    const later = change.observedAt === NOW + 1000 ? NOW + 12000 : NOW + 3000;
    assert.equal(validateTeslaMonObservation({...base,...change},c,later).ok,false);
  }
});
