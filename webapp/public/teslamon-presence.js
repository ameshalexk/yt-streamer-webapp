// Keep the visible assistant until a request has a confirmed outcome.
// A late reply cannot hide a newly invoked/edited command.
export function shouldDismissTeslaMon({
  response,tool,requestRevision,panelRevision,hasDraft,panelOpen,fullscreen
}={}) {
  if(requestRevision!==panelRevision||hasDraft||!panelOpen&&!fullscreen)return false;
  if(response?.status==='ha_done')return true;
  if(response?.status!=='observed')return false;
  if(tool==='search_and_play')return response.playbackPhase==='playing';
  return true;
}
