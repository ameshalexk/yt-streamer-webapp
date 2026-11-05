// Explicit /ha/ or /mac/<spoken command>. Never interpret arbitrary site paths as
// device requests; existing unprefixed paths remain strictly video-only.
export function parseTeslaMonDeviceUrl(pathname){
  if(typeof pathname!=='string'||pathname.length<5||pathname.length>750)return null;
  const match=pathname.match(/^\/(ha|mac)\/([^?#]+)$/i);
  if(!match)return null;
  let value=match[2].replace(/\+/g,'%20');
  try{
    for(let i=0;i<2;i++){
      const next=decodeURIComponent(value.replace(/%(?![a-f0-9]{2})/gi,'%25'));
      if(value===next)break;
      value=next;
    }
  }catch{return null;}
  const text=value.normalize('NFC').trim();
  if(text.length<2||text.length>220||/[\x00-\x1f\x7f\/\\?#]/.test(text))return null;
  return {provider:match[1].toLowerCase(),text};
}
