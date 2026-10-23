# TeslaMon puppy appearance — 2026-10-23

Replaces the abstract blue glyph face with an original inline vector golden puppy: floppy brown ears, cream muzzle and paws, expressive eyes, teal collar, and a gently wagging tail. The collar tag retains the existing success/warning colors. Artwork uses no external image/font service and is not presented as a public-domain Disney character.

The existing pet button still opens the same controls. The separate movement handle is now 44×44 CSS px; the puppy button is 88×88 px. Arrow keys on the handle move it 20 px (Shift: 4 px) and save its position. Reduced-motion preference disables the tail. Panel placement measures the pet height, and drag/panel bounds honor safe-area insets. Both public asset URLs were cache-busted.

## Verification

- `npm run check`: passed; `node --check public/teslamon-pet.js`: passed.
- Complete integrated `npm test`: 569/569 passed (including Codex quota/service error regressions and the existing automatic top-result playback tests).
- Capture/binding/local-player targeted regression after movement changes: 53/53 passed.
- Puppy responsive browser checks: 18/18 passed (both UI modes; 320, 375, 390, 430 px, iPad portrait/landscape, mobile landscape, desktop; keyboard/drag persistence, synthetic safe areas, reduced motion). Existing mobile-player checks: 10/10 passed.
- Responsive browser measurements and screenshots: `teslamon-puppy-evidence/`.
- Google Chrome automation uses isolated synthetic API/asset responses. This is layout and control verification, not real iPhone Safari, microphone, model, Home Assistant action, or media playback acceptance.
- Independent read-only review found safe-area and keyboard gaps; both were corrected and re-reviewed with no remaining material findings.

## Release and rollback

Puppy source: `fix/teslamon-cute-puppy-20261023` at `87252f7`, integrated with the existing autoplay release (`b9ce60e`) in `fix/teslamon-puppy-usage-error-20261023`.

The integrated release also corrects a Codex CLI diagnostic mistake: Codex quota/rate-limit errors are now reported as an allowance issue with the retry time when available, not as an unsupported tool. Unauthorized tool events still fail closed. The existing PowerALX transcription worker and direct playback controls remain unchanged.

Source-only at the time of integration; both-platform CI and immutable Mac deployment are required before live verification. Retain the previous source package/rollback and live data. Physical iPhone Safari and parked Tesla visual/drag acceptance remain required after deployment.
