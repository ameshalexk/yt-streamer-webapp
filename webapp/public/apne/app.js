/* Production APNE episode browser.
 * Retains read-only episode listing and existing authenticated thumbnail retrieval.
 * Episode cards navigate to the existing authenticated full-page player.
 * Download / source selection remains in that episode page.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const ux = window.ApneMobileBrowser;
  const continueUx = window.ApneContinueWatching;
  const state = {
    shows: [], selectedId: "", episodes: [], date: "", order: "newest", onlyUnwatched: false,
    page: 1, pageSize: 10, progress: {}, progressEpisodes: [], progressAvailable: false, loaded: false, watchFilter: "all",
    filtersByShow: new Map(),
  };
  const thumbs = { observer: null, pending: [], active: 0, generation: 0, ready: new Map() };
  const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (s) =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[s]));
  const show = () => state.shows.find((s) => s.id === state.selectedId);
  const status = (value) => String(value || "Listed");
  function airDate(ep) {
    const air = ep?.airDateKey || ep?.dateKey?.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(air || "") ? air : "";
  }
  function displayDate(dateKey) {
    const day = String(dateKey || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(dateKey || "Unknown date");
    const [y,m,d] = day.split("-").map(Number);
    return new Date(y,m-1,d,12).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
  }
  function selected() {
    const ordered=ux.selectEpisodes(state.episodes,
      {order:"newest",onlyUnwatched:state.onlyUnwatched,watchFilter:state.watchFilter},
      state.progress,state.selectedId);
    // Exact calendar day, not the nearest date/page. airDate handles multipart
    // keys such as 2026-10-12-e15 without dropping same-day episodes.
    return state.date?ordered.filter(ep=>airDate(ep)===state.date):ordered;
  }
  function saveFilters() {
    if(!state.selectedId)return;
    state.filtersByShow.set(state.selectedId,{
      date:state.date,order:state.order,onlyUnwatched:state.onlyUnwatched,watchFilter:state.watchFilter,page:state.page,
    });
  }
  function switchShow(showId) {
    if(!state.shows.some((s) => s.id === showId))return;
    saveFilters();
    state.selectedId=showId;
    const old=state.filtersByShow.get(showId);
    state.date=old?.date || "";
    state.order="newest";
    state.onlyUnwatched=state.progressAvailable && Boolean(old?.onlyUnwatched);
    state.watchFilter=state.progressAvailable ? old?.watchFilter || "all" : "all";
    state.page=old?.page || 1;
    state.episodes=[...(show()?.recentEpisodes || [])].sort((a,b) =>
      String(b.dateKey || "").localeCompare(String(a.dateKey || "")));
    render();
  }
  function goLatest() {
    state.date="";state.order="newest";state.onlyUnwatched=false;state.watchFilter="all";state.page=1;
    $("calendarPanel").open=false;
    render();
  }
  function showPicker() {
    $("showCount").textContent=state.shows.length+" shows";
    $("showGrid").innerHTML=state.shows.map((item) => {
      const active = state.selectedId===item.id;
      const showStatus=status(item.status);
      const stateClass=/^(available|saved)$/i.test(showStatus)?"available":"";
      return '<button class="show-choice" type="button" data-show-id="'+safe(item.id)+
        '" aria-pressed="'+active+'"><strong>'+safe(item.name || "Untitled show")+
        '</strong><span class="'+stateClass+'">'+safe(showStatus)+'</span></button>';
    }).join("");
  }
  function episodePlayerUrl(showId,dateKey) {
    if (!/^[a-z0-9-]{1,90}$/.test(showId) ||
        !/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(dateKey)) return "";
    return "/apne/live/watch/"+encodeURIComponent(showId)+"/"+encodeURIComponent(dateKey);
  }
  function thumbHTML(ep, showId=state.selectedId) {
    const date=ep?.dateKey || "";
    const validShow=/^[a-z0-9][a-z0-9-]{0,63}$/.test(showId);
    const validDate=/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(date);
    const markup = 'data-preview-show="'+safe(showId)+'" data-preview-date="'+safe(date)+
      '" data-preview-status="'+safe(ep?.status || "")+'"';
    return validShow && validDate
      ? markup+' data-preview-valid="1"'
      : markup+' data-preview-valid="0"';
  }
  function episodeRow(ep,index) {
    const key=ep.dateKey || "";
    const p=state.progress[state.selectedId+":"+key];
    const pct=p?.durationSeconds>0 ? (p.completed?100:
      Math.max(0,Math.min(99,Math.round((p.positionSeconds/p.durationSeconds)*100)))):null;
    const watchState=ux.watchState(p);
    const progressText=watchState==="watched"?"Watched":watchState==="in-progress"?(pct!==null?pct+"% watched":"In progress"):"Not started";
    const badge=key===state.episodes[0]?.dateKey?'<span class="tag">Latest</span>':"";
    const number=ep.episodeNumber?"Episode "+safe(ep.episodeNumber):"Episode";
    const buttonId="episode-"+index;
    const playerUrl=episodePlayerUrl(state.selectedId,key);
    const imageOpen=playerUrl
      ? '<a class="episode-art" href="'+safe(playerUrl)+'" '+thumbHTML(ep)+
        ' aria-label="Watch '+safe(show()?.name||"show")+' '+safe(displayDate(airDate(ep)||key))+'">'
      : '<div class="episode-art" '+thumbHTML(ep)+' aria-label="Episode preview">';
    const imageClose=playerUrl?'</a>':'</div>';
    return '<article class="episode-row" data-episode="'+safe(key)+'">'+
      imageOpen+'<span class="preview-placeholder">Loading preview…</span>'+imageClose+
      '<div class="episode-info"><div class="episode-title"><strong>'+safe(displayDate(airDate(ep)||key))+
        '</strong>'+badge+'</div><div class="episode-sub">'+number+
        (ep.episodeTitle?" · "+safe(ep.episodeTitle):"")+'</div>'+
      '<div><span class="tag '+(["Saved","Available"].includes(status(ep.status))?"":"neutral")+'">'+
        safe(status(ep.status))+'</span></div>'+
      (state.progressAvailable?'<div class="progress-label">'+safe(progressText)+'</div>':"")+
      (pct!==null&&state.progressAvailable?'<div class="watch-track" role="progressbar" aria-label="Watched percentage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><i style="width:'+pct+'%"></i></div>':"")+
      '<div class="episode-actions"><button class="details-button" aria-expanded="false" aria-controls="'+buttonId+
      '" data-detail="'+safe(index)+'" type="button">Episode details</button></div>'+
      '<div class="row-details" id="'+buttonId+'" hidden><p>Availability: '+safe(status(ep.status))+
      '</p><p>Air date: '+safe(displayDate(airDate(ep)||key))+
      '</p><p>Playback source: choose APNE, YoDesi (if offered), or a saved Mac copy on the player page.</p></div>'+
      '</div></article>';
  }
  function thumbCandidates(id,date,episodeStatus) {
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(date))
      return [];
    const path=encodeURIComponent(id)+"/"+date+".jpg";
    const saved=episodeStatus==="Saved";
    const official=id==="anupamaa"&&/^2026-09-2[3-8]$/.test(date);
    const candidates=[];
    if(saved)candidates.push("/apne/thumb/"+path);
    if(official)candidates.push("/apne/official-thumb/"+path);
    // Existing server creates/cache-bounds these previews; unsupported sources return 404.
    if(!saved)candidates.push("/apne/live-thumb/"+path);
    return candidates;
  }
  function resumeClock(seconds) {
    const value=Math.max(0,Math.floor(seconds));
    return Math.floor(value/60)+":"+String(value%60).padStart(2,"0");
  }
  function renderContinueWatching() {
    const section=$("continueWatching");
    const rail=$("continueRail");
    if(!section||!rail)return;
    const items=state.progressAvailable
      ? (continueUx?.select(state.progressEpisodes,state.shows,8)||[]) : [];
    section.hidden=items.length===0;
    rail.replaceChildren();
    if(!items.length)return;
    $("continueCount").textContent=items.length+" in progress";
    rail.innerHTML=items.map(item=>{
      const href=episodePlayerUrl(item.showId,item.dateKey);
      if(!href)return "";
      const date=displayDate(item.dateKey);
      const number=item.episodeNumber?"Episode "+item.episodeNumber:"Episode";
      const subtitle=number+" · "+date+(item.episodeTitle?" · "+item.episodeTitle:"");
      const progress=item.percent!==null
        ? '<div class="watch-track" role="progressbar" aria-label="Watched percentage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+item.percent+'"><i style="width:'+item.percent+'%"></i></div>' : "";
      return '<a class="continue-card" href="'+safe(href)+'?resume=1" aria-label="Resume '+safe(item.showName)+' '+safe(subtitle)+' at '+safe(resumeClock(item.positionSeconds))+'">'+
        '<span class="continue-art" '+thumbHTML({dateKey:item.dateKey,status:item.status},item.showId)+'><span class="preview-placeholder">Loading preview…</span></span>'+
        '<span class="continue-copy"><strong>'+safe(item.showName)+'</strong><span class="continue-sub">'+safe(subtitle)+'</span>'+
        '<span class="continue-resume">Resume at '+resumeClock(item.positionSeconds)+'</span>'+progress+'</span></a>';
    }).join("");
  }
  let progressRefreshBusy=false;
  async function refreshProgress(redraw=true) {
    if(!state.loaded||progressRefreshBusy)return;
    progressRefreshBusy=true;
    try{
      const response=await fetch("/api/apne/progress",{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw Error("Progress unavailable");
      const data=await response.json();
      if(!Array.isArray(data.episodes))throw Error("Invalid progress response");
      state.progressEpisodes=data.episodes;
      state.progress=Object.fromEntries(data.episodes.map(item=>[item.showId+":"+item.dateKey,item]));
      state.progressAvailable=true;
    }catch{
      // Browsing episodes still works if the private history API is unavailable.
      state.progressAvailable=false;
      state.progressEpisodes=[];
      state.progress={};
      state.onlyUnwatched=false;
      state.watchFilter="all";
    }finally{progressRefreshBusy=false;}
    renderContinueWatching();
    if(redraw&&state.selectedId)render();
  }
  // Client-side search only: search the already authenticated catalog across shows.
  function renderSearch() {
    const query=$("episodeSearch").value.trim().toLocaleLowerCase();
    const panel=$("searchResults");
    if(query.length<2){panel.hidden=true;panel.replaceChildren();return;}
    const matches=state.shows.flatMap(item=>(item.recentEpisodes||[]).map(ep=>({item,ep})))
      .filter(({item,ep})=>[item.name,ep.episodeTitle,ep.episodeNumber,
        ep.dateKey,airDate(ep)].some(value=>String(value??"").toLocaleLowerCase().includes(query)))
      .sort((a,b)=>-ux.compareEpisodes(a.ep,b.ep)).slice(0,30);
    panel.hidden=false;
    const summary='<p class="muted">'+matches.length+' match'+(matches.length===1?'':'es')+
      (matches.length===30?' (first 30)':'')+'</p>';
    panel.innerHTML=summary+(matches.length?matches.map(({item,ep})=>{
      const href=episodePlayerUrl(item.id,ep.dateKey);
      if(!href)return '';
      return '<a class="search-result" href="'+safe(href)+'"><strong>'+safe(item.name)+
        '</strong><span>'+safe(ep.episodeNumber?'Episode '+ep.episodeNumber:'Episode')+' · '+
        safe(displayDate(airDate(ep)||ep.dateKey))+(ep.episodeTitle?' · '+safe(ep.episodeTitle):'')+
        '</span></a>';
    }).join(''):'<p class="muted">No matching episodes in the indexed catalog.</p>');
  }
  function previewFallback(node,message="Preview unavailable") {
    if(!node.isConnected)return;
    node.replaceChildren();
    const span=document.createElement("span");
    span.className="preview-placeholder";
    span.textContent=message;
    node.append(span);
  }
  function attachImage(node,url) {
    if(!node.isConnected)return;
    const img=document.createElement("img");
    img.alt="Episode still";
    img.decoding="async";
    img.loading="eager";
    img.onload=()=>{if(node.isConnected){node.replaceChildren(img);node.classList.add("has-image");}};
    img.onerror=()=>{
      const key=node.dataset.previewShow+":"+node.dataset.previewDate;
      const saved=thumbs.ready.get(key);
      if(saved===url){thumbs.ready.delete(key);URL.revokeObjectURL(url);}
      previewFallback(node);
    };
    img.src=url;
  }
  async function requestPreview(url,node,generation) {
    // Read the image with GET, not HEAD: the authenticated thumbnail route
    // generates files on demand and the browser must receive the JPEG bytes.
    for(let attempt=0;attempt<10;attempt++){
      if(!node.isConnected||generation!==thumbs.generation)return {kind:"aborted"};
      let response;
      try{
        response=await fetch(url,{method:"GET",credentials:"same-origin",cache:"default"});
      }catch{return {kind:"failed"};}
      if(response.status===200){
        const type=response.headers.get("content-type")||"";
        if(!type.toLowerCase().startsWith("image/jpeg"))return {kind:"failed"};
        const blob=await response.blob();
        if(blob.size<=100||blob.size>=1048576)return {kind:"failed"};
        return {kind:"ready",src:URL.createObjectURL(blob)};
      }
      if(response.status===401||response.status===403)return {kind:"auth"};
      if(response.status!==202)return {kind:"failed"};
      await new Promise(r=>setTimeout(r,attempt<3?1500:2500));
    }
    return {kind:"failed"};
  }
  async function loadPreview(node,generation) {
    if(!node.isConnected||generation!==thumbs.generation)return;
    const id=node.dataset.previewShow,date=node.dataset.previewDate;
    if(node.dataset.previewValid!=="1"){previewFallback(node);return;}
    const cacheKey=id+":"+date;
    const cached=thumbs.ready.get(cacheKey);
    if(cached){attachImage(node,cached);return;}
    const choices=thumbCandidates(id,date,node.dataset.previewStatus);
    if(!choices.length){previewFallback(node);return;}
    for(const url of choices){
      if(!node.isConnected||generation!==thumbs.generation)return;
      const outcome=await requestPreview(url,node,generation);
      if(outcome.kind==="aborted")return;
      if(outcome.kind==="ready"){
        thumbs.ready.set(cacheKey,outcome.src);
        // Prevent retaining unlimited offscreen thumbnails in long sessions.
        if(thumbs.ready.size>50){
          const oldest=thumbs.ready.keys().next().value;
          URL.revokeObjectURL(thumbs.ready.get(oldest));
          thumbs.ready.delete(oldest);
        }
        attachImage(node,outcome.src);
        return;
      }
      if(outcome.kind==="auth"){previewFallback(node,"Sign in for preview");return;}
    }
    previewFallback(node);
  }
  function drainPreviews() {
    while(thumbs.active<3&&thumbs.pending.length){
      const {node,generation}=thumbs.pending.shift();
      if(!node.isConnected||generation!==thumbs.generation)continue;
      thumbs.active++;
      void loadPreview(node,generation).finally(()=>{
        thumbs.active--;drainPreviews();
      });
    }
  }
  function observePreviews() {
    thumbs.observer?.disconnect();
    thumbs.generation++;
    thumbs.pending=[];
    const generation=thumbs.generation;
    const els=document.querySelectorAll("[data-preview-show][data-preview-date]");
    thumbs.observer=new IntersectionObserver((entries,observer)=>{
      for(const entry of entries){
        if(!entry.isIntersecting)continue;
        observer.unobserve(entry.target);
        thumbs.pending.push({node:entry.target,generation});
      }
      drainPreviews();
    },{rootMargin:"700px 0px"});
    for(const el of els)thumbs.observer.observe(el);
  }
  function render() {
    if(!state.loaded)return;
    const item=show();
    if(!item)return;
    showPicker();
    $("showTitle").textContent=item.name || "Untitled show";
    $("showStatus").textContent=status(item.status)+" · Latest: "+
      (item.episode?.dateKey?displayDate(item.episode.dateKey):"unknown");
    $("showStatus").classList.toggle("good",["Available","Saved"].includes(status(item.status)));
    $("quickStart").hidden=!state.episodes.length||Boolean(state.date);
    if(state.episodes.length){
      const latest=state.episodes[0];
      $("latestDate").textContent=displayDate(airDate(latest)||latest.dateKey);
      $("latestMeta").textContent=latest.episodeNumber?"Episode "+latest.episodeNumber:"Most recent listing";
      const hero=$("latestPreview");
      hero.href=episodePlayerUrl(state.selectedId,latest.dateKey)||"#";
      hero.setAttribute("aria-label","Watch "+(item.name||"show")+" "+displayDate(airDate(latest)||latest.dateKey));
      hero.dataset.previewShow=state.selectedId;
      hero.dataset.previewDate=latest.dateKey||"";
      hero.dataset.previewStatus=latest.status||"";
      hero.dataset.previewValid=/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(latest.dateKey||"")?"1":"0";
      hero.classList.remove("has-image");
      previewFallback(hero,"Loading preview…");
    }
    $("episodeDate").value=state.date;
    $("calendarActive").hidden=!state.date;
    $("calendarActiveDate").textContent=state.date?"Episodes for "+displayDate(state.date):"";
    $("calendarHint").textContent=state.date?"Date filter active":"Filter by date";
    const dates=state.episodes.map(airDate).filter(Boolean).sort();
    $("episodeDate").min=dates[0]||"";
    $("episodeDate").max=dates.at(-1)||"";
    $("unwatched").setAttribute("aria-pressed",String(state.onlyUnwatched));
    $("watchFilter").value=state.watchFilter;
    $("watchFilter").disabled=!state.progressAvailable;
    $("unwatched").disabled=!state.progressAvailable;
    $("unwatched").title=state.progressAvailable?"Show episodes not marked watched":"Watch history unavailable in preview";
    const matches=selected();
    const pages=Math.max(1,Math.ceil(matches.length/state.pageSize));
    state.page=Math.min(state.page,pages);
    const current=matches.slice((state.page-1)*state.pageSize,state.page*state.pageSize);
    $("resultCount").textContent=matches.length+" episode"+(matches.length===1?"":"s");
    $("rangeNotice").textContent=matches.length+
      " currently listed episode"+(matches.length===1?"":"s")+
      (state.date?" · Calendar: "+displayDate(state.date):"")+
      (!state.progressAvailable?" · Watched filter unavailable":"");
    $("episodeList").innerHTML=current.length?current.map((ep,i)=>episodeRow(ep,(state.page-1)*state.pageSize+i)).join(""):
      '<div class="empty">'+(state.date
        ? 'No '+(state.onlyUnwatched?'unwatched ':'')+'episodes listed for '+safe(displayDate(state.date))+'. Choose another date or select Show all episodes.'
        : 'No matching episodes. Turn off the unwatched filter to see all listings.')+'</div>';
    const start=current.length?(state.page-1)*state.pageSize+1:0;
    const end=(state.page-1)*state.pageSize+current.length;
    for(const nav of [$("pager"),$("pagerTop")]) {
      nav.hidden=pages<=1;
      nav.querySelector('[data-page-move="newer"]').disabled=state.page<=1;
      nav.querySelector('[data-page-move="older"]').disabled=state.page>=pages;
      nav.querySelector(".page-range").textContent=start+"–"+end+" of "+matches.length;
    }
    $("archiveNotice").hidden=Boolean(state.date)||state.page<pages||!matches.length;
    saveFilters();
    observePreviews();
  }
  async function load() {
    $("refresh").disabled=true;
    $("showStatus").textContent="Checking APNE episodes…";
    try {
      const response=await fetch("/api/apne-daily",{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw Error("Episode list unavailable ("+response.status+")");
      const data=await response.json();
      if(!Array.isArray(data.shows)||!data.shows.length)throw Error("No configured APNE shows");
      const previous=state.selectedId;
      state.shows=data.shows;
      state.loaded=true;
      renderSearch();
      await refreshProgress(false);
      switchShow(state.shows.some(item=>item.id===previous)?previous:
        state.shows.find(item=>item.id==="anupamaa")?.id||state.shows[0].id);
    }catch(error){
      $("showStatus").textContent=error.message;
      $("showGrid").innerHTML='<p class="empty">Unable to list shows. Try Refresh.</p>';
      $("episodeList").innerHTML='<div class="empty">Could not load episodes. Try Refresh or return to APNE Daily.</div>';
      $("resultCount").textContent="Unavailable";
    }finally{$("refresh").disabled=false;}
  }
  $("episodeSearch").addEventListener("input",renderSearch);
  $("showGrid").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-show-id]");
    if(!button)return;
    const id=button.dataset.showId;
    switchShow(id);
    const focused=Array.from($("showGrid").querySelectorAll("[data-show-id]"))
      .find(item=>item.dataset.showId===id);
    focused?.focus({preventScroll:true});
  });
  $("episodeDate").addEventListener("change",(event)=>{
    const value=event.target.value;
    state.date=/^\d{4}-\d{2}-\d{2}$/.test(value)?value:"";
    state.page=1;
    $("calendarPanel").open=false;
    render();
    $("episodeHeading").scrollIntoView({behavior:"smooth",block:"start"});
  });
  $("exitCalendar").addEventListener("click",goLatest);
  $("unwatched").addEventListener("click",()=>{
    if(!state.progressAvailable)return;
    state.onlyUnwatched=!state.onlyUnwatched;state.watchFilter="all";state.page=1;render();
  });
  $("watchFilter").addEventListener("change",event=>{
    state.watchFilter=["all","not-started","in-progress","watched"].includes(event.target.value)?event.target.value:"all";
    state.onlyUnwatched=false;state.page=1;render();
  });
  $("clearFilters").addEventListener("click",goLatest);
  $("latestButton").addEventListener("click",goLatest);
  $("refresh").addEventListener("click",load);
  function pageMove(delta) {
    const total=Math.max(1,Math.ceil(selected().length/state.pageSize));
    const next=Math.min(total,Math.max(1,state.page+delta));
    if(next===state.page)return;
    state.page=next;
    render();
    $("episodeHeading").scrollIntoView({behavior:"smooth",block:"start"});
  }
  for(const nav of [$("pager"),$("pagerTop")]) nav.addEventListener("click",(event)=>{
    const button=event.target.closest("[data-page-move]");
    if(button&&!button.disabled)pageMove(button.dataset.pageMove==="older"?1:-1);
  });
  let swipeStart=null;
  $("episodeList").addEventListener("touchstart",(event)=>{
    if(event.touches.length===1)swipeStart={x:event.touches[0].clientX,y:event.touches[0].clientY};
  },{passive:true});
  $("episodeList").addEventListener("touchend",(event)=>{
    if(!swipeStart||event.changedTouches.length!==1)return;
    const dx=event.changedTouches[0].clientX-swipeStart.x;
    const dy=event.changedTouches[0].clientY-swipeStart.y;
    swipeStart=null;
    if(Math.abs(dx)>=70&&Math.abs(dx)>Math.abs(dy)*1.5)pageMove(dx<0?1:-1);
  },{passive:true});
  $("episodeList").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-detail]");
    if(!button)return;
    const panel=$(button.getAttribute("aria-controls"));if(!panel)return;
    panel.hidden=!panel.hidden;button.setAttribute("aria-expanded",String(!panel.hidden));
  });
  // Refresh cross-show history on return from the video player, including Safari bfcache.
  window.addEventListener("pageshow",event=>{
    if(event.persisted)void refreshProgress();
  });
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden)void refreshProgress();
  });
  load();
})();
