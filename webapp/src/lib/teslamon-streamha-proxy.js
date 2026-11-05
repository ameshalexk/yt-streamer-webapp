// Authenticated StreamHA -> Mac Codex relay. The Pi never receives Codex
// credentials and never has permission to execute arbitrary commands.
// A Cloudflare-signed Access principal is verified on BOTH hosts; the only
// upstream is the pinned Mac streamer HTTPS origin (no redirects).
const ROUTES=new Set(['capabilities','url-route','url-video-plan','plan','ha-plan',
  'ha-confirm','mac-plan','mac-confirm','select-candidate','transcribe']);
const TYPES=new Set(['audio/webm','audio/ogg','audio/mp4','audio/wav']);
const MAX_AUDIO=5*1024*1024;
const MAX_OUTPUT=128*1024;
const UPSTREAM='https://stream.ameshalex.com';
const LOCAL_ORIGIN='https://streamha.ameshalex.com';
const fail=(res,status,code)=>res.status(status).json({status:'unavailable',code});

function accessJwt(req){
  // Reject malformed client JWTs instead of downgrading to another credential.
  const header=req.headers['cf-access-jwt-assertion'];
  if(header!==undefined){
    if(typeof header!=='string'||header.length>16000||
       !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header))return null;
    return header;
  }
  const raw=req.headers.cookie;
  if(typeof raw!=='string'||raw.length>20000)return null;
  const matches=raw.split(';').map(x=>x.trim()).filter(x=>x.startsWith('CF_Authorization='));
  if(matches.length!==1)return null;
  const jwt=matches[0].slice('CF_Authorization='.length);
  return jwt.length<=16000&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)?jwt:null;
}

export function createStreamhaCodexProxy({authenticate,request=fetch,upstream=UPSTREAM,
  origin=LOCAL_ORIGIN}={}){
  if(typeof authenticate!=='function'||typeof request!=='function'||
     upstream!==UPSTREAM||origin!==LOCAL_ORIGIN)
    throw Error('invalid_streamha_proxy_configuration');
  return async function streamhaCodexProxy(req,res,next){
    // Express mounts this below /api/teslamon only, before local planners.
    const route=req.path.replace(/^\//,'');
    if(req.method!=='POST'||!ROUTES.has(route))return next();
    res.set('Cache-Control','private, no-store');
    if(req.headers.origin!==origin||
       (req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))
      return res.status(403).json({status:'failed',code:'wrong_origin'});
    const jwt=accessJwt(req);
    if(!jwt)return res.status(401).json({status:'failed',code:'signed_access_required'});
    try{await authenticate(req)}
    catch{return res.status(401).json({status:'failed',code:'signed_access_required'});}
    let body,contentType;
    if(route==='transcribe'){
      contentType=String(req.headers['content-type']||'').toLowerCase().split(';')[0].trim();
      if(!TYPES.has(contentType)||!Buffer.isBuffer(req.body)||
         req.body.length===0||req.body.length>MAX_AUDIO)
        return res.status(400).json({status:'failed',code:'invalid_audio_request'});
      body=req.body;
    }else{
      contentType='application/json';
      if(String(req.headers['content-type']||'').split(';')[0].toLowerCase()!=='application/json'||
         !req.body||Object.getPrototypeOf(req.body)!==Object.prototype)
        return res.status(400).json({status:'failed',code:'invalid_request_body'});
      body=JSON.stringify(req.body);
      if(body.length>256*1024)return res.status(413).json({status:'failed',code:'body_too_large'});
    }
    try{
      // Do not trust inbound origin or arbitrary Host headers for outbound
      // routing. Access JWT is independently reverified by Mac's original
      // strict origin-bound endpoint. A request is never retried after POST.
      const upstreamResponse=await request(upstream+'/api/teslamon/'+route,{
        method:'POST',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(65000),
        headers:{'Origin':upstream,'Sec-Fetch-Site':'same-origin',
          'Content-Type':contentType,'Accept':'application/json',
          'Cookie':'CF_Authorization='+jwt,
          'Cf-Access-Jwt-Assertion':jwt},
        body
      });
      if(!upstreamResponse||![200,400,401,403,409,422,429,503].includes(upstreamResponse.status)||
         !String(upstreamResponse.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
        return fail(res,503,'codex_bridge_unavailable');
      const declared=Number(upstreamResponse.headers.get('content-length'));
      if(Number.isFinite(declared)&&declared>MAX_OUTPUT)
        return fail(res,503,'codex_bridge_unavailable');
      const text=await upstreamResponse.text();
      if(text.length>MAX_OUTPUT)return fail(res,503,'codex_bridge_unavailable');
      let value;try{value=JSON.parse(text)}catch{return fail(res,503,'codex_bridge_unavailable');}
      if(!value||typeof value!=='object'||Array.isArray(value))
        return fail(res,503,'codex_bridge_unavailable');
      return res.status(upstreamResponse.status).json(value);
    }catch{return fail(res,503,'codex_bridge_unavailable');}
  };
}
export const STREAMHA_CODEX_ROUTES=Object.freeze([...ROUTES]);
