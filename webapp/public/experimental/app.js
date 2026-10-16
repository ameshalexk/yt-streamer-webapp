/* Experimental-only APNE episode browser.
 * Show data: read-only GETs to the existing authenticated APIs.
 * Preview thumbnails: bounded authenticated GET/HEAD workers already used by stable APNE.
 * No playback/download/change-status actions in this preview.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const ux = window.ApneMobileBrowser;
  const state = {
    shows: [], selectedId: "", episodes: [], date: "", order: "newest", onlyUnwatched: false,
    page: 1, pageSize: 10, progress: {}, progressAvailable: false, loaded: false,
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
    const ordered = ux.selectEpisodes(state.episodes,
      {order:state.order,onlyUnwatched:state.onlyUnwatched},
      state.progress,state.selectedId);
    return state.date ? ordered.filter((ep) => airDate(ep) === state.date) : ordered;
  }
  function saveFilters() {
    if(!state.selectedId)return;
    state.filtersByShow.set(state.selectedId,{
      date:state.date,order:state.order,onlyUnwatched:state.onlyUnwatched,page:state.page,
    });
  }
  function switchShow(showId) {
    if(!state.shows.some((s) => s.id === showId))return;
    saveFilters();
    state.selectedId=showId;
    const old=state.filtersByShow.get(showId);
    state.date=old?.date || "";
    state.order=old?.order || "newest";
    state.onlyUnwatched=state.progressAvailable && Boolean(old?.onlyUnwatched);
    state.page=old?.page || 1;
    state.episodes=[...(show()?.recentEpisodes || [])].sort((a,b) =>
      String(b.dateKey || "").localeCompare(String(a.dateKey || "")));
    render();
  }
  function goLatest() {
    state.date="";state.order="newest";state.onlyUnwatched=false;state.page=1;
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
  function chips() {
    const dates=ux.recentDates(state.episodes.map(ep=>({dateKey:airDate(ep)})),12);
    $("dateChips").innerHTML=[{date:"",top:"All",bottom:"dates"},...dates.map((date)=>{
      const label=ux.dateChipLabel(date);
      return {date,top:label.day,bottom:label.date};
    })].map((chip)=>'<button type="button" class="date-chip" data-date="'+safe(chip.date)+
      '" aria-pressed="'+(state.date===chip.date)+'"><b>'+safe(chip.top)+
      '</b><span>'+safe(chip.bottom)+'</span></button>').join("");
  }
  function thumbHTML(ep) {
    const date=ep?.dateKey || "";
    const validShow=/^[a-z0-9][a-z0-9-]{0,63}$/.test(state.selectedId);
    const validDate=/^\d{4}-\d{2}-\d{2}$/.test(date);
    const markup = 'data-preview-show="'+safe(state.selectedId)+'" data-preview-date="'+safe(date)+
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
    const progressText=p?.completed?"Watched":pct!==null&&pct>0?pct+"% watched":"Not started";
    const badge=key===state.episodes[0]?.dateKey?'<span class="tag">Latest</span>':"";
    const number=ep.episodeNumber?"Episode "+safe(ep.episodeNumber):"Episode";
    const buttonId="episode-"+index;
    return '<article class="episode-row" data-episode="'+safe(key)+'">'+
      '<div class="episode-art" '+thumbHTML(ep)+' aria-label="Episode preview">'+
        '<span class="preview-placeholder">Loading preview…</span></div>'+
      '<div class="episode-info"><div class="episode-title"><strong>'+safe(displayDate(airDate(ep)||key))+
        '</strong>'+badge+'</div><div class="episode-sub">'+number+
        (ep.episodeTitle?" · "+safe(ep.episodeTitle):"")+'</div>'+
      '<div><span class="tag '+(["Saved","Available"].includes(status(ep.status))?"":"neutral")+'">'+
        safe(status(ep.status))+'</span></div>'+
      (state.progressAvailable?'<div class="progress-label">'+safe(progressText)+'</div>':"")+
      (pct!==null&&state.progressAvailable?'<div class="watch-track" role="progressbar" aria-label="Watched percentage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><i style="width:'+pct+'%"></i></div>':"")+
      '<div class="episode-actions"><button class="details-button" aria-expanded="false" aria-controls="'+buttonId+
      '" data-detail="'+safe(index)+'" type="button">Episode details</button></div>'+
      '<div class="row-details" id="'+buttonId+'" hidden><p>Source: '+safe(status(ep.status))+
      '</p><p>Air date: '+safe(displayDate(airDate(ep)||key))+
      '</p><p>Playback and downloads stay disabled in Experimental to keep production data unchanged.</p></div>'+
      '</div></article>';
  }
  function thumbCandidates(id,date,episodeStatus) {
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!/^\d{4}-\d{2}-\d{2}$/.test(date))
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
    img.onerror=()=>{thumbs.ready.delete(node.dataset.previewShow+":"+node.dataset.previewDate);
      previewFallback(node);};
    img.src=url;
  }
  async function requestPreview(url,node,generation) {
    for(let attempt=0;attempt<10;attempt++){
      if(!node.isConnected||generation!==thumbs.generation)return "aborted";
      let response;
      try {
        response=await fetch(url,{method:"HEAD",credentials:"same-origin",cache:"no-store"});
      }catch{return "failed";}
      if(response.status===200)return "ready";
      if(response.status===401||response.status===403)return "auth";
      if(response.status!==202)return "failed";
      await new Promise(r=>setTimeout(r,attempt<3?1500:2500));
    }
    return "failed";
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
      if(outcome==="aborted")return;
      if(outcome==="ready"){thumbs.ready.set(cacheKey,url);attachImage(node,url);return;}
      if(outcome==="auth"){previewFallback(node,"Sign in for preview");return;}
    }
    previewFallback(node);
  }
  function drainPreviews() {
    while(thumbs.active<2&&thumbs.pending.length){
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
    },{rootMargin:"200px 0px"});
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
    $("quickStart").hidden=!state.episodes.length;
    if(state.episodes.length){
      const latest=state.episodes[0];
      $("latestDate").textContent=displayDate(airDate(latest)||latest.dateKey);
      $("latestMeta").textContent=latest.episodeNumber?"Episode "+latest.episodeNumber:"Most recent listing";
      const hero=$("latestPreview");
      hero.dataset.previewShow=state.selectedId;
      hero.dataset.previewDate=latest.dateKey||"";
      hero.dataset.previewStatus=latest.status||"";
      hero.dataset.previewValid=/^\d{4}-\d{2}-\d{2}$/.test(latest.dateKey||"")?"1":"0";
      hero.classList.remove("has-image");
      previewFallback(hero,"Loading preview…");
    }
    chips();
    $("episodeDate").value=state.date;
    $("episodeOrder").value=state.order;
    $("unwatched").setAttribute("aria-pressed",String(state.onlyUnwatched));
    $("unwatched").disabled=!state.progressAvailable;
    $("unwatched").title=state.progressAvailable?"Show episodes not marked watched":"Watch history unavailable in preview";
    const matches=selected();
    const pages=Math.max(1,Math.ceil(matches.length/state.pageSize));
    state.page=Math.min(state.page,pages);
    const current=matches.slice((state.page-1)*state.pageSize,state.page*state.pageSize);
    $("resultCount").textContent=matches.length+" episode"+(matches.length===1?"":"s");
    $("rangeNotice").textContent=(item.history?.months?"Last "+item.history.months+" months of listings":"Available APNE listings")+
      (state.date?" · "+displayDate(state.date):"")+
      (!state.progressAvailable?" · Watched filter unavailable":"");
    $("episodeList").innerHTML=current.length?current.map((ep,i)=>episodeRow(ep,(state.page-1)*state.pageSize+i)).join(""):
      '<div class="empty">No matching episodes. Choose a different date or clear the filters.</div>';
    $("pager").hidden=pages<=1;
    $("newer").disabled=state.page<=1;
    $("older").disabled=state.page>=pages;
    $("pageInfo").textContent=state.page+" of "+pages;
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
      try {
        const result=await fetch("/api/apne/progress",{credentials:"same-origin",cache:"no-store"});
        if(result.ok){
          const progress=await result.json();
          state.progress=Object.fromEntries((progress.episodes||[])
            .map(item=>[item.showId+":"+item.dateKey,item]));
          state.progressAvailable=true;
        } else state.progressAvailable=false;
      }catch{state.progressAvailable=false;}
      if(!state.progressAvailable)state.onlyUnwatched=false;
      switchShow(state.shows.some(item=>item.id===previous)?previous:
        state.shows.find(item=>item.id==="anupamaa")?.id||state.shows[0].id);
    }catch(error){
      $("showStatus").textContent=error.message;
      $("showGrid").innerHTML='<p class="empty">Unable to list shows. Try Refresh.</p>';
      $("episodeList").innerHTML='<div class="empty">Could not load episodes. Try Refresh or return to APNE Daily.</div>';
      $("resultCount").textContent="Unavailable";
    }finally{$("refresh").disabled=false;}
  }
  $("showGrid").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-show-id]");
    if(!button)return;
    const id=button.dataset.showId;
    switchShow(id);
    const focused=Array.from($("showGrid").querySelectorAll("[data-show-id]"))
      .find(item=>item.dataset.showId===id);
    focused?.focus({preventScroll:true});
  });
  $("dateChips").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-date]");
    if(!button)return;
    state.date=button.dataset.date||"";state.page=1;render();
  });
  $("episodeDate").addEventListener("change",(event)=>{
    state.date=/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)?event.target.value:"";
    state.page=1;render();
  });
  $("episodeOrder").addEventListener("change",(event)=>{
    state.order=event.target.value==="oldest"?"oldest":"newest";state.page=1;render();
  });
  $("unwatched").addEventListener("click",()=>{
    if(!state.progressAvailable)return;
    state.onlyUnwatched=!state.onlyUnwatched;state.page=1;render();
  });
  $("clearFilters").addEventListener("click",goLatest);
  $("latestButton").addEventListener("click",goLatest);
  $("refresh").addEventListener("click",load);
  $("newer").addEventListener("click",()=>{state.page--;render();});
  $("older").addEventListener("click",()=>{state.page++;render();});
  $("episodeList").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-detail]");
    if(!button)return;
    const panel=$(button.getAttribute("aria-controls"));if(!panel)return;
    panel.hidden=!panel.hidden;button.setAttribute("aria-expanded",String(!panel.hidden));
  });
  load();
})();
