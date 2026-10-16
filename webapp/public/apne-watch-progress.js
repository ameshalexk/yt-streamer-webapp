// Native HTML5 APNE progress only. Never introspect a third-party iframe.
// Episode key stays the same when APNE resolves to a different streaming URL
// or an HLS episode is later downloaded as a local MP4.
(() => {
  'use strict';
  const video = document.querySelector('video[data-progress-show][data-progress-date]');
  const panel = document.querySelector('#apneWatchProgress');
  if (!video || !panel) return;
  const showId = video.dataset.progressShow;
  const dateKey = video.dataset.progressDate;
  if (!/^[a-z0-9-]{1,90}$/.test(showId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return;
  const url = `/api/apne/progress/${encodeURIComponent(showId)}/${encodeURIComponent(dateKey)}`;
  let saved = null, session = null, sequence = 0, lastSaved = 0;
  let pendingResume = new URLSearchParams(location.search).get('resume') === '1';
  let embedded = false, saving = Promise.resolve(), beginning = null;
  const duration = () => Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 86400 ? video.duration : null;
  const validPosition = () => Number.isFinite(video.currentTime) && video.currentTime >= 0 && video.currentTime <= 86400;
  const clock = (seconds) => {
    const n = Math.max(0, Math.floor(seconds));
    return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;
  };
  async function json(path, method, body, keepalive=false) {
    const response = await fetch(path, {method, credentials:'same-origin', cache:'no-store',
      ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {}),
      ...(keepalive ? {keepalive:true} : {})});
    if (!response.ok) throw new Error(`APNE progress HTTP ${response.status}`);
    return response.json();
  }
  function showResume() {
    const position = Number(saved?.positionSeconds);
    if (!saved || saved.completed || !Number.isFinite(position) || position < 5 || embedded) return;
    panel.replaceChildren();
    const label=document.createElement('span');
    label.textContent=`Saved position: ${clock(position)}`;
    const button=document.createElement('button');
    button.type='button';button.textContent=`Resume from ${clock(position)}`;
    button.style.cssText='margin-left:12px;padding:7px 12px;border-radius:8px;background:#273b55;border:1px solid #7192b7;color:white;cursor:pointer';
    button.addEventListener('click',()=>{
      pendingResume=true;
      tryResume();
      // Only a direct user gesture starts playback; Safari may require another tap.
      video.play().catch(()=>{});
    });
    panel.append(label,button);
  }
  function tryResume() {
    if (!pendingResume || embedded || !saved || saved.completed) return;
    const t=Number(saved.positionSeconds), d=duration();
    if (!(Number.isFinite(t) && t >= 5 && (!d || t < d-4))) return;
    if (video.readyState === 0 || !video.seekable?.length) return;
    try {
      const start=video.seekable.start(0), end=video.seekable.end(video.seekable.length-1);
      if (end <= start || t > end-1 || t < start) return;
      video.currentTime=Math.max(start,Math.min(end-1,t));
      pendingResume=false;
      panel.textContent=`Resumed at ${clock(video.currentTime)}. Press Play to watch.`;
    } catch { /* Retry on canplay or progress when Safari exposes the seek window. */ }
  }
  function stopForEmbed() {
    embedded=true; session=null;
    panel.textContent='Embedded source: precise watch progress is unavailable. You can mark the episode watched from the show list.';
  }
  window.addEventListener('apne:embed',stopForEmbed);
  const embedStage = document.querySelector('#apneEmbedStage');
  if (embedStage && !embedStage.hidden) stopForEmbed();
  json(url,'GET').then(result => {
    saved=result?.progress || null;
    if (!embedded) {
      if (pendingResume) tryResume();
      else showResume();
    }
  }).catch(() => { /* Video playback remains usable without progress service. */ });
  async function beginIfNeeded() {
    if (embedded || session || video.hidden) return;
    if (beginning) return beginning;
    beginning = (async () => {
      try {
        const response=await json(`${url}/session`,'POST',{});
        if (!embedded) { session=response.sessionId; sequence=0; }
      } catch {
        if (!embedded) panel.textContent='Playback works, but progress could not be saved.';
      } finally { beginning = null; }
    })();
    return beginning;
  }
  function save({ended=false,keepalive=false}={}) {
    if (!session || embedded || !validPosition()) return;
    const payload={sessionId:session,sequence:sequence++,positionSeconds:video.currentTime,
      ...(duration() ? {durationSeconds:duration()} : {}),...(ended ? {ended:true} : {})};
    const send=()=>json(url,'PATCH',payload,keepalive).then(result=>{
      saved=result?.progress || saved;
      if (ended) panel.textContent='Watched';
    }).catch(()=>{});
    // Serialize ordinary updates so a slower network never overwrites a newer seek.
    if (keepalive) void send();
    else saving=saving.then(send,send);
    lastSaved=Date.now();
  }
  video.addEventListener('play',()=>{ void beginIfNeeded(); });
  video.addEventListener('playing',()=>{void beginIfNeeded();});
  video.addEventListener('timeupdate',()=>{
    if (pendingResume) tryResume();
    if (!video.paused && !video.seeking && Date.now()-lastSaved>=12000) save();
  });
  for (const event of ['loadedmetadata','canplay','durationchange','progress','seeked'])
    video.addEventListener(event,tryResume);
  video.addEventListener('pause',()=>save());
  video.addEventListener('seeked',()=>save());
  video.addEventListener('ended',()=>save({ended:true}));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)save({keepalive:true});});
  window.addEventListener('pagehide',()=>save({keepalive:true}));
})();
