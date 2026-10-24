export const TRICKS = Object.freeze(['jump', 'roll', 'sit', 'spin']);

// Match complete normalized words so commands can appear naturally inside a
// longer utterance without matching substrings such as "jumping" or "sitting".
const COMMANDS = Object.freeze([
  ['jump', 'jump'],
  ['hop', 'jump'],
  ['leap', 'jump'],
  ['roll', 'roll'],
  ['rollover', 'roll'],
  ['sit', 'sit'],
  ['spin', 'spin'],
  ['turn around', 'spin']
]);

export function normalizeCommand(input = '') {
  return String(input)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function matchTrick(input = '') {
  const phrase = normalizeCommand(input);
  if (!phrase) return null;

  // Pick the earliest supported command in spoken order. This deliberately
  // means one clip triggers one trick, even if a child says several commands.
  let first = null;
  for (const [words, trick] of COMMANDS) {
    const index = phrase.search(new RegExp(`(?:^| )${words.replace(' ', ' ')}(?:$| )`));
    if (index < 0) continue;
    const wordIndex = phrase.slice(0, index).trim().length;
    if (!first || wordIndex < first.index) first = { index: wordIndex, trick };
  }
  return first?.trick ?? null;
}
