(function (root) {
  'use strict';
  function init({ container, fetcher = root.fetch.bind(root) }) {
    const host = document.querySelector(container);
    if (!host) return;
    const details = document.createElement('details');
    details.className = 'everyday-storage';
    const heading = document.createElement('summary'); heading.textContent = 'YouTube playback health';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const check = document.createElement('button'); check.type = 'button'; check.className = 'btn secondary'; check.textContent = 'Check YouTube tools';
    const test = document.createElement('button'); test.type = 'button'; test.className = 'btn ghost'; test.textContent = 'Test playback readiness';
    const note = document.createElement('p'); note.textContent = 'Tests a short public YouTube sample. Updates are tested separately; this check does not install or change tools.';
    details.append(heading, status, check, test, note); host.append(details);
    async function run(playback) {
      check.disabled = test.disabled = true;
      status.textContent = playback ? 'Testing YouTube playback extraction…' : 'Checking installed tools…';
      try {
        const response = await fetcher('/api/youtube/extractor/' + (playback ? 'test' : 'status'), { method: playback ? 'POST' : 'GET' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Check failed');
        status.textContent = (data.candidates || []).map((item, index) => `${index ? 'Backup' : 'Primary'}: ${playback ? (item.ok ? 'playback extraction passed' : 'playback extraction failed') : (item.available ? 'available · ' + item.version : 'unavailable')}`).join(' · ')
          || 'No tools configured';
      } catch (error) { status.textContent = error.message; }
      finally { check.disabled = test.disabled = false; }
    }
    check.addEventListener('click', () => { void run(false); });
    test.addEventListener('click', () => { void run(true); });
  }
  root.ExtractorControls = { init };
})(window);
