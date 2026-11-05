// Explicit URL navigation to an unknown path is a playback-only command.
// Real application, API and static asset routes must never turn into commands.
const RESERVED=new Set([
  'api','stream','vendor','apne','cast','internal','retro-pc','retrotv',
  'games','money','assets','public','index.html','robots.txt','favicon.ico',
  // Existing routes, UI aliases, and static directories also take precedence.
  'retro','tesla','experimental','icons','teslamon-wake-assets',
  'download','episodes','check-source','mark-watched','ha'
]);
// URL paths arrive with different escaping depending on Grok/Tesla/browser:
// %20, +, raw Unicode, percent-encoded Unicode and occasionally nested %25.
// Decode at most twice and always validate the CANONICAL route before dispatch.
function decodeCommandSegment(segment){
  let value=segment.replace(/\+/g,'%20');
  for(let pass=0;pass<2;pass++){
    // A spoken/literal percent sign must not invalidate the whole request.
    const safe=value.replace(/%(?![0-9a-f]{2})/gi,'%25');
    const decoded=decodeURIComponent(safe);
    if(decoded===value)break;
    value=decoded;
  }
  return value.normalize('NFC');
}
export function parseTeslaMonVideoUrl(pathname){
  if(typeof pathname!=='string'||pathname.length<2||pathname.length>700)return null;
  const parts=pathname.replace(/^\/+/, '').split('/');
  if(!parts.length||parts.some(part=>!part))return null;
  let decodedParts;
  try{decodedParts=parts.map(decodeCommandSegment);}
  catch{return null;} // broken UTF-8 is not a command
  const first=decodedParts[0].normalize('NFKC').toLowerCase();
  // Include encoded aliases in the reserved-route check. /%72etro and
  // /%2561pi must never evade protection by using encoded path characters.
  if(RESERVED.has(first)||first.startsWith('.')||first.startsWith('_')||
     first.startsWith('%')||first.includes('.')||
     decodedParts.some(part=>/[\/\\]/.test(part)||/\.(?:[a-z0-9]{1,8})$/i.test(part)))return null;
  const decoded=decodedParts.join(' ').trim();
  if(decoded.length<3||decoded.length>220||/[\x00-\x1f\x7f]/.test(decoded))return null;
  if(/[?#\\]/.test(decoded))return null;
  return decoded;
}
