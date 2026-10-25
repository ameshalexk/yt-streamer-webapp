export const TESLAMON_WAKE_KEYWORDS = Object.freeze(['hey_jarvis', 'hey_luna', 'alexa']);

const phraseLabels = Object.freeze({
  hey_jarvis: 'Hey Jarvis',
  hey_luna: 'Hey Luna',
  alexa: 'Alexa',
});

export function normalizeTeslaMonWakeKeywords(value) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(keyword => !TESLAMON_WAKE_KEYWORDS.includes(keyword)) ||
      new Set(value).size !== value.length) return null;
  return TESLAMON_WAKE_KEYWORDS.filter(keyword => value.includes(keyword));
}

export function teslaMonWakePhraseLabel(keyword) {
  return phraseLabels[keyword] || null;
}

// Strip only a recognized phrase at the beginning. A wake phrase alone has no
// command payload and must not be sent to the planner as a standalone command.
export function stripTeslaMonWakePhrasePrefix(transcript) {
  const text = String(transcript ?? '').trim();
  const match = text.match(/^(?:hey\s+jarvis|hey\s+luna|alexa)(?=$|[\s,.!?;:—-])/i);
  if (!match) return text;
  const remainder = text.slice(match[0].length).replace(/^[\s,.!?;:—-]+/, '').trim();
  return remainder;
}
