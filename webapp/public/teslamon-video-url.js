// Explicit URL navigation to an unknown path is a playback-only command.
// Real application, API and static asset routes must never turn into commands.
const RESERVED=new Set([
  'api','stream','vendor','apne','cast','internal','retro-pc','retrotv',
  'games','money','assets','public','index.html','robots.txt','favicon.ico'
]);
export function parseTeslaMonVideoUrl(pathname){
  if(typeof pathname!=='string'||pathname.length<2||pathname.length>700)return null;
  const parts=pathname.replace(/^\/+/, '').split('/');
  if(!parts.length||parts.some(part=>!part))return null;
  let decoded;
  try{decoded=parts.map(part=>decodeURIComponent(part)).join(' ').trim();}
  catch{return null;}
  const first=parts[0].toLowerCase();
  if(RESERVED.has(first)||first.startsWith('.')||first.startsWith('_')||
     first.includes('.')||parts.some(part=>/\.(?:[a-z0-9]{1,8})$/i.test(part)))return null;
  if(decoded.length<3||decoded.length>220||/[\x00-\x1f\x7f]/.test(decoded))return null;
  if(/[?#\\]/.test(decoded))return null;
  return decoded;
}
