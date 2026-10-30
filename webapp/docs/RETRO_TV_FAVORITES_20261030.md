# Retro TV — family favorites (2026-10-30)

Requested favorites for the existing `/retrotv` page:

- **43 — Family matinee** (`family-matinee`)
- **33 — Chaplin, two reels at a time** (`chaplin-two-reelers`)
- **34 — The stunts nobody would insure** (Buster Keaton; `buster-keaton-in-an-evening`)

All three are seeded into **Favorites** at the top of the guide for new browsers. The guide displays a separate star button for each channel; clicking it toggles the favorite without tuning or interrupting current playback. Favorites persist through browser refresh via `localStorage` key `ytstreamer:retrotv:favorites:v1`. Deliberately clearing favorites saves an empty selection rather than repopulating defaults. Browser-specific changes are **not synced** between Tesla, iPhone, Mac, and StreamHA; first-visit defaults are identical on each. Playback and source APIs remain unchanged.

Tested: 4 new Node tests (seed, persistence, malformed storage, grouping), full npm check/test and mobile responsive regression, local real guide browser star/unstar/reload test. Current release revision and deployment verification should be added to the Obsidian project handoff after promotion.
