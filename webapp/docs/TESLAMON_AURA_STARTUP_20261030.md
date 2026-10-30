# TeslaMon Aura startup behavior — 2026-10-30

On each fresh document load, the pet module makes one synchronous Aura entry attempt after its UI and fullscreen monitoring are initialized. The saved Aura preference defaults to On. When it is On and TeslaMon is not master-disabled, the entry starts in a truthful preparing/standby state; it does not request microphone access, begin recording, or invoke playback.

The ordinary entry guards still apply. Aura is not opened while the document is hidden or while video is already playing, and a hidden load is not deferred until visibility returns. An active startup presentation can show later capability or voice-bootstrap status, including Mic Off or voice unavailable, without being reopened after dismissal. Closing it, disabling Aura/TeslaMon, hiding the document, page teardown, Preview Aura, or a wake-owned entry clears startup ownership. Existing wake-triggered microphone behavior is unchanged.

Cache marker: `teslamon-pet.js?v=20261030-aura-startup1`.
