// Restricted local TeslaMon command grammar. This is NOT a general LLM.
// It can never instruct arbitrary URLs, system commands or unrelated devices.
const compact=text=>String(text||'').normalize('NFKC').trim()
  .replace(/\s+/g,' ').replace(/[.!?]+$/g,'');
export function interpretTeslaMon(text){
  const line=compact(text);
  if(line.length===0||line.length>220)return {error:'Please enter a short playback command.'};
  if(/^(?:pause|pause (?:the )?(?:video|movie|player|playback)|stop playback|hold on)$/i.test(line))
    return {tool:'pause',args:{}};
  if(/^(?:resume|continue|unpause|keep playing|resume (?:the )?(?:video|movie|player|playback))$/i.test(line))
    return {tool:'resume',args:{}};
  if(/^(?:what(?:'s| is) playing|player status|status|what(?:'s| is) on|how is playback|current video)$/i.test(line))
    return {tool:'get_playback_state',args:{}};
  if(/^(?:exit|leave|close) (?:the )?full.?screen(?: mode)?$/i.test(line))
    return {tool:'exit_fullscreen',args:{}};
  if(/^(?:go |enter |make (?:it )?|turn on |show )?(?:the )?full.?screen(?: mode)?$/i.test(line))
    return {tool:'request_fullscreen',args:{}};
  const query=line.match(/^(?:(?:please )?(?:play|find|search(?: for)?|put on|show me|watch|start)(?: (?:the|a|an))? )(.+)$/i);
  if(query){
    let phrase=query[1].replace(/^(?:video (?:of|about)|youtube video (?:of|about)|song called)\s+/i,'').trim();
    if(phrase.length<2||phrase.length>120)return {error:'Use a search phrase between 2 and 120 characters.'};
    if(/^(?:https?:\/\/|www\.)/i.test(phrase))return {error:'Search by title rather than a URL.'};
    return {tool:'search_and_play',args:{query:phrase}};
  }
  return {error:'Try “play [video title]”, “pause”, “resume”, “status” or “fullscreen”.'};
}
