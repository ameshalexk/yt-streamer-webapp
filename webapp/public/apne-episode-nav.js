// Previous/next episode links, built from the authenticated catalog.
(() => {
  'use strict';
  const nav = document.querySelector('#apneEpisodeNavigation');
  if (!nav) return;
  const showId = nav.dataset.showId;
  const dateKey = nav.dataset.dateKey;
  if (!/^[a-z0-9-]{1,90}$/.test(showId || '') ||
      !/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(dateKey || '')) return;
  const video = document.querySelector('video[data-progress-show]');
  function link(label, ep) {
    if (!ep || !/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(ep.dateKey)) return null;
    const a = document.createElement('a');
    a.href = '/apne/live/watch/' + encodeURIComponent(showId) + '/' + encodeURIComponent(ep.dateKey);
    a.textContent = label + (ep.episodeNumber ? ' · Episode ' + ep.episodeNumber : ' · ' + ep.dateKey.slice(0,10));
    return a;
  }
  async function loadNavigation() {
    try {
      const response = await fetch('/api/apne-daily', {credentials:'same-origin',cache:'no-store'});
      if (!response.ok) throw Error('Catalog unavailable');
      const data = await response.json();
      const show = (data.shows || []).find(item=>item.id===showId);
      if (!show) throw Error('Show unavailable');
      const compare = window.ApneMobileBrowser?.compareEpisodes;
      if (typeof compare !== 'function') throw Error('Episode index unavailable');
      const episodes = [...(show.recentEpisodes || [])].sort(compare);
      const index = episodes.findIndex(ep=>ep.dateKey===dateKey);
      nav.replaceChildren();
      if (index<0) { nav.textContent='Episode not in current catalog'; return; }
      const previous = link('← Previous episode', episodes[index-1]);
      const next = link('Next episode →', episodes[index+1]);
      if (previous) nav.append(previous);
      if (next) nav.append(next);
      if (!previous && !next) nav.textContent='No adjacent episodes indexed';
      if (video && next) {
        const banner = document.createElement('div');
        banner.id = 'apneNextEpisode';
        banner.hidden = true;
        banner.style.cssText='margin-top:12px;padding:12px;border:1px solid #526e8d;border-radius:9px;background:#19212e';
        const message = document.createElement('strong');
        message.textContent = 'Episode finished. ';
        banner.append(message, next.cloneNode(true));
        nav.insertAdjacentElement('afterend',banner);
        video.addEventListener('ended', () => { banner.hidden = false; });
      }
    } catch {
      nav.textContent='Episode navigation temporarily unavailable';
    }
  }
  void loadNavigation();
})();
