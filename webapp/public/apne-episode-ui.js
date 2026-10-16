// Episode page controls: explicit provider choice and independently polled Mac download.
(() => {
  'use strict';
  const panel = document.querySelector('#apneEpisodeControls');
  if (!panel) return;
  const showId = panel.dataset.showId;
  const dateKey = panel.dataset.dateKey;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(showId || '') || !/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(dateKey || '')) return;
  const base = '/api/apne/episode/' + encodeURIComponent(showId) + '/' + encodeURIComponent(dateKey);
  const video = document.querySelector('#apneLiveVideo');
  const qualityNote = document.querySelector('#apneSourceQuality');
  const statusText = document.querySelector('#apneDownloadState');
  const downloadButton = document.querySelector('#apneDownloadMac');
  const macButton = document.querySelector('#apneStreamMac');
  const buttons = [...panel.querySelectorAll('[data-apne-provider]')];
  if (!video || !qualityNote || !statusText || !downloadButton || !macButton) return;
  let selectedProvider = 'apne';
  let savedId = null;
  let pollTimer = null;
  let active = true;

  async function json(url, options = {}) {
    const response = await fetch(url, {credentials:'same-origin',cache:'no-store',...options});
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw Error('Sign in to YT Streamer again, then refresh.');
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Request failed (HTTP ' + response.status + ')');
    return body;
  }
  function setDownloadState(download) {
    const status = download?.status || 'Not downloaded';
    savedId = download?.itemId || null;
    const isSaved = Boolean(savedId);
    const busy = ['Checking','Downloading','Saving to iCloud'].includes(status);
    downloadButton.hidden = isSaved;
    macButton.hidden = !isSaved;
    downloadButton.disabled = busy;
    downloadButton.dataset.status = busy ? 'downloading' : 'ready';
    downloadButton.textContent = busy ? (status === 'Checking' ? 'Checking…' :
      status === 'Saving to iCloud' ? 'Saving to iCloud…' : 'Downloading to Mac…') :
      status === 'Failed' ? 'Retry Download to Mac' : 'Download to Mac';
    statusText.textContent = isSaved ? 'Downloaded • Ready to stream from Mac' :
      busy ? (download?.detail || status + '…') :
      status === 'Failed' ? ('Download failed: ' + (download?.error || download?.detail || 'Try again')) :
      'Not downloaded. The Mac copy is saved to the local library and then mirrored to iCloud.';
    downloadButton.setAttribute('aria-label', downloadButton.textContent);
  }
  function selectSource(provider) {
    if (!['apne','yodesi'].includes(provider) || provider === selectedProvider) return;
    selectedProvider = provider;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.apneProvider === provider));
    qualityNote.textContent = provider === 'yodesi'
      ? 'YoDesi • embedded source. Resolution cannot be verified as 720p. YoDesi download is unsupported; Download to Mac uses APNE.'
      : 'APNE / PlayApne • highest offered source, never an automatic low-quality downgrade. Resolution depends on the episode.';
    video.dataset.source = '/apne/live/source/' + encodeURIComponent(showId) + '/' + encodeURIComponent(dateKey)
      + '?provider=' + encodeURIComponent(provider);
    window.dispatchEvent(new Event('apne:source-change'));
  }
  async function refresh() {
    try {
      const state = await json(base);
      const offered = new Set((state.sources || []).map(source => source.id));
      for (const button of buttons) {
        button.hidden = !offered.has(button.dataset.apneProvider);
      }
      if (!offered.has(selectedProvider)) selectSource('apne');
      setDownloadState(state.download);
      return state;
    } catch (error) {
      statusText.textContent = error.message || 'Could not check download status.';
      return null;
    }
  }
  function beginPolling() {
    clearTimeout(pollTimer);
    const tick = async () => {
      if (!active) return;
      if (!document.hidden) await refresh();
      pollTimer = setTimeout(tick, 6000);
    };
    void tick();
  }

  for (const button of buttons) {
    button.addEventListener('click', () => selectSource(button.dataset.apneProvider));
  }
  downloadButton.addEventListener('click', async () => {
    if (downloadButton.disabled) return;
    downloadButton.disabled = true;
    downloadButton.dataset.status = 'downloading';
    downloadButton.textContent = 'Starting download…';
    statusText.textContent = 'Starting APNE download on Mac…';
    try {
      const job = await json(base + '/download', {
        method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
      });
      setDownloadState(job);
      // Background job is tracked by show + episode date.
      beginPolling();
    } catch (error) {
      setDownloadState({status:'Failed',error:error.message});
    }
  });
  macButton.addEventListener('click', () => {
    if (!savedId) return;
    window.location.assign('/apne/watch/' + encodeURIComponent(savedId) +
      (new URLSearchParams(location.search).get('resume') === '1' ? '?resume=1' : ''));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('pagehide', () => { active = false; clearTimeout(pollTimer); });
  beginPolling();
})();
