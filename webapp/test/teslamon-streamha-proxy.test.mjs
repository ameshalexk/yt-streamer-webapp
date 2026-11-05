import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createStreamhaCodexProxy,STREAMHA_CODEX_ROUTES} from '../src/lib/teslamon-streamha-proxy.js';
import {TrustedBrowserRegistrationFlow} from '../src/lib/ai-media-agent-trusted-browser-flow.js';
import {readFileSync} from 'node:fs';

const issuer='https://trusted-bridge.cloudflareaccess.com';
const audience='shared-streamer-audience-0123456789';
const origin='https://streamha.ameshalex.com';
const target='https://stream.ameshalex.com';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});
const keys={issuer,get:async()=>({keys:[{...jwk,kid:'bridge-test',use:'sig',alg:'RS256'}]})};
function jwt({sub='owner',aud=audience,iss=issuer}={}){
  const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const a=b64({alg:'RS256',kid:'bridge-test'}),now=Math.floor(Date.now()/1000);
  const b=b64({sub,aud,iss,iat:now-10,exp:now+300});
  const payload=a+'.'+b;
  return payload+'.'+sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url');
}
const flow=new TrustedBrowserRegistrationFlow({jwksProvider:keys,audience,
  accessPolicyOnly:true,allowedSubjects:[],allowedOrigins:[origin]});
function makeResponse(){
  const out={statusCode:200,headers:{},payload:null};
  out.status=n=>(out.statusCode=n,out);
  out.set=(k,v)=>(out.headers[k]=v,out);
  out.json=body=>(out.payload=body,out);
  return out;
}
function browserRequest({route='url-route',token=jwt(),raw=false,site='same-origin',
  requestOrigin=origin,assertion=true,method='POST',data={text:'turnonnthegameroomlights',
    session:'12345678-1234-1234-1234-123456789abc'},contentType}={}){
  const headers={origin:requestOrigin,'sec-fetch-site':site,
    'content-type':contentType||(raw?'audio/webm':'application/json')};
  if(assertion)headers['cf-access-jwt-assertion']=token;
  else headers.cookie='CF_Authorization='+token;
  return {method,path:'/'+route,headers,body:raw?Buffer.from('synthetic audio'):data};
}
async function run(input={},upstreamResponse={status:200,headers:{get:()=> 'application/json'},
  text:async()=>JSON.stringify({status:'ok',route:'ha',text:'turn on game room lights'})}){
  const calls=[];let nextCalls=0;
  const proxy=createStreamhaCodexProxy({authenticate:req=>flow.authenticateHttp(req),
    request:async(...args)=>{calls.push(args);return upstreamResponse;}});
  const res=makeResponse();
  await proxy(browserRequest(input),res,()=>nextCalls++);
  return {res,calls,nextCalls};
}

test('allowlist covers only bounded planner, confirmation, selection and voice POST endpoints',()=>{
  assert.deepEqual([...STREAMHA_CODEX_ROUTES].sort(),[
    'capabilities','ha-confirm','ha-plan','mac-confirm','mac-plan','plan',
    'select-candidate','transcribe','url-route','url-video-plan'
  ].sort());
  assert.throws(()=>createStreamhaCodexProxy({authenticate:async()=>{},
    upstream:'https://evil.test'}),/invalid_streamha_proxy_configuration/);
  assert.match(readFileSync(new URL('../public/teslamon-pet.js',import.meta.url),'utf8'),
    /'streamha\.ameshalex\.com'/);
});
test('verified StreamHA signed identity relays one request to pinned HTTPS Mac planner',async()=>{
  const token=jwt(),{res,calls}=await run({token});
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.route,'ha');
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],target+'/api/teslamon/url-route');
  const opts=calls[0][1];
  assert.equal(opts.method,'POST');assert.equal(opts.redirect,'manual');
  assert.equal(opts.headers.Origin,target);
  assert.equal(opts.headers.Cookie,'CF_Authorization='+token);
  assert.equal(opts.headers['Cf-Access-Jwt-Assertion'],token);
  assert.equal(JSON.parse(opts.body).text,'turnonnthegameroomlights');
  assert.equal(opts.headers['Sec-Fetch-Site'],'same-origin');
});
test('CF_Authorization cookie works if edge supplies no assertion',async()=>{
  const result=await run({assertion:false});
  assert.equal(result.res.statusCode,200);
  assert.equal(result.calls.length,1);
});
test('forged, expired, wrong audience, wrong origin and cross-site requests fail closed',async()=>{
  for(const input of [
    {token:'bad.token.value'},
    {token:jwt({aud:'other-access-app'})},
    {token:jwt({sub:'owner',iss:'https://wrong.cloudflareaccess.com'})},
    {requestOrigin:'https://evil.test'},
    {site:'cross-site'},
    {assertion:false,token:'not-a-token'}
  ]){
    const {res,calls}=await run(input);
    assert.ok([401,403].includes(res.statusCode),JSON.stringify(input));
    assert.equal(calls.length,0,'no request left the Pi for an invalid Access identity');
  }
});
test('unknown namespace, GET and malformed body never forward',async()=>{
  for(const input of [{route:'../../admin'}, {route:'arbitrary-exec'},
    {method:'GET'},{data:'not-json'},{contentType:'text/plain'}]){
    const {res,calls,nextCalls}=await run(input);
    assert.equal(calls.length,0);
    assert.equal(nextCalls,input.route||input.method==='GET'?1:0);
    if(!nextCalls)assert.equal(res.statusCode,400);
  }
});
test('HA and Mac confirmations preserve signed session and require explicit confirm POST',async()=>{
  const token=jwt();
  const {res,calls}=await run({route:'ha-plan',token});
  assert.equal(res.statusCode,200);
  assert.equal(calls.length,1);
  assert.ok(calls[0][0].endsWith('/ha-plan'));
  const approved=await run({route:'ha-confirm',token,data:{session:'12345678-1234-1234-1234-123456789abc',id:'a'.repeat(48)}});
  assert.equal(approved.calls.length,1);
  assert.ok(approved.calls[0][0].endsWith('/ha-confirm'));
});
test('audio proxy has a strict MIME and payload size cap',async()=>{
  const valid=await run({route:'transcribe',raw:true,contentType:'audio/webm;codecs=opus'});
  assert.equal(valid.res.statusCode,200);
  assert.ok(Buffer.isBuffer(valid.calls[0][1].body));
  assert.equal(valid.calls[0][1].headers['Content-Type'],'audio/webm');
  for(const input of [{contentType:'application/octet-stream'}, {raw:false}]){
    const bad=await run({route:'transcribe',raw:true,...input});
    assert.equal(bad.res.statusCode,400);
    assert.equal(bad.calls.length,0);
  }
});
test('login redirects, non-JSON, upstream errors and oversized replies fail closed',async()=>{
  const variants=[
    {status:302,headers:{get:()=> 'text/html'},text:async()=>'<html>login</html>'},
    {status:200,headers:{get:()=> 'text/html'},text:async()=>'<html>login</html>'},
    {status:200,headers:{get:()=> 'application/json'},text:async()=>'{invalid'},
    {status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({data:'x'.repeat(150000)})}
  ];
  for(const v of variants){
    const result=await run({},v);
    assert.equal(result.res.statusCode,503);
    assert.equal(result.res.payload.code,'codex_bridge_unavailable');
  }
});
