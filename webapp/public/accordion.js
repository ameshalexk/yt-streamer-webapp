// Reuse the existing controls and views. Disclosure changes never touch media.
let watchAccordion = null;

function setWatchSection(key, { reveal = false } = {}) {
  if (!watchAccordion) return;
  const { rows } = watchAccordion;
  const previousOpen = watchAccordion.open;
  if (key) setPlayerDropdownOpen(true);
  for (const [name, row] of rows) {
    const open = name === key;
    if (!open && row.panel.contains(document.activeElement)) row.button.focus();
    row.button.setAttribute('aria-expanded', String(open));
    row.panel.hidden = !open;
    row.panel.inert = !open;
    row.panel.setAttribute('aria-hidden', String(!open));
  }
  watchAccordion.open = key;
  setPanelHidden($('#channelsView'), key !== 'browse');
  // Drawer state still supports existing close buttons, shortcuts and Escape.
  state.savedDrawerOpen = key === 'saved';
  state.downloadsDrawerOpen = key === 'downloads';
  for (const [name, id] of [['saved', '#playlistDrawer'], ['downloads', '#downloadsDrawer']]) {
    const drawer = $(id);
    drawer.inert = key !== name;
    drawer.setAttribute('aria-hidden', String(key !== name));
  }
  $('#savedDrawerBackdrop').hidden = true;
  $('#downloadsDrawerBackdrop').hidden = true;
  if (reveal && key && key !== previousOpen) {
    rows.get(key).button.scrollIntoView({ block: 'nearest' });
  }
}

function syncWatchMode(mode, previousMode) {
  if (!watchAccordion) return;
  // Watch/Browse keep video above the disclosures; auxiliary views retain
  // their existing player disclosure behavior until a section is opened.
  const accordionMode = mode === 'watch' || mode === 'browse';
  if (accordionMode) setPlayerDropdownOpen(true);
  $('#playerDropdownBtn').hidden = accordionMode;
  if (mode !== previousMode) {
    setWatchSection(mode === 'browse' ? 'browse' : null);
  }
  const browse = watchAccordion.rows.get('browse').panel;
  setPanelHidden($('#channelsView'), browse.hidden);
}

function initWatchAccordion() {
  const host = document.createElement('div');
  host.className = 'watch-accordion';
  host.setAttribute('aria-label', 'Watch sections');
  const rows = new Map();
  watchAccordion = { host, rows, open: null };
  $('#layout').classList.add('accordion-layout');
  $('#playerBody').append(host);
  // The screen and fullscreen overlay stay in their original DOM positions.
  for (const [key, label, nodes] of [
    ['playback', 'Playback controls', [$('.player-toolbar'), $('.quick')]],
    ['browse', 'Browse', [$('#channelsView')]],
    ['saved', 'Saved Channels', [$('#playlistDrawer')]],
    ['downloads', 'Downloads', [$('#downloadsDrawer')]],
    ['settings', 'Stream settings', [$('#streamSettingsPanel')]],
  ]) {
    const section = document.createElement('section');
    section.className = 'watch-section';
    const heading = document.createElement('h2');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'watch-section-toggle';
    button.id = `watch-${key}-toggle`;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `watch-${key}-panel`);
    const title = document.createElement('span');
    title.textContent = label;
    const summary = document.createElement('span');
    summary.className = 'watch-section-summary';
    button.append(title, summary);
    heading.append(button);
    const panel = document.createElement('div');
    panel.id = `watch-${key}-panel`;
    panel.className = 'watch-section-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', button.id);
    for (const node of nodes) { panel.append(node); node.hidden = false; }
    section.append(heading, panel);
    host.append(section);
    rows.set(key, { button, panel, summary });
    button.onclick = () => {
      if (watchAccordion.open === key) { setWatchSection(null); return; }
      setWatchSection(key);
      if (key === 'browse') openChannels();
      if (key === 'saved') {
        renderPlaylists(); renderItems();
      }
      if (key === 'downloads') {
        loadLegacyLibrary().catch((e) => toast(e.message, true));
      }
    };
  }
  // Put quick quality presets inside the disclosure; the whole header is tappable.
  rows.get('settings').panel.prepend($('#qualityQuick'));
  $('#streamSettings').hidden = true;
  $('#homeTiles').hidden = true;
  $('#playerDropdownBtn').hidden = true;
  // The old button remains a supported entry point for shortcuts.
  $('#streamSettingsBtn').onclick = () => setWatchSection(watchAccordion.open === 'settings' ? null : 'settings');
  $('#closeSavedDrawerBtn').onclick = () => setWatchSection(state.mode === 'browse' ? 'browse' : null);
  $('#closeDownloadsDrawerBtn').onclick = () => setWatchSection(null);
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && watchAccordion.open) {
      const button = rows.get(watchAccordion.open).button;
      setWatchSection(null); button.focus(); event.stopPropagation();
    }
  });
  function summaries() {
    const quality = $('#qualityQuick [aria-pressed="true"]')?.textContent?.trim() || 'Custom';
    const texts = {
      playback: $('#screen').classList.contains('playing') ? $('#nowPlaying').textContent : 'Paste a URL',
      browse: 'Search · History · Live channels',
      saved: `${state.playlists.length} playlist${state.playlists.length === 1 ? '' : 's'}`,
      downloads: $('#legacyList').children.length ? `${$('#legacyList').querySelectorAll('.legacy-item').length} items` : 'Downloaded videos',
      settings: quality,
    };
    for (const [key, row] of rows) {
      if (row.summary.textContent !== texts[key]) row.summary.textContent = texts[key];
    }
  }
  const observer = new MutationObserver(summaries);
  for (const node of [$('#qualityQuick'), $('#nowPlaying'), $('#screen'), $('#playlistList'), $('#legacyList')]) {
    observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  summaries();
  setWatchSection(null);
}
