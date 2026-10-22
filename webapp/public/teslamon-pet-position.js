const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Compute safe, keyboard-visible coordinates in visual-viewport space. */
export function calculateTeslaMonPetPosition({
  viewport = {}, safeArea = {}, pet = {}, panel = {}, saved = null, reset = false,
} = {}) {
  const left = number(viewport.offsetLeft);
  const top = number(viewport.offsetTop);
  const width = Math.max(1, number(viewport.width));
  const height = Math.max(1, number(viewport.height));
  const safe = {
    left: Math.max(0, number(safeArea.left)),
    right: Math.max(0, number(safeArea.right)),
    top: Math.max(0, number(safeArea.top)),
    bottom: Math.max(0, number(safeArea.bottom)),
  };
  const petWidth = Math.min(Math.max(0, number(pet.width)), Math.max(0, width - safe.left - safe.right));
  const petHeight = Math.min(Math.max(0, number(pet.height)), Math.max(0, height - safe.top - safe.bottom));
  const maxLeft = left + width - safe.right - petWidth;
  const maxTop = top + height - safe.bottom - petHeight;
  const defaultLeft = maxLeft;
  const defaultTop = maxTop;
  const requestedLeft = !reset && Number.isFinite(saved?.x) ? number(saved.x) : defaultLeft;
  const requestedTop = !reset && Number.isFinite(saved?.y) ? number(saved.y) : defaultTop;
  const petLeft = clamp(requestedLeft, left + safe.left, maxLeft);
  const petTop = clamp(requestedTop, top + safe.top, maxTop);

  const gutterX = Math.min(8, Math.max(0, width - safe.left - safe.right) / 2);
  const gutterY = Math.min(8, Math.max(0, height - safe.top - safe.bottom) / 2);
  const visibleLeft = left + safe.left + gutterX;
  const visibleRight = left + width - safe.right - gutterX;
  const visibleTop = top + safe.top + gutterY;
  const visibleBottom = top + height - safe.bottom - gutterY;
  const panelWidth = Math.min(Math.max(0, number(panel.width)), visibleRight - visibleLeft);
  const panelHeight = Math.min(Math.max(0, number(panel.height)), visibleBottom - visibleTop);
  const panelLeft = clamp(petLeft + petWidth - panelWidth, visibleLeft, visibleRight - panelWidth);
  const gap = 10;
  let panelTop = petTop - panelHeight - gap;
  if (panelTop < visibleTop && visibleBottom - (petTop + petHeight) >= panelHeight + gap)
    panelTop = petTop + petHeight + gap;
  panelTop = clamp(panelTop, visibleTop, Math.max(visibleTop, visibleBottom - panelHeight));

  return {
    petLeft, petTop,
    panelLeft, panelTop,
    panelWidth,
    panelMaxHeight: Math.max(1, visibleBottom - panelTop),
    viewport: { left, top, right: left + width, bottom: top + height },
  };
}
