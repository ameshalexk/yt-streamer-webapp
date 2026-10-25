export const TESLAMON_WAKE_KEYWORDS = Object.freeze(['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy']);

const phraseLabels = Object.freeze({
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  hey_rhasspy: 'Hey Rhasspy',
});

export function normalizeTeslaMonWakeKeywords(value) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(keyword => !TESLAMON_WAKE_KEYWORDS.includes(keyword)) ||
      new Set(value).size !== value.length) return null;
  return TESLAMON_WAKE_KEYWORDS.filter(keyword => value.includes(keyword));
}

// Preserve existing browser selections while replacing retired Hey Luna with both new phrases.
export function restoreTeslaMonWakeKeywords(value) {
  if (!Array.isArray(value)) return null;
  const migrated = value.flatMap(keyword =>
    keyword === 'hey_luna' ? ['hey_mycroft', 'hey_rhasspy'] : [keyword]);
  return normalizeTeslaMonWakeKeywords(migrated);
}

export function teslaMonWakePhraseLabel(keyword) {
  return phraseLabels[keyword] || null;
}

// Strip only a recognized phrase at the beginning. A wake phrase alone has no
// command payload and must not be sent to the planner as a standalone command.
export function stripTeslaMonWakePhrasePrefix(transcript) {
  const text = String(transcript ?? '').trim();
  const match = text.match(/^(?:hey\s+jarvis|alexa|hey\s+mycroft|hey\s+rhasspy)(?=$|[\s,.!?;:—-])/i);
  if (!match) return text;
  const remainder = text.slice(match[0].length).replace(/^[\s,.!?;:—-]+/, '').trim();
  return remainder;
}
