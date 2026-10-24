// Only confirmed playback and completed Home Assistant actions are fulfilled.
export function shouldAutoCollapseTeslaMonPanel({
  response, opened, requestRevision, panelRevision, hasDraft
} = {}) {
  return Boolean(opened &&
    requestRevision === panelRevision &&
    !hasDraft &&
    (response?.status === 'observed' || response?.status === 'ha_done'));
}
