# TeslaMon puppy appearance — 2026-10-23

Replaces the abstract blue glyph face with an original inline vector golden puppy: floppy brown ears, cream muzzle and paws, expressive eyes, teal collar, and a gently wagging tail. The collar tag retains the existing success/warning colors. Artwork uses no external image/font service and is not presented as a public-domain Disney character.

The existing pet button still opens the same controls. The separate movement handle is now 44×44 CSS px; the puppy button is 88×88 px. Arrow keys on the handle move it 20 px (Shift: 4 px) and save its position. Reduced-motion preference disables the tail. Panel placement measures the pet height, and drag/panel bounds honor safe-area insets. Both public asset URLs were cache-busted.

## Verification

- `npm run check`: passed; `node --check public/teslamon-pet.js`: passed.
- Complete `npm test`: 566/566 passed.
- Capture/binding/local-player targeted regression after movement changes: 53/53 passed.
- Puppy responsive browser checks: 18/18 passed (both UI modes; 320, 375, 390, 430 px, iPad portrait/landscape, mobile landscape, desktop; keyboard/drag persistence, synthetic safe areas, reduced motion). Existing mobile-player checks: 10/10 passed.
- Responsive browser measurements and screenshots: `teslamon-puppy-evidence/`.
- Google Chrome automation uses isolated synthetic API/asset responses. This is layout and control verification, not real iPhone Safari, microphone, model, Home Assistant action, or media playback acceptance.
- Independent read-only review found safe-area and keyboard gaps; both were corrected and re-reviewed with no remaining material findings.

## Release and rollback

Source branch: `fix/teslamon-cute-puppy-20261023`, based on consolidated main `fd91756`.
Source-only change; no production runtime restarted or changed. Both-platform CI and release approval are required before promotion under repository policy. Current pet host gating remains unchanged. Follow the standard immutable release/backup workflow; revert this change commit for rollback. Physical iPhone Safari and parked Tesla visual/drag acceptance remain required after deployment.
