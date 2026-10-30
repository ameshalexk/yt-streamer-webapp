# Aura manual preview restored

The user requested a button to test Aura without saying a wake phrase. This
supersedes the removal of manual Preview in the October 29 completion fix.

- **Preview Aura** appears below the Aura On/Off switch, using its existing
  full-width, minimum 44 px button style. Aura Off disables the button.
- Tapping Preview opens the full-screen visual without starting a recording,
  requesting microphone permission, submitting a command or changing playback.
  It works with Mic Off and with a video already playing.
- The preview remains until tap/Escape dismissal or a later accepted wake takes
  ownership. It does not poll existing playback to immediately dismiss itself.
- Turning Aura On still only enables the feature. Accepted wakes still pause
  before capture, and task completion/media handoff still closes wake-owned Aura.
  Preview does not replace or weaken the invocation ownership checks.
- Pet module cache marker: `20261030-aura-preview1`.

Verification and release evidence are recorded in the canonical Obsidian project
note. Chrome mobile emulation is separate from real iPhone/Tesla acceptance.
