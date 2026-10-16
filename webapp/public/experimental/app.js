/* Isolated, read-only APNE browser. No mutations or video downloads. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const ux = window.ApneMobileBrowser;
  const state = {episodes:[], show:null, date:"", order:"newest", onlyUnwatched:false, page:1, pageSize:10, progress:{}, progressAvailable:false, loaded:false};
  const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const displayDate = (dateKey) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey ?? "")) return String(dateKey || "Unknown date");
    const [y,m,d] = dateKey.split("-").map(Number);
    return new Date(y,m-1,d,12).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
  };
  const status = (s) => String(s || "Listed");
  function selected() {
    return ux.selectEpisodes(state.episodes,{date:state.date,order:state.order,onlyUnwatched:state.onlyUnwatched},state.progress,"anupamaa");
  }
  function goLatest() {state.date="";state.order="newest";state.onlyUnwatched=false;state.page=1;render();}
  function chips() {
    const dates=ux.recentDates(state.episodes,12);
    $("dateChips").innerHTML=[{date:"",top:"All",bottom:"dates"}, ...dates.map(date=>{
      const label=ux.dateChipLabel(date);return {date,top:label.day,bottom:label.date};
    })].map(chip=>'<button type="button" class="date-chip" data-date="'+safe(chip.date)+'" aria-pressed="'+(state.date===chip.date)+'"><b>'+safe(chip.top)+'</b><span>'+safe(chip.bottom)+'</span></button>').join("");
  }
  function episodeRow(ep,index) {
    const key=ep.dateKey || "";
    const p=state.progress["anupamaa:"+key];
    const pct=p?.durationSeconds>0 ? (p.completed ? 100 : Math.max(0,Math.min(99,Math.round((p.positionSeconds/p.durationSeconds)*100)))):null;
    const progressText = p?.completed ? "Watched" : (pct!==null&&pct>0 ? pct+"% watched" : "Not started");
    const badge= key === state.episodes[0]?.dateKey ? '<span class="tag">Latest</span>' : "";
    const epNo=ep.episodeNumber ? "Episode "+safe(ep.episodeNumber) : "Episode";
    const buttonId="episode-"+index;
    return '<article class="episode-row" data-episode="'+safe(key)+'">'+
      '<div class="episode-art" aria-hidden="true"><span class="play-symbol">▷</span><small>APNE TV</small></div>'+
      '<div class="episode-info"><div class="episode-title"><strong>'+safe(displayDate(key))+'</strong>'+badge+'</div>'+
      '<div class="episode-sub">'+epNo+(ep.episodeTitle?" · "+safe(ep.episodeTitle):"")+'</div>'+
      '<div><span class="tag '+(["Saved","Available"].includes(status(ep.status))?"":"neutral")+'">'+safe(status(ep.status))+'</span></div>'+
      (state.progressAvailable?'<div class="progress-label">'+safe(progressText)+'</div>':'')+
      (pct!==null&&state.progressAvailable?'<div class="watch-track" role="progressbar" aria-label="Watched percentage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><i style="width:'+pct+'%"></i></div>':'')+
      '<div class="episode-actions"><button class="details-button" aria-expanded="false" aria-controls="'+buttonId+'" data-detail="'+safe(index)+'" type="button">Episode details</button></div>'+
      '<div class="row-details" id="'+buttonId+'" hidden><p>Source: '+safe(status(ep.status))+'</p><p>Air date: '+safe(displayDate(key))+'</p><p>Playback and downloads are disabled in Experimental so production data remains unchanged.</p></div>'+
      '</div></article>';
  }
  function render() {
    if(!state.loaded)return;
    const show=state.show;
    $("showStatus").textContent=status(show?.status)+" · Latest: "+(show?.episode?.dateKey?displayDate(show.episode.dateKey):"unknown");
    $("showStatus").classList.toggle("good",["Available","Saved"].includes(status(show?.status)));
    $("quickStart").hidden=!state.episodes.length;
    if(state.episodes.length) {
      const recent=state.episodes[0];
      $("latestDate").textContent=displayDate(recent.dateKey);
      $("latestMeta").textContent=recent.episodeNumber?"Episode "+recent.episodeNumber:"Most recent listing";
    }
    chips();
    $("episodeDate").value=state.date;
    $("episodeOrder").value=state.order;
    $("unwatched").setAttribute("aria-pressed",String(state.onlyUnwatched));
    $("unwatched").disabled=!state.progressAvailable;
    $("unwatched").title=state.progressAvailable?"Show only episodes not marked watched":"Watch status not available in preview";
    const matches=selected();
    const pages=Math.max(1,Math.ceil(matches.length/state.pageSize));
    state.page=Math.min(state.page,pages);
    const current=matches.slice((state.page-1)*state.pageSize,state.page*state.pageSize);
    $("resultCount").textContent=matches.length+" episode"+(matches.length===1?"":"s");
    $("rangeNotice").textContent=(show?.history?.months?"Last "+show.history.months+" months of listings":"Available APNE listings")+
      (state.date?" · "+displayDate(state.date):"")+
      (!state.progressAvailable?" · Watched filter unavailable":"");
    $("episodeList").innerHTML=current.length?current.map((ep,i)=>episodeRow(ep,(state.page-1)*state.pageSize+i)).join("") :
      '<div class="empty">No matching episodes in the available history. Choose another date or clear the filters.</div>';
    $("pager").hidden=pages<=1;
    $("newer").disabled=state.page<=1;
    $("older").disabled=state.page>=pages;
    $("pageInfo").textContent=state.page+" of "+pages;
  }
  async function load() {
    $("refresh").disabled=true;
    $("showStatus").textContent="Checking APNE episodes…";
    try {
      const result=await fetch("/api/apne-daily",{credentials:"same-origin",cache:"no-store"});
      if(!result.ok)throw new Error("Episode list unavailable ("+result.status+")");
      const data=await result.json();
      const show=(data.shows||[]).find(s=>s.id==="anupamaa");
      if(!show)throw new Error("Anupamaa not found in your APNE shows");
      state.show=show;
      state.episodes=Array.isArray(show.recentEpisodes)?[...show.recentEpisodes].sort((a,b)=>String(b.dateKey||"").localeCompare(String(a.dateKey||""))):[];
      state.loaded=true;
      try {
        const response=await fetch("/api/apne/progress",{credentials:"same-origin",cache:"no-store"});
        if(response.ok) {
          const history=await response.json();
          state.progress=Object.fromEntries((history.episodes||[]).filter(e=>e.showId==="anupamaa").map(e=>["anupamaa:"+e.dateKey,e]));
          state.progressAvailable=true;
        } else state.progressAvailable=false;
      }catch{state.progressAvailable=false;}
      if(!state.progressAvailable)state.onlyUnwatched=false;
      render();
    }catch(error) {
      $("showStatus").textContent=error.message;
      $("episodeList").innerHTML='<div class="empty">Could not load episodes. Check the stable APNE Daily page or try Refresh.</div>';
      $("resultCount").textContent="Unavailable";
    }finally{$("refresh").disabled=false;}
  }
  $("dateChips").addEventListener("click",(event)=>{
    const b=event.target.closest("[data-date]");if(!b)return;
    state.date=b.dataset.date||"";state.page=1;render();
  });
  $("episodeDate").addEventListener("change",(event)=>{
    state.date=/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)?event.target.value:"";state.page=1;render();
  });
  $("episodeOrder").addEventListener("change",(event)=>{state.order=event.target.value==="oldest"?"oldest":"newest";state.page=1;render();});
  $("unwatched").addEventListener("click",()=>{if(!state.progressAvailable)return;state.onlyUnwatched=!state.onlyUnwatched;state.page=1;render();});
  $("clearFilters").addEventListener("click",goLatest);
  $("latestButton").addEventListener("click",goLatest);
  $("refresh").addEventListener("click",load);
  $("newer").addEventListener("click",()=>{state.page--;render();});
  $("older").addEventListener("click",()=>{state.page++;render();});
  $("episodeList").addEventListener("click",(event)=>{
    const b=event.target.closest("[data-detail]");if(!b)return;
    const panel=$(b.getAttribute("aria-controls"));if(!panel)return;
    panel.hidden=!panel.hidden;b.setAttribute("aria-expanded",String(!panel.hidden));
  });
  load();
})();
