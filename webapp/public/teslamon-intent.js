// Restricted local TeslaMon command grammar. This is NOT a general LLM.
// It can never instruct arbitrary URLs, system commands or unrelated devices.
const compact=text=>String(text||'').normalize('NFKC').trim()
  .replace(/\s+/g,' ').replace(/[.!?]+$/g,'');

function controlPhrase(line){
  // Unwrap only command framing. Search text is parsed separately and kept intact.
  let phrase=line.replace(/^(?:please\s+)?(?:(?:can|could|would) you(?: please)?\s+)/i,'');
  if(phrase===line)phrase=line.replace(/^please\s+/i,'');
  phrase=phrase.replace(/\s+(?:please|for me(?: please)?)$/i,'');
  return phrase;
}

function searchPhrase(line){
  // Courtesy language is removed only before an explicit search verb. Never edit
  // the title tail (for example, "play Please Pause" remains that exact title).
  const request=line.replace(/^(?:please\s+)?(?:(?:can|could|would) you(?: please)?\s+)(?=(?:play|find|search|put on|show me|watch|start)\b)/i,'')
    .replace(/^please\s+(?=(?:play|find|search|put on|show me|watch|start)\b)/i,'');
  const query=request.match(/^(?:play|find|search(?: for)?|put on|show me|watch|start)(?: (?:the|a|an))? (.+)$/i);
  if(!query)return null;
  let phrase=query[1].replace(/^(?:video (?:of|about)|youtube video (?:of|about)|song called)\s+/i,'').trim();
  if(phrase.length<2||phrase.length>120)return {error:'Use a search phrase between 2 and 120 characters.'};
  if(/(?:\b[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(phrase)||/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(phrase))
    return {error:'Search by title rather than a URL.'};
  if(/\b(?:on|in|to)\s+(?:the\s+)?(?:browser|tab|device|player|tesla|tv)\b|\b(?:browser|tab|device)\s*(?:#|number\s*)?[a-z0-9_-]+\b/i.test(phrase))
    return {error:'Choose the playback browser in TeslaMon before sending a command.'};
  if(/\b(?:and then|then|and)\s+(?:pause|resume|unpause|stop|play|skip|seek|unlock|open|close|turn on|turn off)\b/i.test(phrase))
    return {error:'Send one playback action at a time.'};
  return {tool:'search_and_play',args:{query:phrase}};
}

export function interpretTeslaMon(text){
  const line=compact(text);
  if(line.length===0||line.length>220)return {error:'Please enter a short playback command.'};
  const phrase=controlPhrase(line);
  if(/^(?:pause|pause (?:the )?(?:video|movie|player|playback)|stop playback|stop (?:the )?video|hold on)$/i.test(phrase))
    return {tool:'pause',args:{}};
  if(/^(?:resume|continue|unpause|keep playing|continue playing|resume (?:the )?(?:video|movie|player|playback))$/i.test(phrase))
    return {tool:'resume',args:{}};
  if(/^(?:(?:tell me )?what(?:'s| is) playing(?: right now)?|(?:tell me )?what(?:'s| is) on|player status|status|how is playback|current video|what is the current video)$/i.test(phrase))
    return {tool:'get_playback_state',args:{}};
  if(/^(?:exit|leave|close|turn off|get out of) (?:the )?full[ -]?screen(?: mode)?$/i.test(phrase))
    return {tool:'exit_fullscreen',args:{}};
  if(/^(?:(?:go|switch) (?:to |into )?|enter |turn on |make (?:it )?|show )?(?:the )?full[ -]?screen(?: mode)?$/i.test(phrase))
    return {tool:'request_fullscreen',args:{}};
  const query=searchPhrase(line);
  if(query)return query;
  return {error:'Try “play [video title]”, “pause”, “resume”, “status” or “fullscreen”.'};
}
