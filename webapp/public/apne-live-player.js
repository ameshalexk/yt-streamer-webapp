// Browser-native APNE playback. Resolve only via the authenticated first-party API.
// Bounded retry + visible failures prevent indefinite "Connecting to APNE" states.
(async () => {
  'use strict';
  const video = document.querySelector('#apneLiveVideo');
  const status = document.querySelector('#apneLiveStatus');
  if (!video || !status) return;

  const SOURCE_TIMEOUT_MS = 18000;
  const STARTUP_TIMEOUT_MS = 22000;
  const STALL_TIMEOUT_MS = 20000;
  const MAX_AUTO_RETRIES = 1;
  let attempt = 0;
  let requestId = 0;
  let sourceController = null;
  let startupTimer = null;
  let stallTimer = null;
  let activeFormat = null;
  let sourceLoading = false;
  let playingBeforeRetry = false;
  let seekAfterRetry = null;
  let embedded = false;

  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = 'Retry video';
  retryButton.hidden = true;
  retryButton.style.cssText = 'display:inline-block;margin:8px 0 0;padding:9px 15px;border-radius:8px;border:1px solid #7192b7;background:#273b55;color:white;cursor:pointer';
  status.insertAdjacentElement('afterend', retryButton);

  function setStatus(message, allowRetry = false) {
    status.textContent = message;
    retryButton.hidden = !allowRetry;
    retryButton.style.display = allowRetry ? 'inline-block' : 'none';
  }
  function clearTimers() {
    clearTimeout(startupTimer);
    clearTimeout(stallTimer);
    startupTimer = null;
    stallTimer = null;
  }
  function startStallTimer() {
    if (embedded || sourceLoading || video.paused || video.ended || stallTimer) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!video.paused && !video.ended && video.readyState < 3) recover('Playback stalled. The video source stopped sending data.');
    }, STALL_TIMEOUT_MS);
  }
  function startStartupTimer() {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (!embedded && video.readyState < 2) recover('The video is taking too long to load.');
    }, STARTUP_TIMEOUT_MS);
  }
  function recover(reason, terminal = false) {
    if (embedded || sourceLoading) return;
    clearTimers();
    if (!terminal && attempt <= MAX_AUTO_RETRIES) {
      setStatus(reason + ' Trying the source again…');
      void loadSource();
    } else {
      setStatus(reason + ' Tap Retry video to try again.', true);
    }
  }
  function validEmbedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'www.blogger.com' && url.pathname === '/video.g' &&
        /^[A-Za-z0-9_-]{50,400}$/.test(url.searchParams.get('token') || '') &&
        [...url.searchParams.keys()].every(x => x === 'token' || x === 'autoplay');
    } catch { return false; }
  }
  function showEmbed(source) {
    video.hidden = true;
    embedded = true;
    window.dispatchEvent(new Event('apne:embed'));
    const stage = document.querySelector('#apneEmbedStage');
    const controls = document.querySelector('#apnePartButtons');
    if (!stage || !controls) return setStatus('This player cannot show the episode.', true);
    stage.hidden = false;
    controls.hidden = false;
    const buttons = [];
    function selectPart(index) {
      const frame = document.createElement('iframe');
      frame.title = 'Episode — Part ' + (index + 1);
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      frame.setAttribute('allowfullscreen', '');
      frame.src = source.parts[index];
      stage.replaceChildren(frame);
      buttons.forEach((b, n) => b.setAttribute('aria-pressed', n === index ? 'true' : 'false'));
      setStatus('Part ' + (index + 1) + ' of ' + source.parts.length + ' — tap the video to play.');
    }
    controls.replaceChildren();
    for (let i = 0; i < source.parts.length; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Part ' + (i + 1);
      button.addEventListener('click', () => selectPart(i));
      controls.appendChild(button);
      buttons.push(button);
    }
    selectPart(0);
  }

  async function loadSource() {
    clearTimers();
    if (sourceController) sourceController.abort();
    sourceController = new AbortController();
    const id = ++requestId;
    ++attempt;
    sourceLoading = true;
    if (!embedded) {
      playingBeforeRetry = !video.paused && !video.ended && attempt > 1;
      seekAfterRetry = attempt > 1 && Number.isFinite(video.currentTime) && video.currentTime > 1 ? video.currentTime : null;
      video.removeAttribute('src');
      video.load();
    }
    setStatus(attempt > 1 ? 'Reconnecting to APNE…' : 'Connecting to APNE…');
    const controller = sourceController;
    const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    let source;
    try {
      const response = await fetch(video.dataset.source, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
          ? 'Cloudflare Access sign-in may have expired. Refresh this page after signing in.'
          : response.status === 404 ? 'This episode was not found.' : 'The APNE video source is temporarily unavailable.');
        error.terminal = response.status === 401 || response.status === 403 || response.status === 404;
        throw error;
      }
      source = await response.json();
      if (source?.format === 'embed') {
        if (!Array.isArray(source.parts) || ![1, 2, 3, 4].includes(source.parts.length) || !source.parts.every(validEmbedUrl))
          throw Object.assign(new Error('Unsupported embedded video response.'), {terminal: true});
      } else if (!source?.src?.startsWith('/apne/live/') || !['hls', 'mp4'].includes(source.format)) {
        throw Object.assign(new Error('Unsupported video response.'), {terminal: true});
      }
    } catch (error) {
      if (id !== requestId) return;
      sourceLoading = false;
      const reason = error.name === 'AbortError'
        ? 'The APNE source request timed out.'
        : error.message || 'Could not connect to APNE.';
      return recover(reason, Boolean(error.terminal));
    } finally {
      clearTimeout(timeout);
    }
    if (id !== requestId) return;
    sourceLoading = false;
    activeFormat = source.format;
    if (source.format === 'embed') return showEmbed(source);

    setStatus((source.format === 'mp4' ? 'MP4' : 'HLS') + ' source found. Loading video…');
    startStartupTimer();
    if (source.format === 'mp4' || video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) {
      video.src = source.src;
      video.load();
      return;
    }
    const attachHls = () => {
      if (id !== requestId) return;
      if (!window.Hls?.isSupported()) return recover('This browser cannot play the HLS source.', true);
      const hls = new window.Hls({maxBufferLength: 30, maxMaxBufferLength: 60, enableWorker: true});
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (id === requestId && data?.fatal) { hls.destroy(); recover('The HLS stream failed.'); }
      });
      hls.loadSource(source.src);
      hls.attachMedia(video);
    };
    if (window.Hls) return attachHls();
    const library = document.createElement('script');
    library.src = '/vendor/hls.min.js';
    library.onload = attachHls;
    library.onerror = () => { if (id === requestId) recover('Could not load the HLS player.'); };
    document.head.appendChild(library);
  }

  retryButton.addEventListener('click', () => {
    attempt = 0;
    void loadSource();
  });
  video.addEventListener('loadedmetadata', () => {
    if (embedded) return;
    clearTimeout(startupTimer);
    startupTimer = null;
    if (seekAfterRetry !== null && video.seekable?.length) {
      try {
        const end = video.seekable.end(video.seekable.length - 1);
        video.currentTime = Math.min(seekAfterRetry, Math.max(0, end - 1));
      } catch { /* Keep video usable if Safari cannot seek yet. */ }
      seekAfterRetry = null;
    }
    setStatus('Ready. Use the player controls to watch or seek.');
    if (playingBeforeRetry) {
      playingBeforeRetry = false;
      video.play().catch(() => setStatus('Ready. Tap Play to continue watching.'));
    }
  });
  video.addEventListener('canplay', () => {
    clearTimeout(startupTimer);
    startupTimer = null;
    clearTimeout(stallTimer);
    stallTimer = null;
  });
  video.addEventListener('playing', () => {
    clearTimers();
    setStatus('Playing.');
  });
  video.addEventListener('waiting', () => {
    if (!embedded && !sourceLoading) {
      setStatus('Buffering ' + (activeFormat === 'mp4' ? 'MP4' : 'video') + '…');
      startStallTimer();
    }
  });
  video.addEventListener('stalled', () => {
    if (!embedded && !sourceLoading) {
      setStatus('Waiting for the video stream…');
      startStallTimer();
    }
  });
  video.addEventListener('pause', () => {
    clearTimeout(stallTimer);
    stallTimer = null;
  });
  video.addEventListener('error', () => {
    if (!embedded && !sourceLoading && activeFormat) {
      const code = video.error?.code;
      recover(code === 4 ? 'Safari could not play this video format.' : 'The video could not load.');
    }
  });
  void loadSource();
})();
